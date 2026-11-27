/**
 * An update through the real action path, with a schedule in the plugin. A skill inserted above an unedited schedule
 * changes nothing about the schedule: its key and plan entry stay the same, and its row is the same row afterwards,
 * not a deleted and recreated one.
 */
import { lunoraTest } from "@lunora/testing";
import { LunoraError } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import { schemaWithShardedTables } from "../lib/test-schema";
import { buildBundleMarkdown } from "../skills/bundle-format";
import { withPluginHeader } from "./export";
import { bodyHash } from "./logic";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

// The route table is `.global()` (D1), which the harness cannot store; routing is not under test here.
vi.mock("../lib/shard-routes", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-routes")>()),
        deleteShardRoute: async () => undefined,
        setShardRoute: async () => undefined,
    };
});

const sessionFrom = vi.hoisted(() => async (context: { auth: { userId?: string | null } }) => {
    const { userId } = context.auth;

    return userId ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, plan: "premium", userId } : null;
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
        getSessionUserWithAnonymous: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

const MODULES = {
    lib_claim_once: async () => await import("../lib/claim-once"),
    plugins_install_action: async () => await import("./install-action"),
    plugins_install_steps: async () => await import("./install-steps"),
    plugins_update: async () => await import("./update"),
    plugins_update_apply: async () => await import("./update-apply"),
    skills_bundle: async () => await import("../skills/bundle"),
    skills_create_skill: async () => await import("../skills/create-skill"),
    triggers_functions: async () => await import("../triggers/functions"),
} as const;

beforeAll(async () => {
    for (const [module, load] of Object.entries(MODULES)) {
        const exports = await load();

        for (const [name, value] of Object.entries(exports)) {
            registry.set(`${module}:${name}`, value);
        }
    }
}, 60_000);

const procedureAt = (module: keyof typeof MODULES, name: string): never => {
    const procedure = registry.get(`${module}:${name}`);

    if (!procedure) {
        throw new Error(`update-trigger-action.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

type PreviewResult = { generation: number; installId: string; plan: { action: string; entryKey: string }[] };
type UpdateResult = { applied: string[]; skipped: { action: string; entryKey: string }[]; version: string };

const OWNER = "owner-a";
const SLUG = "daily-brief";
const DIGEST = { cronExpression: "0 9 * * 1", model: "anthropic/claude-sonnet-4.6", name: "Weekly digest", type: "schedule" as const };

const skill = (slug: string) => {
    return { description: `${slug} skill`, instructions: `Be the ${slug}.`, name: slug, slug };
};

/** A plugin file with one skill per slug, then the schedule, at `version`. The header carries the hash of the body. */
const fileOf = async (slugs: string[], version: string) => {
    const skills = slugs.map((slug) => {
        return { key: slug, kind: "skill" as const, skill: skill(slug) };
    });
    const body = buildBundleMarkdown({
        description: "",
        items: [...skills, { key: "digest", kind: "trigger" as const, trigger: DIGEST }],
        name: "Daily brief",
    });
    const contentHash = await bodyHash(body);

    return { contentHash, markdown: withPluginHeader(body, { contentHash, slug: SLUG, version }) };
};

describe("a schedule below an inserted skill, through the action path", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);

        const first = await fileOf(["analyst"], "1.0.0");

        await harness.withIdentity({ userId: OWNER } as never).action(procedureAt("plugins_install_action", "installPlugin"), {
            contentHash: first.contentHash,
            markdown: first.markdown,
        } as never);
    });

    afterEach(() => {
        harness.close();
    });

    const as = () => harness.withIdentity({ userId: OWNER } as never);
    const run = async <T>(callback: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await callback(context));
    const schedules = async () => {
        const { page } = await run(async (context) => await context.db.triggers.findMany({ where: { userId: OWNER } }));

        return page;
    };

    it("the preview marks the schedule unchanged, and the update keeps the same schedule row", async () => {
        const before = await schedules();

        expect(before).toHaveLength(1);

        const next = await fileOf(["critic", "analyst"], "1.1.0");
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;

        expect(preview.plan).toContainEqual({ action: "same", entryKey: "trigger:digest" });

        const result = (await as().action(procedureAt("plugins_update", "updatePlugin"), {
            confirmDowngrade: false,
            contentHash: next.contentHash,
            expectedGeneration: 1,
            expectedInstallId: preview.installId,
            markdown: next.markdown,
        } as never)) as UpdateResult;

        expect(result.skipped).toStrictEqual([]);
        expect(result.applied).toContain("skill:critic");
        expect(result.applied).not.toContain("trigger:digest");

        const after = await schedules();

        expect(after.map((row: { _id: string }) => row._id)).toStrictEqual(before.map((row: { _id: string }) => row._id));
        expect(after[0]).toMatchObject({ cronExpression: DIGEST.cronExpression, enabled: before[0].enabled, name: DIGEST.name });
    });

    it("returns the secret of a webhook that the update adds under a new key", async () => {
        const body = buildBundleMarkdown({
            description: "",
            items: [
                { key: "analyst", kind: "skill" as const, skill: skill("analyst") },
                { key: "digest", kind: "trigger" as const, trigger: DIGEST },
                { key: "hook", kind: "trigger" as const, trigger: { model: DIGEST.model, name: "New hook", type: "webhook" as const } },
            ],
            name: "Daily brief",
        });
        const contentHash = await bodyHash(body);
        const markdown = withPluginHeader(body, { contentHash, slug: SLUG, version: "1.1.0" });
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown } as never)) as PreviewResult;
        const result = (await as().action(procedureAt("plugins_update", "updatePlugin"), {
            confirmDowngrade: false,
            contentHash,
            expectedGeneration: preview.generation,
            expectedInstallId: preview.installId,
            markdown,
        } as never)) as UpdateResult & { webhookSecrets: { entryKey: string; secret: string }[] };

        expect(result.applied).toContain("trigger:hook");
        expect(result.webhookSecrets).toHaveLength(1);
        expect(result.webhookSecrets[0]).toMatchObject({ entryKey: "trigger:hook" });
    });

    it("rewrites a changed schedule in place, and a schedule that becomes a webhook is replaced and returns its secret once", async () => {
        const before = await schedules();
        const changed = buildBundleMarkdown({
            description: "",
            items: [
                { key: "analyst", kind: "skill" as const, skill: skill("analyst") },
                { key: "digest", kind: "trigger" as const, trigger: { ...DIGEST, cronExpression: "0 10 * * 1" } },
            ],
            name: "Daily brief",
        });
        const changedHash = await bodyHash(changed);
        const asWebhook = buildBundleMarkdown({
            description: "",
            items: [
                { key: "analyst", kind: "skill" as const, skill: skill("analyst") },
                { key: "digest", kind: "trigger" as const, trigger: { model: DIGEST.model, name: "Digest hook", type: "webhook" as const } },
            ],
            name: "Daily brief",
        });
        const hookHash = await bodyHash(asWebhook);
        const steps = [
            { contentHash: changedHash, markdown: withPluginHeader(changed, { contentHash: changedHash, slug: SLUG, version: "1.1.0" }) },
            { contentHash: hookHash, markdown: withPluginHeader(asWebhook, { contentHash: hookHash, slug: SLUG, version: "1.2.0" }) },
        ];
        const apply = async (next: { contentHash: string; markdown: string }) => {
            const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;
            const result = (await as().action(procedureAt("plugins_update", "updatePlugin"), {
                confirmDowngrade: false,
                contentHash: next.contentHash,
                expectedGeneration: preview.generation,
                expectedInstallId: preview.installId,
                markdown: next.markdown,
            } as never)) as UpdateResult & { webhookSecrets: { entryKey: string; secret: string }[] };
            const again = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;

            return { again, result };
        };

        const first = await apply(steps[0]!);
        const rewritten = await schedules();

        expect(first.result.webhookSecrets).toStrictEqual([]);
        expect(rewritten).toHaveLength(1);
        expect(rewritten[0]).toMatchObject({ _id: before[0]._id, cronExpression: "0 10 * * 1", enabled: false });
        expect(first.again.plan).toContainEqual({ action: "same", entryKey: "trigger:digest" });

        const second = await apply(steps[1]!);
        const replaced = await schedules();

        expect(second.result.webhookSecrets).toHaveLength(1);
        expect(second.result.webhookSecrets[0]).toMatchObject({ entryKey: "trigger:digest" });
        expect(typeof second.result.webhookSecrets[0]?.secret).toBe("string");
        expect(replaced).toHaveLength(1);
        expect(replaced[0]).toMatchObject({ enabled: false, name: "Digest hook", type: "webhook" });
        expect(replaced[0]._id).not.toBe(before[0]._id);
        expect(second.again.plan).toContainEqual({ action: "same", entryKey: "trigger:digest" });
    });
});

describe("a changed webhook trigger", () => {
    let harness: ReturnType<typeof lunoraTest>;

    const HOOK = { model: DIGEST.model, name: "Hook", type: "webhook" as const };
    const hookFile = async (name: string, version: string) => {
        const body = buildBundleMarkdown({
            description: "",
            items: [
                { key: "analyst", kind: "skill" as const, skill: skill("analyst") },
                { key: "hook", kind: "trigger" as const, trigger: { ...HOOK, name } },
            ],
            name: "Daily brief",
        });
        const contentHash = await bodyHash(body);

        return { contentHash, markdown: withPluginHeader(body, { contentHash, slug: SLUG, version }) };
    };

    beforeEach(async () => {
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);

        const first = await hookFile("Hook", "1.0.0");

        await harness.withIdentity({ userId: OWNER } as never).action(procedureAt("plugins_install_action", "installPlugin"), {
            contentHash: first.contentHash,
            markdown: first.markdown,
        } as never);
    });

    afterEach(() => {
        harness.close();
    });

    const as = () => harness.withIdentity({ userId: OWNER } as never);
    const run = async <T>(callback: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await callback(context));
    const hooks = async () => {
        const { page } = await run(async (context) => await context.db.triggers.findMany({ where: { userId: OWNER } }));

        return page as any[];
    };
    const apply = async (next: {
        contentHash: string;
        markdown: string;
    }): Promise<UpdateResult & { webhookSecrets: { entryKey: string; secret: string }[] }> => {
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;

        return (await as().action(procedureAt("plugins_update", "updatePlugin"), {
            confirmDowngrade: false,
            contentHash: next.contentHash,
            expectedGeneration: preview.generation,
            expectedInstallId: preview.installId,
            markdown: next.markdown,
        } as never)) as never;
    };
    const previewOf = async (next: { markdown: string }) =>
        (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;

    it("is rewritten in place: same row, secret kept, switched off, and the next preview plans it unchanged", async () => {
        const [before] = await hooks();
        const next = await hookFile("Renamed hook", "1.1.0");
        const result = await apply(next);
        const after = await hooks();

        expect(result.applied).toContain("trigger:hook");
        expect(result.skipped).toStrictEqual([]);
        expect(result.webhookSecrets).toStrictEqual([]);
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ _id: before._id, enabled: false, name: "Renamed hook", webhookSecret: before.webhookSecret });
        const { plan } = await previewOf(next);

        expect(plan).toContainEqual({ action: "same", entryKey: "trigger:hook" });

        const { page } = await run(async (context) => await context.db.pluginInstalls.findMany({ where: { userId: OWNER } }));

        expect(page[0]).toMatchObject({ status: "installed", version: "1.1.0" });
    });

    it("is kept as edited when the person changed it", async () => {
        const [before] = await hooks();

        await run(async (context) => await context.db.patch("triggers", before._id, { description: "Mine." }));

        const next = await hookFile("Renamed hook", "1.1.0");

        const { plan } = await previewOf(next);

        expect(plan).toContainEqual({ action: "keep-edited", entryKey: "trigger:hook" });

        const result = await apply(next);
        const [after] = await hooks();

        expect(result.skipped).toContainEqual({ action: "keep-edited", entryKey: "trigger:hook" });
        expect(after).toMatchObject({ _id: before._id, description: "Mine.", name: "Hook" });
    });

    it("becomes a new row when the stored webhook becomes a schedule under the same key, and the next preview plans it unchanged", async () => {
        const [before] = await hooks();
        const body = buildBundleMarkdown({
            description: "",
            items: [
                { key: "analyst", kind: "skill" as const, skill: skill("analyst") },
                {
                    key: "hook",
                    kind: "trigger" as const,
                    trigger: { cronExpression: "0 9 * * 1", model: DIGEST.model, name: "Hook", type: "schedule" as const },
                },
            ],
            name: "Daily brief",
        });
        const contentHash = await bodyHash(body);
        const next = { contentHash, markdown: withPluginHeader(body, { contentHash, slug: SLUG, version: "1.1.0" }) };
        const result = await apply(next);
        const after = await hooks();

        expect(result.applied).toContain("trigger:hook");
        expect(result.webhookSecrets).toStrictEqual([]);
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ cronExpression: "0 9 * * 1", enabled: false, type: "schedule" });
        expect(after[0]._id).not.toBe(before._id);
        const { plan } = await previewOf(next);

        expect(plan).toContainEqual({ action: "same", entryKey: "trigger:hook" });
    });
});

describe("a changed trigger that cannot be planned", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);

        const first = await fileOf(["analyst"], "1.0.0");

        await harness.withIdentity({ userId: OWNER } as never).action(procedureAt("plugins_install_action", "installPlugin"), {
            contentHash: first.contentHash,
            markdown: first.markdown,
        } as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("is refused before anything is written, naming the problem", async () => {
        const as = () => harness.withIdentity({ userId: OWNER } as never);
        const body = buildBundleMarkdown({
            description: "",
            items: [
                { key: "analyst", kind: "skill" as const, skill: skill("analyst") },
                { key: "digest", kind: "trigger" as const, trigger: { ...DIGEST, model: "no-such-model" } },
            ],
            name: "Daily brief",
        });
        const contentHash = await bodyHash(body);
        const markdown = withPluginHeader(body, { contentHash, slug: SLUG, version: "1.1.0" });
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown } as never)) as PreviewResult;

        await expect(
            as().action(procedureAt("plugins_update", "updatePlugin"), {
                confirmDowngrade: false,
                contentHash,
                expectedGeneration: preview.generation,
                expectedInstallId: preview.installId,
                markdown,
            } as never),
        ).rejects.toThrow("not available");

        const { page } = await harness.run(async (context: any) => await context.db.pluginInstalls.findMany({ where: { userId: OWNER } }));

        expect(page[0]).toMatchObject({ status: "installed", version: "1.0.0" });
    });
});

describe("a webhook secret when a later step fails", () => {
    let harness: ReturnType<typeof lunoraTest>;

    const file = async (hookScheme: "native" | "timestamped", version: string, digest: typeof DIGEST = DIGEST) => {
        const body = buildBundleMarkdown({
            description: "",
            items: [
                { key: "analyst", kind: "skill" as const, skill: skill("analyst") },
                {
                    key: "hook",
                    kind: "trigger" as const,
                    trigger: { model: DIGEST.model, name: "Hook", type: "webhook" as const, webhookSignatureScheme: hookScheme },
                },
                { key: "digest", kind: "trigger" as const, trigger: digest },
            ],
            name: "Daily brief",
        });
        const contentHash = await bodyHash(body);

        return { contentHash, markdown: withPluginHeader(body, { contentHash, slug: SLUG, version }) };
    };

    beforeEach(async () => {
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);

        const first = await file("timestamped", "1.0.0");

        await harness.withIdentity({ userId: OWNER } as never).action(procedureAt("plugins_install_action", "installPlugin"), {
            contentHash: first.contentHash,
            markdown: first.markdown,
        } as never);
    });

    afterEach(() => {
        harness.close();
    });

    const as = () => harness.withIdentity({ userId: OWNER } as never);

    it("replaces a webhook only after every other step, so an earlier failure issues no secret", async () => {
        // The webhook's scheme changes (a replacement) and the schedule changes too; the schedule's rewrite fails.
        const next = await file("native", "1.1.0", { ...DIGEST, cronExpression: "0 10 * * 1" });
        const original = procedureAt("plugins_update_apply", "updateTriggerChild") as { handler: (context: unknown, args: { entryKey: string }) => unknown };
        const before = await harness.run(async (context: any) => await context.db.query("triggers").collect());

        registry.set(
            "plugins_update_apply:updateTriggerChild",
            Object.assign(Object.create(original as object), {
                handler: async (context: unknown, args: { entryKey: string }) => {
                    if (args.entryKey === "trigger:digest") {
                        throw new LunoraError("CONFLICT", "injected failure");
                    }

                    return await original.handler(context, args);
                },
            }),
        );

        try {
            const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;

            await expect(
                as().action(procedureAt("plugins_update", "updatePlugin"), {
                    confirmDowngrade: false,
                    contentHash: next.contentHash,
                    expectedGeneration: preview.generation,
                    expectedInstallId: preview.installId,
                    markdown: next.markdown,
                } as never),
            ).rejects.toThrow("injected failure");
        } finally {
            registry.set("plugins_update_apply:updateTriggerChild", original);
        }

        const after = await harness.run(async (context: any) => await context.db.query("triggers").collect());
        const hookBefore = before.find((row: { name: string }) => row.name === "Hook");
        const hookAfter = after.find((row: { name: string }) => row.name === "Hook");

        expect(hookAfter).toMatchObject({ _id: hookBefore._id, webhookSignatureScheme: "timestamped" });
    });

    it("is not put on the error when a later step fails; the replaced webhook stays switched off", async () => {
        // The scheme change replaces the webhook (new secret); the last step, recording the new version, then fails.
        const next = await file("native", "1.1.0");
        const original = procedureAt("plugins_update_apply", "finishUpdate");

        registry.set(
            "plugins_update_apply:finishUpdate",
            Object.assign(Object.create(original as object), {
                handler: async () => {
                    throw new LunoraError("CONFLICT", "injected failure");
                },
            }),
        );
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;
        const failure: any = await as()
            .action(procedureAt("plugins_update", "updatePlugin"), {
                confirmDowngrade: false,
                contentHash: next.contentHash,
                expectedGeneration: preview.generation,
                expectedInstallId: preview.installId,
                markdown: next.markdown,
            } as never)
            .catch((error: unknown) => error);

        registry.set("plugins_update_apply:finishUpdate", original);

        expect(failure).toBeInstanceOf(Error);
        expect(JSON.stringify(failure.data ?? {})).not.toContain("webhookSecrets");

        const triggers = await harness.run(async (context: any) => await context.db.query("triggers").collect());

        expect(triggers.find((row: { name: string }) => row.name === "Hook")).toMatchObject({ enabled: false, type: "webhook" });

        const retry = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;

        expect(retry.plan).toContainEqual({ action: "same", entryKey: "trigger:hook" });
    });
});
