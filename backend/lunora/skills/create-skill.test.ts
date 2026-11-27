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
    skills_functions: async () => await import("./functions"),
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
        throw new Error(`create-skill.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

const OWNER = "owner-a";
const INSTALL = "install-1";
const MARKER = `${INSTALL}:skill:summary`;

const skillInput = {
    description: "Summarise a note",
    instructions: "Summarise the note in one line.",
    name: "Summary",
    slug: "summary",
};

const pluginInput = {
    ...skillInput,
    isPremium: true,
    pluginInstallId: INSTALL,
    pluginMarker: MARKER,
    source: { type: "plugin" as const, version: "1.0.0" },
    userId: OWNER,
};

describe("plugin skills", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const rowsWithMarker = async () => await harness.run(async (context: any) => (await context.db.skills.findMany({ where: { pluginMarker: MARKER } })).page);

    it("refuses a plugin source through the public create procedure, and stores nothing", async () => {
        await expect(
            harness
                .withIdentity({ userId: OWNER } as never)
                .mutation(procedureAt("skills_functions", "createSkill"), { ...skillInput, source: { type: "plugin", version: "1.0.0" } } as never),
        ).rejects.toThrow();

        expect(await rowsWithMarker()).toHaveLength(0);
    });

    it("never stores a marker from the public create procedure, even when a caller sends one", async () => {
        const outcome = await harness
            .withIdentity({ userId: OWNER } as never)
            .mutation(procedureAt("skills_functions", "createSkill"), { ...skillInput, source: { type: "editor" }, pluginMarker: MARKER } as never)
            .then(
                () => "stored without the marker",
                () => "refused",
            );

        expect(["stored without the marker", "refused"]).toContain(outcome);
        expect(await rowsWithMarker()).toHaveLength(0);
    });

    it("creates the child once, and a second call with the same marker returns the same id and creates nothing", async () => {
        const first = await harness.run(async (context: any) => await context.runMutation(createPluginSkill, pluginInput));
        const second = await harness.run(async (context: any) => await context.runMutation(createPluginSkill, pluginInput));

        expect(second).toBe(first);

        const rows = await rowsWithMarker();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ pluginInstallId: INSTALL, pluginMarker: MARKER, source: { type: "plugin", version: "1.0.0" }, userId: OWNER });
    });
});
