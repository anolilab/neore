/**
 * Repair of a plugin whose skill was deleted while a group chat names it: the recreated skill replaces the dead participant in the
 * group, and a group the remap cannot match one to one leaves the install partial.
 */
import { lunoraTest } from "@lunora/testing";
import { isSelectableTextModel, MODEL_REGISTRY } from "@neore/ai/models";
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
    agent_threads: async () => await import("../agent/threads"),
    chat_group_functions: async () => await import("../chat/group/functions"),
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
        throw new Error(`repair-group.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

const OWNER = "owner-a";
const SLUG = "daily-brief";
const MODEL = MODEL_REGISTRY.find((definition) => isSelectableTextModel(definition))!.id;

const skill = (slug: string) => {
    return { description: `${slug} skill`, instructions: `Be the ${slug}.`, name: slug, slug };
};

const fileOf = async () => {
    const body = buildBundleMarkdown({
        description: "",
        items: [
            { key: "a", kind: "skill" as const, skill: skill("a") },
            { key: "b", kind: "skill" as const, skill: skill("b") },
            { group: { mode: "round-robin" as const, model: MODEL, participants: ["a", "b"], title: "Panel" }, key: "panel", kind: "group" as const },
        ],
        name: "Daily brief",
    });
    const contentHash = await bodyHash(body);

    return { contentHash, markdown: withPluginHeader(body, { contentHash, slug: SLUG, version: "1.0.0" }) };
};

describe("repair of a plugin group chat whose skill was deleted", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);
    });

    afterEach(() => {
        harness.close();
    });

    const as = () => harness.withIdentity({ userId: OWNER } as never);
    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));
    const skillBySlug = async (slug: string) =>
        await run(async (context) => {
            const { page } = await context.db.skills.findMany({ where: { slug, userId: OWNER } });

            return page[0];
        });
    const groupRow = async () =>
        await run(async (context) => {
            const { page } = await context.db.pluginInstalls.findMany({ where: { userId: OWNER } });
            const install = page[0];

            return await context.db
                .query("threads")
                .withIndex("by_plugin_marker", (q: any) => q.eq("pluginMarker", `${install._id}:group:panel`))
                .first();
        });
    const installRow = async () =>
        await run(async (context) => {
            const { page } = await context.db.pluginInstalls.findMany({ where: { userId: OWNER } });

            return page[0];
        });

    /** Installs the file, deletes the skills the way the person (or a crash) would, and leaves the install for repair. */
    const breakSkills = async (slugs: string[]) => {
        const file = await fileOf();

        await as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: file.contentHash, markdown: file.markdown } as never);

        const install = await installRow();

        for (const slug of slugs) {
            const row = await skillBySlug(slug);

            await run(async (context) => await context.db.delete("skills", row._id));
        }

        // The links stay `created`: repair finds the child gone and records the id it held.
        await run(async (context) => await context.db.patch("pluginInstalls", install._id, { status: "needs-repair" }));

        return file;
    };
    const repair = async (file: { contentHash: string; markdown: string }) =>
        await as().action(procedureAt("plugins_repair_resume", "repairPlugin"), {
            contentHash: file.contentHash,
            markdown: file.markdown,
            pluginSlug: SLUG,
        } as never);

    it("points the group at the skill repair made in place of the deleted one", async () => {
        const file = await breakSkills(["a"]);
        const before = await groupRow();
        const oldId = before.groupChat.participants[0].skillId;

        await expect(repair(file)).resolves.toMatchObject({ status: "installed", unmatchedGroups: [] });

        const fresh = await skillBySlug("a");
        const group = await groupRow();

        expect(fresh._id).not.toBe(oldId);
        expect(group.groupChat.participants.map((participant: { skillId: string }) => participant.skillId)).toContain(fresh._id);
        expect(group.groupChat.participants.map((participant: { skillId: string }) => participant.skillId)).not.toContain(oldId);
        expect(await installRow()).toMatchObject({ partial: false, status: "installed" });
    });

    const participantIds = (group: { groupChat: { participants: { skillId: string }[] } }) =>
        group.groupChat.participants.map((participant) => participant.skillId);

    it("gives each of two deleted skills its own replacement after the owner reordered the group", async () => {
        const file = await breakSkills(["a", "b"]);
        const group = await groupRow();
        const [oldA, oldB] = participantIds(group);

        await run(
            async (context) =>
                await context.db.patch("threads", group._id, {
                    groupChat: { ...group.groupChat, participants: group.groupChat.participants.toReversed() },
                }),
        );

        await expect(repair(file)).resolves.toMatchObject({ status: "installed", unmatchedGroups: [] });

        const freshA = await skillBySlug("a");
        const freshB = await skillBySlug("b");

        expect(participantIds(await groupRow())).toEqual([freshB._id, freshA._id]);
        expect(oldA).not.toBe(freshA._id);
        expect(oldB).not.toBe(freshB._id);
        expect(await installRow()).toMatchObject({ partial: false, status: "installed" });
    });

    it("remaps on the next call when a repair stopped after its last skill was made", async () => {
        const file = await breakSkills(["a"]);
        const oldId = participantIds(await groupRow())[0];
        const remap = registry.get("plugins_repair_resume:remapGroupParticipants") as { handler?: unknown } | undefined;

        expect(remap).toBeDefined();

        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        let first = true;

        // The first remap throws once, after the skill was made and linked.
        const original = (remap as { handler: (...args: unknown[]) => Promise<unknown> }).handler;

        (remap as { handler: unknown }).handler = async (...args: unknown[]) => {
            if (first) {
                first = false;
                throw new Error("interrupted");
            }

            return await original(...args);
        };

        try {
            await expect(repair(file)).rejects.toThrow();
            expect(participantIds(await groupRow())).toContain(oldId);

            // The install is left for repair, with the recreated skill linked: nothing is missing now.
            const install = await installRow();

            await run(async (context) => await context.db.patch("pluginInstalls", install._id, { status: "needs-repair" }));
            await expect(repair(file)).resolves.toMatchObject({ created: [], status: "installed", unmatchedGroups: [] });
        } finally {
            (remap as { handler: unknown }).handler = original;
            spy.mockRestore();
        }

        const fresh = await skillBySlug("a");

        expect(participantIds(await groupRow())).toContain(fresh._id);
        expect(participantIds(await groupRow())).not.toContain(oldId);
        expect(await installRow()).toMatchObject({ partial: false, status: "installed" });
    });

    it("leaves the install partial when a gone participant has no mapping", async () => {
        const file = await breakSkills([]);
        const group = await groupRow();
        const outside = "kd7outsideskillthatwasdeleted";

        await run(
            async (context) =>
                await context.db.patch("threads", group._id, {
                    groupChat: {
                        ...group.groupChat,
                        participants: [...group.groupChat.participants, { addedAt: 1, skillId: outside }],
                    },
                }),
        );
        const install = await installRow();

        await run(async (context) => await context.db.patch("pluginInstalls", install._id, { status: "needs-repair" }));

        await expect(repair(file)).resolves.toMatchObject({ status: "installed", unmatchedGroups: ["group:panel"] });
        expect(await installRow()).toMatchObject({ partial: true, status: "installed" });
    });
});
