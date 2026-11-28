/**
 * An update removes the skills it drops that are sure to go before it creates: a free account at its skill limit can swap one skill
 * for another, and the new skill takes the dropped one's slug. Sure means the owner's group-chat index is complete (and the rest of
 * `early-removal.ts`); without it the order is create, then remove.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import { schemaWithShardedTables } from "../lib/test-schema";
import { buildBundleMarkdown } from "../skills/bundle-format";
import { withPluginHeader } from "./export";
import { bodyHash } from "./logic";

const registry = vi.hoisted(() => new Map<string, unknown>());
const session = vi.hoisted(() => {
    return { plan: "premium" };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const sessionFrom = vi.hoisted(() => async (context: { auth: { userId?: string | null } }) => {
    const { userId } = context.auth;

    return userId ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, plan: session.plan, userId } : null;
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

type PreviewResult = { generation: number; installId: string; plan: { action: string; entryKey: string }[] };

const OWNER = "owner-a";
const SLUG = "daily-brief";

const skill = (slug: string) => {
    return { description: `${slug} skill`, instructions: `Be the ${slug}.`, name: slug, slug };
};

/** A plugin file with the given skills (key, slug), at `version`. */
const fileOf = async (skills: [string, string][], version: string) => {
    const body = buildBundleMarkdown({
        description: "",
        items: skills.map(([key, slug]) => {
            return { key, kind: "skill" as const, skill: skill(slug) };
        }),
        name: "Daily brief",
    });
    const contentHash = await bodyHash(body);

    return { contentHash, markdown: withPluginHeader(body, { contentHash, slug: SLUG, version }) };
};

const FIVE: [string, string][] = ["a", "b", "c", "d", "e"].map((key) => [key, key]);
// The fifth skill is replaced by another key that wants the same slug.
const SWAPPED: [string, string][] = [...FIVE.slice(0, 4), ["e-two", "e"]];

