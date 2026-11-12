/**
 * The update procedures through the real action path: the session is mocked the way the install tests mock it, and the
 * procedures and the internal functions they call are registered by module, so a call reaches the code, not the sign-in.
 *
 * Each skill declares its key in the file, so a change elsewhere in the file leaves every other skill's entry key as it was.
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
    skills_bundle: async () => await import("../skills/bundle"),
    plugins_install_action: async () => await import("./install-action"),
    plugins_install_steps: async () => await import("./install-steps"),
    plugins_update: async () => await import("./update"),
    plugins_update_apply: async () => await import("./update-apply"),
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

type PreviewResult = { downgrade: boolean; installedVersion: string; plan: Array<{ action: string; entryKey: string }>; targetVersion: string };
type UpdateResult = { applied: string[]; skipped: Array<{ action: string; entryKey: string }>; version: string };

const OWNER = "owner-a";
const SLUG = "daily-brief";

const skill = (slug: string) => ({ description: `${slug} skill`, instructions: `Be the ${slug}.`, name: slug, slug });

/** A plugin file with one skill per slug, at `version`. The header carries the hash of the body, as the install needs. */
const fileOf = async (slugs: string[], version: string) => {
    const body = buildBundleMarkdown({
        description: "",
        items: slugs.map((slug) => ({ key: slug, kind: "skill" as const, skill: skill(slug) })),
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
    const run = async <T>(fn: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await fn(context));
    const skillsNamed = async () => await run(async (context) => (await context.db.skills.findMany({ where: { userId: OWNER } })).page);
    const installRow = async () => await run(async (context) => (await context.db.pluginInstalls.findMany({ where: { userId: OWNER } })).page[0]);
    const updateTo = async (slugs: string[], version: string) => {
        const next = await fileOf(slugs, version);

        return (await as().action(procedureAt("plugins_update", "updatePlugin"), {
            confirmDowngrade: false,
            contentHash: next.contentHash,
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

        const names = (await skillsNamed()).map((row: { name: string }) => row.name);

        expect(names).toEqual(expect.arrayContaining(["analyst", "critic", "reviewer"]));
        expect(await installRow()).toMatchObject({ contentHash: next.contentHash, status: "installed", version: "1.1.0" });
    });

    it("removes the last skill when it is unedited, and leaves the rest alone", async () => {
        const preview = (await as().action(procedureAt("plugins_update", "previewUpdate"), {
            markdown: (await fileOf(["analyst"], "1.1.0")).markdown,
        } as never)) as PreviewResult;

        expect(preview.plan).toContainEqual({ action: "delete", entryKey: "skill:critic" });

        const result = await updateTo(["analyst"], "1.1.0");

        expect(result.applied).toContain("skill:critic");

        const names = (await skillsNamed()).map((row: { name: string }) => row.name);

        expect(names).toEqual(["analyst"]);
    });

    it("keeps the last skill when the person has edited it: detached, with its marker cleared, and reported", async () => {
        const [critic] = await run(async (context) => (await context.db.skills.findMany({ where: { name: "critic" } })).page);

        await run(async (context) => await context.db.patch("skills", critic._id, { instructions: "Changed by the owner." }));

        const result = await updateTo(["analyst"], "1.1.0");

        expect(result.applied).toContain("skill:critic");

        const kept = (await skillsNamed()).find((row: { name: string }) => row.name === "critic");

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
            markdown,
        } as never)) as UpdateResult;

        expect(result.skipped).toStrictEqual([]);
        expect(result.applied).toEqual(expect.arrayContaining(["skill:critic-two", "skill:critic"]));
        expect((await skillsNamed()).map((row: { slug: string }) => row.slug).toSorted()).toStrictEqual(["analyst", "critic-2"]);
    });
});
