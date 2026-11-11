/**
 * A rate limit part-way through an install keeps the children made so far, and repair finishes the rest. It is not a
 * failure of the install, so nothing is rolled back.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import { schemaWithShardedTables } from "../lib/test-schema";
import { buildBundleMarkdown } from "../skills/bundle-format";
import { withPluginHeader } from "./export";
import { bodyHash } from "./logic";

const registry = vi.hoisted(() => new Map<string, unknown>());
const limit = vi.hoisted(() => ({ allowed: 1, calls: 0 }));

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

// Only the skill create family is limited here, and only after `limit.allowed` creates.
vi.mock("../lib/rate-limiter", async (importOriginal) => {
    const { LunoraError } = await import("lunorash/server");

    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async (context: { rateLimitKey: string }) => {
            if (context.rateLimitKey !== "skills/create") {
                return;
            }

            limit.calls += 1;

            if (limit.calls > limit.allowed) {
                throw new LunoraError("TOO_MANY_REQUESTS", "Rate limit exceeded. Please try again later.");
            }
        },
    };
});

const MODULES = {
    lib_claim_once: async () => await import("../lib/claim-once"),
    plugins_install_action: async () => await import("./install-action"),
    plugins_install_steps: async () => await import("./install-steps"),
    plugins_repair_resume: async () => await import("./repair-resume"),
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
        throw new Error(`rate-limit-resume.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

const OWNER = "owner-a";
const ANALYST = { description: "Analyst skill", instructions: "Be the analyst.", name: "analyst", slug: "analyst" };
const REVIEWER = { description: "Reviewer skill", instructions: "Review it.", name: "reviewer", slug: "reviewer" };

const body = () =>
    buildBundleMarkdown({
        description: "",
        items: [
            { kind: "skill", skill: ANALYST },
            { kind: "skill", skill: REVIEWER },
        ],
        name: "Pair",
    });
const pluginFile = (contentHash: string) => withPluginHeader(body(), { contentHash, slug: "pair", version: "1.0.0" });

describe("a rate limit part-way through an install", () => {
    let harness: ReturnType<typeof lunoraTest>;
    let hash: string;

    beforeEach(async () => {
        limit.allowed = 1;
        limit.calls = 0;
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);
        hash = await bodyHash(body());
    });

    afterEach(() => {
        harness.close();
    });

    const as = () => harness.withIdentity({ userId: OWNER } as never);
    const run = async <T>(fn: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await fn(context));
    const skillNames = async () =>
        (await run(async (context) => (await context.db.skills.findMany({ where: { userId: OWNER } })).page)).map((skill: { name: string }) => skill.name);

    it("keeps the child made before the limit, leaves the install for repair, and repair finishes the rest", async () => {
        await expect(
            as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: hash, markdown: pluginFile(hash) } as never),
        ).rejects.toThrow("rate limit");

        expect(await skillNames()).toEqual(["analyst"]);

        const install = await run(async (context) => (await context.db.pluginInstalls.findMany({ where: { userId: OWNER } })).page[0]);

        expect(install).toMatchObject({ status: "needs-repair" });

        // The limit lifts; repair creates the child that was waiting.
        limit.allowed = 10;
        limit.calls = 0;

        const result = await as().action(procedureAt("plugins_repair_resume", "repairPlugin"), {
            contentHash: hash,
            markdown: pluginFile(hash),
            pluginSlug: "pair",
        } as never);

        expect(result).toMatchObject({ status: "installed" });
        expect((await skillNames()).sort()).toEqual(["analyst", "reviewer"]);
    });
});
