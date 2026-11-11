/**
 * The install procedures through the real action path: the session is mocked the way the bundle tests mock it, and the
 * procedures and the internal functions they call are registered by module, so a call reaches the code, not the sign-in.
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
    skills_create_skill: async () => await import("../skills/create-skill"),
    plugins_install_action: async () => await import("./install-action"),
    plugins_install_steps: async () => await import("./install-steps"),
    skills_bundle: async () => await import("../skills/bundle"),
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
        throw new Error(`install-action.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

const OWNER = "owner-a";

const ANALYST = { description: "Analyst skill", instructions: "Be the analyst.", name: "analyst", slug: "analyst" };

/** The plugin's body: one skill. The header is added after the hash is known, since it carries that hash. */
const body = () => buildBundleMarkdown({ description: "", items: [{ kind: "skill", skill: ANALYST }], name: "Daily brief" });

const pluginFile = (contentHash: string) => withPluginHeader(body(), { contentHash, slug: "daily-brief", version: "1.0.0" });

describe("plugin install action", () => {
    let harness: ReturnType<typeof lunoraTest>;
    let hash: string;

    beforeEach(async () => {
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);
        hash = await bodyHash(body());
    });

    afterEach(() => {
        harness.close();
    });

    const as = () => harness.withIdentity({ userId: OWNER } as never);
    const installs = async () => await harness.run(async (context: any) => (await context.db.pluginInstalls.findMany({ where: { userId: OWNER } })).page);

    it("previews the file and returns the hash of its body", async () => {
        const preview = await as().action(procedureAt("plugins_install_action", "previewPlugin"), { markdown: pluginFile(hash) } as never);

        expect(preview).toMatchObject({ contentHash: hash, pluginSlug: "daily-brief", pluginVersion: "1.0.0" });
        expect(preview).toMatchObject({ items: [expect.objectContaining({ kind: "skill", title: "analyst" })] });
    });

    it("refuses an install whose hash is not the previewed one, and writes nothing", async () => {
        await expect(
            as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: "c".repeat(64), markdown: pluginFile(hash) } as never),
        ).rejects.toThrow("previewed");

        expect(await installs()).toHaveLength(0);
    });

    it("installs a plugin once, and refuses a second install of it", async () => {
        const args = { contentHash: hash, markdown: pluginFile(hash) };

        await as().action(procedureAt("plugins_install_action", "installPlugin"), args as never);

        const rows = await installs();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ pluginSlug: "daily-brief", status: "installed" });

        const skills = await harness.run(async (context: any) => (await context.db.skills.findMany({ where: { userId: OWNER } })).page);

        expect(skills).toEqual([expect.objectContaining({ name: "analyst", pluginInstallId: rows[0]._id, source: { type: "plugin", version: "1.0.0" } })]);

        await expect(as().action(procedureAt("plugins_install_action", "installPlugin"), args as never)).rejects.toThrow("already installed");
    });
});
