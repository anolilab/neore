/**
 * The install procedures through the real action path: the session is mocked the way the bundle tests mock it, and the
 * procedures and the internal functions they call are registered by module, so a call reaches the code, not the sign-in.
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
        throw new Error(`install-action.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

const OWNER = "owner-a";

const ANALYST = { description: "Analyst skill", instructions: "Be the analyst.", name: "analyst", slug: "analyst" };

/** The plugin's body: one skill. The header is added after the hash is known, since it carries that hash. */
const body = () => buildBundleMarkdown({ description: "", items: [{ key: "analyst", kind: "skill", skill: ANALYST }], name: "Daily brief" });

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
    const installs = async () =>
        await harness.run(async (context: any) => {
            const { page } = await context.db.pluginInstalls.findMany({ where: { userId: OWNER } });

            return page;
        });

    it("previews the file and returns the hash of its body", async () => {
        const preview = await as().action(procedureAt("plugins_install_action", "previewPlugin"), { markdown: pluginFile(hash) } as never);

        expect(preview).toMatchObject({ contentHash: hash, pluginSlug: "daily-brief", pluginVersion: "1.0.0" });
        expect(preview).toMatchObject({ items: [expect.objectContaining({ kind: "skill", title: "analyst" })] });
    });

    it("refuses preview and install for an account that is not on the plugins allowlist, and writes nothing", async () => {
        const variables = env as { PLUGINS_ALLOWED_USERS?: string };
        const before = variables.PLUGINS_ALLOWED_USERS;

        variables.PLUGINS_ALLOWED_USERS = "someone-else";

        try {
            await expect(as().action(procedureAt("plugins_install_action", "previewPlugin"), { markdown: pluginFile(hash) } as never)).rejects.toThrow(
                "not available for this account",
            );
            await expect(
                as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: hash, markdown: pluginFile(hash) } as never),
            ).rejects.toThrow("not available for this account");
            expect(await installs()).toHaveLength(0);
        } finally {
            variables.PLUGINS_ALLOWED_USERS = before;
        }
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

        const skills = await harness.run(async (context: any) => {
            const { page } = await context.db.skills.findMany({ where: { userId: OWNER } });

            return page;
        });

        expect(skills).toEqual([expect.objectContaining({ name: "analyst", pluginInstallId: rows[0]._id, source: { type: "plugin", version: "1.0.0" } })]);

        await expect(as().action(procedureAt("plugins_install_action", "installPlugin"), args as never)).rejects.toThrow("already installed");
    });

    it("keeps the install and its children, for repair, when finishing the install fails", async () => {
        const original = registry.get("plugins_install_steps:finishInstall");
        const { internalMutation } = await import("../_generated/server");
        const { v } = await import("lunorash/server");

        registry.set(
            "plugins_install_steps:finishInstall",
            internalMutation
                .input({ generation: v.number(), installId: v.string() })
                .output(v.null())
                .mutation(async () => {
                    throw new Error("finish failed");
                }),
        );

        try {
            await expect(
                as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: hash, markdown: pluginFile(hash) } as never),
            ).rejects.toThrow("finish failed");
        } finally {
            registry.set("plugins_install_steps:finishInstall", original);
        }

        const rows = await installs();
        const { page: skills } = await harness.run(async (context: any) => await context.db.skills.findMany({ where: { userId: OWNER } }));

        expect(rows).toEqual([expect.objectContaining({ status: "needs-repair" })]);
        expect(skills).toHaveLength(1);
    });

    it("releases its install claim only under the claim's own claimedAt, so a stale action cannot free a newer one", async () => {
        const original = registry.get("lib_claim_once:releaseKey");
        const { internalMutation } = await import("../_generated/server");
        const { v } = await import("lunorash/server");
        const released: unknown[] = [];

        registry.set(
            "lib_claim_once:releaseKey",
            internalMutation
                .input({ claimedAt: v.optional(v.number()), key: v.string(), scope: v.string() })
                .output(v.null())
                .mutation(async ({ args }) => {
                    released.push(args);

                    return null;
                }),
        );

        try {
            await as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: hash, markdown: pluginFile(hash) } as never);
        } finally {
            registry.set("lib_claim_once:releaseKey", original);
        }

        expect(released).toEqual([expect.objectContaining({ claimedAt: expect.any(Number), scope: "plugin-install" })]);
    });

    it("refuses a preview of a plugin that holds an entry install would refuse", async () => {
        const blocked = buildBundleMarkdown({
            description: "",
            items: [{ key: "t", kind: "trigger", trigger: { model: "no-such-model", name: "On PR", type: "webhook" } }],
            name: "Blocked",
        });
        const blockedHash = await bodyHash(blocked);

        await expect(
            as().action(procedureAt("plugins_install_action", "previewPlugin"), {
                markdown: withPluginHeader(blocked, { contentHash: blockedHash, slug: "blocked", version: "1.0.0" }),
            } as never),
        ).rejects.toThrow("not available");
    });

    it("reports the import's own error, and keeps the install for repair, when the cleanup fails too", async () => {
        const originalCreate = registry.get("skills_create_skill:createPluginSkill");
        const originalDelete = registry.get("plugins_install_steps:deleteInstall");
        const { internalMutation } = await import("../_generated/server");
        const { v } = await import("lunorash/server");

        registry.set(
            "skills_create_skill:createPluginSkill",
            internalMutation
                .input({ generation: v.optional(v.number()) })
                .output(v.null())
                .mutation(async () => {
                    throw new Error("create exploded");
                }),
        );
        registry.set(
            "plugins_install_steps:deleteInstall",
            internalMutation
                .input({ generation: v.number(), installId: v.string() })
                .output(v.null())
                .mutation(async () => {
                    throw new Error("cleanup exploded");
                }),
        );

        try {
            await expect(
                as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: hash, markdown: pluginFile(hash) } as never),
            ).rejects.toThrow("create exploded");
        } finally {
            registry.set("skills_create_skill:createPluginSkill", originalCreate);
            registry.set("plugins_install_steps:deleteInstall", originalDelete);
        }

        expect(await installs()).toEqual([expect.objectContaining({ status: "needs-repair" })]);
    });
});