describe("plugin update: early removal", () => {
    let harness: ReturnType<typeof lunoraTest>;

    const as = () => harness.withIdentity({ userId: OWNER } as never);
    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));
    const skillSlugs = async (): Promise<string[]> =>
        await run(async (context) => {
            const { page } = await context.db.skills.findMany({ where: { userId: OWNER } });

            return page.map((row: { slug: string }) => row.slug).toSorted((a: string, b: string) => a.localeCompare(b));
        });
    const installRow = async () =>
        await run(async (context) => {
            const { page } = await context.db.pluginInstalls.findMany({ where: { userId: OWNER } });

            return page[0];
        });
    const completeIndex = async () => await run(async (context) => await context.db.insert("groupChatSkillIndex", { completedAt: Date.now(), userId: OWNER }));
    const preview = async (markdown: string) => (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown } as never)) as PreviewResult;
    const apply = async (file: { contentHash: string; markdown: string }) => {
        const shown = await preview(file.markdown);

        return await as().action(procedureAt("plugins_update", "updatePlugin"), {
            confirmDowngrade: false,
            contentHash: file.contentHash,
            expectedGeneration: shown.generation,
            expectedInstallId: shown.installId,
            markdown: file.markdown,
        } as never);
    };

    beforeEach(async () => {
        session.plan = "free";
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);

        const first = await fileOf(FIVE, "1.0.0");

        await as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: first.contentHash, markdown: first.markdown } as never);
    });

    afterEach(() => {
        session.plan = "premium";
        harness.close();
    });

    it("swaps one skill for another at the free limit, and the new one takes the freed slug", async () => {
        await completeIndex();
        const next = await fileOf(SWAPPED, "1.1.0");

        await expect(apply(next)).resolves.toMatchObject({ skipped: [] });

        expect(await skillSlugs()).toStrictEqual(["a", "b", "c", "d", "e"]);
        expect(await installRow()).toMatchObject({ status: "installed", version: "1.1.0" });

        // The slug is part of the hash: planned again, nothing differs.
        const again = await preview(next.markdown);

        expect(again.plan.every((step) => step.action === "same")).toBe(true);
    });

    it("removes nothing early below the limit when the new skill does not want the dropped slug, and a failed create keeps the old skill", async () => {
        session.plan = "premium";
        await completeIndex();
        const next = await fileOf([...FIVE.slice(0, 4), ["f", "f"]], "1.1.0");
        const create = procedureAt("skills_create_skill", "createPluginSkill") as { handler: (...args: unknown[]) => unknown };
        const spy = vi.spyOn(create, "handler").mockRejectedValueOnce(new Error("create failed"));

        try {
            await expect(apply(next)).rejects.toThrow();
        } finally {
            spy.mockRestore();
        }

        expect(await skillSlugs()).toStrictEqual(["a", "b", "c", "d", "e"]);

        await apply(next);

        expect(await skillSlugs()).toStrictEqual(["a", "b", "c", "d", "f"]);
        const again = await preview(next.markdown);

        expect(again.plan.every((step) => step.action === "same")).toBe(true);
    });

    it("keeps today's order when the owner's index is not complete: the free limit refuses the create", async () => {
        const next = await fileOf(SWAPPED, "1.1.0");

        await expect(apply(next)).rejects.toThrow();
        expect(await skillSlugs()).toStrictEqual(["a", "b", "c", "d", "e"]);
    });

    it("without an index a premium account gets the -2 slug, as before", async () => {
        session.plan = "premium";
        const next = await fileOf(SWAPPED, "1.1.0");

        await apply(next);

        expect(await skillSlugs()).toStrictEqual(["a", "b", "c", "d", "e-2"]);
    });

    it("does not remove early a skill that an edit made the owner's", async () => {
        await completeIndex();
        const { page } = await run(async (context) => await context.db.skills.findMany({ where: { slug: "e" } }));
        const [edited] = page;

        await run(async (context) => await context.db.patch("skills", edited._id, { instructions: "Changed by the owner." }));

        const next = await fileOf(SWAPPED, "1.1.0");
        const shown = await preview(next.markdown);

        expect(shown.plan).toContainEqual({ action: "detach", entryKey: "skill:e" });
    });

    it("stops before any create when a skill that was sure to go is kept after all", async () => {
        await completeIndex();
        const removeChild = procedureAt("plugins_update_apply", "removeChild") as { handler: (...args: unknown[]) => unknown };
        const spy = vi.spyOn(removeChild, "handler").mockResolvedValue(false);

        try {
            await expect(apply(await fileOf(SWAPPED, "1.1.0"))).rejects.toThrow("in use now");
        } finally {
            spy.mockRestore();
        }

        expect(await skillSlugs()).toStrictEqual(["a", "b", "c", "d", "e"]);
        expect(await installRow()).toMatchObject({ partial: true, status: "installed", version: "1.0.0" });
    });

    it("marks the install partial when a create fails after the early removal, and the same update run again finishes", async () => {
        await completeIndex();
        const next = await fileOf(SWAPPED, "1.1.0");
        const create = procedureAt("skills_create_skill", "createPluginSkill") as { handler: (...args: unknown[]) => unknown };
        const spy = vi.spyOn(create, "handler").mockRejectedValueOnce(new Error("create failed"));

        try {
            await expect(apply(next)).rejects.toThrow();
        } finally {
            spy.mockRestore();
        }

        expect(await skillSlugs()).toStrictEqual(["a", "b", "c", "d"]);
        expect(await installRow()).toMatchObject({ partial: true, status: "installed", version: "1.0.0" });

        await expect(apply(next)).resolves.toMatchObject({ skipped: [] });
        expect(await skillSlugs()).toStrictEqual(["a", "b", "c", "d", "e"]);
        expect(await installRow()).toMatchObject({ status: "installed", version: "1.1.0" });
    });
});
