/**
 * Exporting an installed plugin through the action path: the file it writes carries each skill under the key the install
 * gave it, so the exported file can be installed again and its children keep the same entry keys.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import { schemaWithShardedTables } from "../lib/test-schema";
import { buildBundleMarkdown, parseBundleMarkdown } from "../skills/bundle-format";
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
    plugins_export: async () => await import("./export"),
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
        throw new Error(`export-keys.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

const OWNER = "owner-a";
const SLUG = "daily-brief";

const skill = (slug: string) => ({ description: `${slug} skill`, instructions: `Be the ${slug}.`, name: slug, slug });

/** A plugin file with one skill per slug, each under its own key. */
const fileOf = async (slugs: string[]) => {
    const body = buildBundleMarkdown({
        description: "",
        items: slugs.map((slug) => ({ key: slug, kind: "skill" as const, skill: skill(slug) })),
        name: "Daily brief",
    });
    const contentHash = await bodyHash(body);

    return { contentHash, markdown: withPluginHeader(body, { contentHash, slug: SLUG, version: "1.0.0" }) };
};

describe("exporting an installed plugin", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);

        const file = await fileOf(["analyst", "critic"]);

        await harness.withIdentity({ userId: OWNER } as never).action(procedureAt("plugins_install_action", "installPlugin"), {
            contentHash: file.contentHash,
            markdown: file.markdown,
        } as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("writes the installed skills under their declared keys, and the file reads back with the same keys", async () => {
        const skillIds = await harness.run(async (context: any) =>
            (await context.db.skills.findMany({ where: { userId: OWNER } })).page.map((row: { _id: string }) => row._id),
        );

        const { markdown } = (await harness.withIdentity({ userId: OWNER } as never).action(procedureAt("skills_bundle", "exportBundle"), {
            groupChatIds: [],
            name: "Daily brief",
            skillIds,
            triggerIds: [],
        } as never)) as { markdown: string };

        expect(markdown).toContain(`bundle: 2\nplugin: ${SLUG}\npluginVersion: 1.0.0\n`);
        expect(markdown).toContain("## skill: analyst {key=analyst}");
        expect(markdown).toContain("## skill: critic {key=critic}");

        const parsed = parseBundleMarkdown(markdown);

        expect(parsed.ok && parsed.bundle.entries.map((entry) => entry.declaredKey)).toStrictEqual(["analyst", "critic"]);
    });
});
