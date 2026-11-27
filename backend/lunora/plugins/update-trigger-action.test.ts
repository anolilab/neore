/**
 * An update through the real action path, with a schedule in the plugin. A skill inserted above an unedited schedule
 * changes nothing about the schedule: its key and plan entry stay the same, and its row is the same row afterwards,
 * not a deleted and recreated one.
 */
import { lunoraTest } from "@lunora/testing";
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

type PreviewResult = { plan: { action: string; entryKey: string }[] };
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
            markdown: next.markdown,
        } as never)) as UpdateResult;

        expect(result.skipped).toStrictEqual([]);
        expect(result.applied).toContain("skill:critic");
        expect(result.applied).not.toContain("trigger:digest");

        const after = await schedules();

        expect(after.map((row: { _id: string }) => row._id)).toStrictEqual(before.map((row: { _id: string }) => row._id));
        expect(after[0]).toMatchObject({ cronExpression: DIGEST.cronExpression, enabled: before[0].enabled, name: DIGEST.name });
    });
});
