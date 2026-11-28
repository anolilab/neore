/**
 * The update procedures through the real action path: the session is mocked the way the install tests mock it, and the
 * procedures and the internal functions they call are registered by module, so a call reaches the code, not the sign-in.
 *
 * Each skill declares its key in the file, so a change elsewhere in the file leaves every other skill's entry key as it was.
 */
import { lunoraTest } from "@lunora/testing";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import { schemaWithShardedTables } from "../lib/test-schema";
import { buildBundleMarkdown } from "../skills/bundle-format";
import { withPluginHeader } from "./export";
import { bodyHash } from "./logic";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

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
    plugins_repair_resume: async () => await import("./repair-resume"),
    plugins_update: async () => await import("./update"),
    plugins_update_apply: async () => await import("./update-apply"),
    skills_bundle: async () => await import("../skills/bundle"),
    skills_create_skill: async () => await import("../skills/create-skill"),
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
        throw new Error(`update-action.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

type PreviewResult = {
    downgrade: boolean;
    generation: number;
    installedVersion: string;
    installId: string;
    plan: { action: string; entryKey: string }[];
    targetVersion: string;
};
type UpdateResult = { applied: string[]; skipped: { action: string; entryKey: string }[]; version: string };

const OWNER = "owner-a";
const SLUG = "daily-brief";

const skill = (slug: string) => {
    return { description: `${slug} skill`, instructions: `Be the ${slug}.`, name: slug, slug };
};

/** A plugin file with one skill per slug, at `version`. The header carries the hash of the body, as the install needs. */
const fileOf = async (slugs: string[], version: string) => {
    const body = buildBundleMarkdown({
        description: "",
        items: slugs.map((slug) => {
            return { key: slug, kind: "skill" as const, skill: skill(slug) };
        }),
        name: "Daily brief",
    });
    const contentHash = await bodyHash(body);

    return { contentHash, markdown: withPluginHeader(body, { contentHash, slug: SLUG, version }) };
};

describe("plugin update action", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);

        const first = await fileOf(["analyst", "critic"], "1.0.0");

        await harness.withIdentity({ userId: OWNER } as never).action(procedureAt("plugins_install_action", "installPlugin"), {
            contentHash: first.contentHash,
            markdown: first.markdown,
        } as never);
    });

    afterEach(() => {
        harness.close();
    });

    const as = () => harness.withIdentity({ userId: OWNER } as never);
    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));
    const skillsNamed = async () =>
        await run(async (context) => {
            const { page } = await context.db.skills.findMany({ where: { userId: OWNER } });

            return page;
        });
    const currentInstallId = async (): Promise<string> => {
        const row = await installRow();

        return row._id;
    };
    const installRow = async () =>
        await run(async (context) => {
            const { page } = await context.db.pluginInstalls.findMany({ where: { userId: OWNER } });

            return page[0];
        });
    const updateTo = async (slugs: string[], version: string) => {
        const next = await fileOf(slugs, version);
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult & {
            generation: number;
        };

        return (await as().action(procedureAt("plugins_update", "updatePlugin"), {
            confirmDowngrade: false,
            contentHash: next.contentHash,
            expectedGeneration: preview.generation,
            expectedInstallId: preview.installId,
            markdown: next.markdown,
        } as never)) as UpdateResult;
    };

    it("adds a skill at the end of the file and creates it under its own entry key", async () => {
        const next = await fileOf(["analyst", "critic", "reviewer"], "1.1.0");

        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;

        expect(preview).toMatchObject({ downgrade: false, installedVersion: "1.0.0", targetVersion: "1.1.0" });
        expect(preview.plan).toContainEqual({ action: "create", entryKey: "skill:reviewer" });

        const result = await updateTo(["analyst", "critic", "reviewer"], "1.1.0");

        expect(result).toMatchObject({ skipped: [], version: "1.1.0" });
        expect(result.applied).toContain("skill:reviewer");

        const rows = await skillsNamed();
        const names = rows.map((row: { name: string }) => row.name);

        expect(names).toEqual(expect.arrayContaining(["analyst", "critic", "reviewer"]));
        expect(await installRow()).toMatchObject({ contentHash: next.contentHash, status: "installed", version: "1.1.0" });
    });

    it("removes the last skill when it is unedited, and leaves the rest alone", async () => {
        const { markdown } = await fileOf(["analyst"], "1.1.0");
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), {
            markdown,
        } as never)) as PreviewResult;

        expect(preview.plan).toContainEqual({ action: "delete", entryKey: "skill:critic" });

        const result = await updateTo(["analyst"], "1.1.0");

        expect(result.applied).toContain("skill:critic");

        const rows = await skillsNamed();
        const names = rows.map((row: { name: string }) => row.name);

        expect(names).toEqual(["analyst"]);
    });

    it("keeps the last skill when the person has edited it: detached, with its marker cleared, and reported", async () => {
        const [critic] = await run(async (context) => {
            const { page } = await context.db.skills.findMany({ where: { name: "critic" } });

            return page;
        });

        await run(async (context) => await context.db.patch("skills", critic._id, { instructions: "Changed by the owner." }));

        const result = await updateTo(["analyst"], "1.1.0");

        expect(result.applied).toContain("skill:critic");

        const rows = await skillsNamed();
        const kept = rows.find((row: { name: string }) => row.name === "critic");

        expect(kept).toMatchObject({ instructions: "Changed by the owner.", pluginInstallId: "", pluginMarker: "" });
    });

    it("inserts a skill in the middle of the file, and no other skill's entry key changes", async () => {
        const next = await fileOf(["analyst", "reviewer", "critic"], "1.1.0");

        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;

        expect(preview.plan).toContainEqual({ action: "create", entryKey: "skill:reviewer" });
        expect(preview.plan).toContainEqual({ action: "same", entryKey: "skill:critic" });
        expect(preview.plan).not.toContainEqual(expect.objectContaining({ action: "delete" }));

        const result = await updateTo(["analyst", "reviewer", "critic"], "1.1.0");

        expect(result.applied).toStrictEqual(["skill:reviewer"]);
        expect(result.skipped).toStrictEqual([]);
    });

    it("a skill whose key changes but whose slug stays gets a slug the install does not hold, and the old skill is removed", async () => {
        const body = buildBundleMarkdown({
            description: "",
            items: [
                { key: "analyst", kind: "skill", skill: skill("analyst") },
                { key: "critic-two", kind: "skill", skill: skill("critic") },
            ],
            name: "Daily brief",
        });
        const contentHash = await bodyHash(body);
        const markdown = withPluginHeader(body, { contentHash, slug: SLUG, version: "1.1.0" });

        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown } as never)) as PreviewResult;

        expect(preview.plan).toContainEqual({ action: "create", entryKey: "skill:critic-two" });
        expect(preview.plan).toContainEqual({ action: "delete", entryKey: "skill:critic" });

        const result = (await as().action(procedureAt("plugins_update", "updatePlugin"), {
            confirmDowngrade: false,
            contentHash,
            expectedGeneration: 1,
            expectedInstallId: await currentInstallId(),
            markdown,
        } as never)) as UpdateResult;

        expect(result.skipped).toStrictEqual([]);
        expect(result.applied).toEqual(expect.arrayContaining(["skill:critic-two", "skill:critic"]));
        const rows = await skillsNamed();

        expect(rows.map((row: { slug: string }) => row.slug).toSorted((a: string, b: string) => a.localeCompare(b))).toStrictEqual(["analyst", "critic-2"]);
    });

    it("a keyed skill whose slug changes takes the new slug on its row, so the next update does not read it as edited", async () => {
        const body = buildBundleMarkdown({
            description: "",
            items: [
                { key: "analyst", kind: "skill", skill: skill("analyst") },
                { key: "critic", kind: "skill", skill: skill("critic-pro") },
            ],
            name: "Daily brief",
        });
        const contentHash = await bodyHash(body);
        const markdown = withPluginHeader(body, { contentHash, slug: SLUG, version: "1.1.0" });

        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown } as never)) as PreviewResult;

        expect(preview.plan).toContainEqual({ action: "update", entryKey: "skill:critic" });

        const result = (await as().action(procedureAt("plugins_update", "updatePlugin"), {
            confirmDowngrade: false,
            contentHash,
            expectedGeneration: 1,
            expectedInstallId: await currentInstallId(),
            markdown,
        } as never)) as UpdateResult;

        expect(result.applied).toContain("skill:critic");

        const rows = await skillsNamed();

        const slugs: string[] = rows.map((row: { slug: string }) => row.slug);

        expect(slugs.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["analyst", "critic-pro"]);

        const again = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown } as never)) as PreviewResult;

        expect(again.plan).toContainEqual({ action: "same", entryKey: "skill:critic" });
    });

    it("reports a removal as skipped when a group chat still names the skill", async () => {
        const [critic] = await run(async (context) => {
            const { page } = await context.db.skills.findMany({ where: { name: "critic" } });

            return page;
        });

        await run(async (context) => {
            await context.db.insert("threads", {
                groupChat: { mode: "round-robin", participants: [{ addedAt: Date.now(), skillId: critic._id }] },
                status: "active",
                title: "Panel",
                userId: OWNER,
            });
        });

        const result = await updateTo(["analyst"], "1.1.0");

        expect(result.skipped).toContainEqual({ action: "delete", entryKey: "skill:critic" });
        const rows = await skillsNamed();

        expect(rows.map((row: { name: string }) => row.name).toSorted((a: string, b: string) => a.localeCompare(b))).toStrictEqual(["analyst", "critic"]);
    });

    it("creates a key again when a later version brings back a skill that an earlier one removed while it was edited", async () => {
        const [critic] = await run(async (context) => {
            const { page } = await context.db.skills.findMany({ where: { name: "critic" } });

            return page;
        });

        await run(async (context) => await context.db.patch("skills", critic._id, { instructions: "Changed by the owner." }));
        await updateTo(["analyst"], "1.1.0");

        const result = await updateTo(["analyst", "critic"], "1.2.0");

        expect(result.applied).toContain("skill:critic");

        const named = await skillsNamed();
        const owned = named.filter((row: { pluginMarker?: string }) => row.pluginMarker);

        expect(owned.map((row: { name: string }) => row.name).toSorted((a: string, b: string) => a.localeCompare(b))).toStrictEqual(["analyst", "critic"]);
    });

    it("refuses the preview and the update for an account that is not on the plugins allowlist", async () => {
        const next = await fileOf(["analyst", "critic", "reviewer"], "1.1.0");
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;
        const variables = env as Record<string, string | undefined>;
        const saved = variables.PLUGINS_ALLOWED_USERS;

        variables.PLUGINS_ALLOWED_USERS = "someone-else";

        try {
            await expect(as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)).rejects.toThrow(
                "Plugins are not available for this account yet",
            );
            await expect(
                as().action(procedureAt("plugins_update", "updatePlugin"), {
                    confirmDowngrade: false,
                    contentHash: next.contentHash,
                    expectedGeneration: preview.generation,
                    expectedInstallId: preview.installId,
                    markdown: next.markdown,
                } as never),
            ).rejects.toThrow("Plugins are not available for this account yet");
        } finally {
            variables.PLUGINS_ALLOWED_USERS = saved;
        }

        expect(await installRow()).toMatchObject({ status: "installed", version: "1.0.0" });
    });

    it("returns the generation from the preview and refuses an update whose preview is older", async () => {
        const next = await fileOf(["analyst", "critic", "reviewer"], "1.1.0");
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult & {
            generation: number;
        };

        expect(preview.generation).toBe(1);

        await expect(
            as().action(procedureAt("plugins_update", "updatePlugin"), {
                confirmDowngrade: false,
                contentHash: next.contentHash,
                expectedGeneration: preview.generation - 1,
                expectedInstallId: preview.installId,
                markdown: next.markdown,
            } as never),
        ).rejects.toThrow("Preview it again");
        expect(await installRow()).toMatchObject({ status: "installed", version: "1.0.0" });
    });

    it("refuses an old preview after the plugin was uninstalled and installed again", async () => {
        const next = await fileOf(["analyst", "critic", "reviewer"], "1.1.0");
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;

        // Uninstall (its rows go) and install again: the new install starts at generation 1 once more.
        await run(async (context) => {
            for (const table of ["pluginItems", "skills", "pluginInstalls"] as const) {
                const { page } = await context.db[table].findMany({ where: { userId: OWNER } });

                for (const row of page) {
                    await context.db.delete(table, row._id);
                }
            }
        });

        const first = await fileOf(["analyst", "critic"], "1.0.0");

        await as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: first.contentHash, markdown: first.markdown } as never);

        const reinstalled = await installRow();

        expect(reinstalled.generation).toBe(preview.generation);

        await expect(
            as().action(procedureAt("plugins_update", "updatePlugin"), {
                confirmDowngrade: false,
                contentHash: next.contentHash,
                expectedGeneration: preview.generation,
                expectedInstallId: preview.installId,
                markdown: next.markdown,
            } as never),
        ).rejects.toThrow("Preview it again");
    });

    it("keeps the install for repair when a step fails after the new children were created", async () => {
        const next = await fileOf(["analyst", "reviewer"], "1.1.0");
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;
        const removeChild = procedureAt("plugins_update_apply", "removeChild") as { handler: (...args: unknown[]) => unknown };
        const spy = vi.spyOn(removeChild, "handler").mockRejectedValue(new Error("removal failed"));

        try {
            await expect(
                as().action(procedureAt("plugins_update", "updatePlugin"), {
                    confirmDowngrade: false,
                    contentHash: next.contentHash,
                    expectedGeneration: preview.generation,
                    expectedInstallId: preview.installId,
                    markdown: next.markdown,
                } as never),
            ).rejects.toThrow();
        } finally {
            spy.mockRestore();
        }

        // The new child exists, so the old version is not declared complete.
        expect(await installRow()).toMatchObject({ contentHash: next.contentHash, status: "needs-repair", version: "1.0.0" });

        // Repair with the new file detaches the child the update meant to drop, then finishes at the new version.
        const repaired = await as().action(procedureAt("plugins_repair_resume", "repairPlugin"), {
            contentHash: next.contentHash,
            markdown: next.markdown,
            pluginSlug: SLUG,
        } as never);

        expect(repaired).toMatchObject({ kept: ["skill:critic"], status: "installed" });
        expect(await installRow()).toMatchObject({ status: "installed", version: "1.1.0" });

        const { page: critic } = await run(async (context) => await context.db.skills.findMany({ where: { slug: "critic", userId: OWNER } }));
        const { page: links } = await run(async (context) => await context.db.pluginItems.findMany({ where: { userId: OWNER } }));

        expect(critic).toHaveLength(1);
        expect(critic[0].pluginMarker).toBeFalsy();
        expect(links.map((link: { entryKey: string }) => link.entryKey)).not.toContain("skill:critic");
    });
});
