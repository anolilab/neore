/**
 * Forking is for marketplace skills, which are public. A plugin skill is private (its install never makes it public), so a
 * fork of one is refused, whoever asks. The refusal is the procedure's own, through the registered path.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import schema from "../schema";
import { createPluginSkill } from "./create-skill";

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
    skills_create_skill: async () => await import("./create-skill"),
    skills_marketplace: async () => await import("./marketplace"),
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
        throw new Error(`fork-plugin-skill.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

const OWNER = "owner-a";
const OTHER = "owner-b";

describe("forking a plugin skill", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("refuses a fork of a private plugin skill, even by its owner", async () => {
        const skillId = await harness.run(
            async (context: any) =>
                await context.runMutation(createPluginSkill, {
                    description: "Analyst",
                    instructions: "Analyse.",
                    isPremium: true,
                    name: "Analyst",
                    pluginInstallId: "install-1",
                    pluginMarker: "install-1:skill:analyst",
                    plan: "premium",
                    slug: "analyst",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );

        await expect(
            harness.withIdentity({ userId: OWNER } as never).mutation(procedureAt("skills_marketplace", "forkSkill"), { skillId } as never),
        ).rejects.toThrow("not found in marketplace");

        await expect(
            harness.withIdentity({ userId: OTHER } as never).mutation(procedureAt("skills_marketplace", "forkSkill"), { skillId } as never),
        ).rejects.toThrow("not found in marketplace");
    });
});
