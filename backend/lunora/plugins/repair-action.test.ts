/**
 * Repair through the real action path: an install is made, a child is lost as a crash would lose it, and repair takes the
 * file again and creates the child back.
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
        throw new Error(`repair-action.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

const OWNER = "owner-a";
const ANALYST = { description: "Analyst skill", instructions: "Be the analyst.", name: "analyst", slug: "analyst" };

const body = () => buildBundleMarkdown({ description: "", items: [{ kind: "skill", skill: ANALYST }], name: "Daily brief" });
const pluginFile = (contentHash: string) => withPluginHeader(body(), { contentHash, slug: "daily-brief", version: "1.0.0" });

describe("repair through the action", () => {
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
    const run = async <T>(fn: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await fn(context));

    it("creates back a child that was lost, and finishes the install", async () => {
        await as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: hash, markdown: pluginFile(hash) } as never);

        const install = await run(async (context) => (await context.db.pluginInstalls.findMany({ where: { userId: OWNER } })).page[0]);
        const skill = await run(async (context) => (await context.db.skills.findMany({ where: { userId: OWNER } })).page[0]);

        // The crash: the skill row is lost, and the install is left for repair.
        await run(async (context) => await context.db.delete("skills", skill._id));
        const link = await run(async (context) => (await context.db.pluginItems.findMany({ where: { installId: install._id } })).page[0]);

        await run(async (context) => await context.db.patch("pluginItems", link._id, { state: "intent" }));
        await run(async (context) => await context.db.patch("pluginInstalls", install._id, { status: "needs-repair" }));

        const result = await as().action(procedureAt("plugins_repair_resume", "repairPlugin"), {
            contentHash: hash,
            markdown: pluginFile(hash),
            pluginSlug: "daily-brief",
        } as never);

        expect(result).toMatchObject({ status: "installed" });

        const restored = await run(async (context) => (await context.db.skills.findMany({ where: { userId: OWNER } })).page);
        const after = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: install._id } }));

        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({ name: "analyst", pluginInstallId: install._id });
        expect(after).toMatchObject({ status: "installed" });
    });

    it("refuses a repair with a file that is not the one the install came from", async () => {
        await as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: hash, markdown: pluginFile(hash) } as never);

        await expect(
            as().action(procedureAt("plugins_repair_resume", "repairPlugin"), {
                contentHash: "d".repeat(64),
                markdown: pluginFile(hash),
                pluginSlug: "daily-brief",
            } as never),
        ).rejects.toThrow("not the file");
    });
    it("refuses a repair with a different file that names the same plugin, even with a valid hash of its own", async () => {
        await as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: hash, markdown: pluginFile(hash) } as never);

        const otherBody = buildBundleMarkdown({
            description: "",
            items: [{ kind: "skill", skill: { ...ANALYST, instructions: "Something else entirely." } }],
            name: "Daily brief",
        });
        const otherHash = await bodyHash(otherBody);
        const otherFile = withPluginHeader(otherBody, { contentHash: otherHash, slug: "daily-brief", version: "1.0.0" });

        await expect(
            as().action(procedureAt("plugins_repair_resume", "repairPlugin"), {
                contentHash: otherHash,
                markdown: otherFile,
                pluginSlug: "daily-brief",
            } as never),
        ).rejects.toThrow("not the file");

        const skills = await run(async (context) => (await context.db.skills.findMany({ where: { userId: OWNER } })).page);

        expect(skills.map((skill: { instructions: string }) => skill.instructions)).toEqual([ANALYST.instructions]);
    });
});
