/**
 * Group chats through an update, on the real action path: an update adds, rewrites and removes them. A group names its participants
 * by entry key, and a rewrite keeps its messages.
 */
import { lunoraTest } from "@lunora/testing";
import { isSelectableTextModel, MODEL_REGISTRY } from "@neore/ai/models";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import { schemaWithShardedTables } from "../lib/test-schema";
import { buildBundleMarkdown } from "../skills/bundle-format";
import { deleteAllForThreadIdAsync } from "../agent/threads";
import { groupFingerprint } from "../chat/group/fingerprint";
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
        throw new Error(`update-group.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

type PreviewResult = { generation: number; installId: string; plan: { action: string; entryKey: string }[] };
type UpdateResult = { applied: string[]; skipped: { action: string; entryKey: string }[]; version: string };

const OWNER = "owner-a";
const SLUG = "daily-brief";
const MODEL = MODEL_REGISTRY.find((definition) => isSelectableTextModel(definition))!.id;

const skill = (slug: string) => {
    return { description: `${slug} skill`, instructions: `Be the ${slug}.`, name: slug, slug };
};

interface GroupSpec {
    debateRounds?: number;
    mode?: "debate" | "parallel" | "round-robin" | "supervisor";
    participants: string[];
    synthesizer?: string;
    title: string;
}

/** A plugin file with the given skills and, optionally, one group chat under the key `panel`. */
const fileOf = async (slugs: string[], group: GroupSpec | undefined, version: string) => {
    const body = buildBundleMarkdown({
        description: "",
        items: [
            ...slugs.map((slug) => {
                return { key: slug, kind: "skill" as const, skill: skill(slug) };
            }),
            ...(group
                ? [
                      {
                          group: {
                              ...(group.debateRounds !== undefined && { debateRounds: group.debateRounds }),
                              mode: group.mode ?? ("round-robin" as const),
                              model: MODEL,
                              participants: group.participants,
                              ...(group.synthesizer !== undefined && { synthesizer: group.synthesizer }),
                              title: group.title,
                          },
                          key: "panel",
                          kind: "group" as const,
                      },
                  ]
                : []),
        ],
        name: "Daily brief",
    });
    const contentHash = await bodyHash(body);

    return { contentHash, markdown: withPluginHeader(body, { contentHash, slug: SLUG, version }) };
};

describe("plugin update with group chats", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory"]) as never);
    });

    afterEach(() => {
        harness.close();
    });

    const as = () => harness.withIdentity({ userId: OWNER } as never);
    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));
    const install = async (slugs: string[], group?: GroupSpec) => {
        const first = await fileOf(slugs, group, "1.0.0");

        await as().action(procedureAt("plugins_install_action", "installPlugin"), { contentHash: first.contentHash, markdown: first.markdown } as never);
    };
    const preview = async (next: { markdown: string }) =>
        (await as().action(procedureAt("plugins_update", "previewUpdate"), { markdown: next.markdown } as never)) as PreviewResult;
    const planOf = async (next: { markdown: string }) => {
        const planned = await preview(next);

        return planned.plan;
    };
    const update = async (next: { contentHash: string; markdown: string }) => {
        const planned = await preview(next);

        return (await as().action(procedureAt("plugins_update", "updatePlugin"), {
            confirmDowngrade: false,
            contentHash: next.contentHash,
            expectedGeneration: planned.generation,
            expectedInstallId: planned.installId,
            markdown: next.markdown,
        } as never)) as UpdateResult;
    };
    const installRow = async () =>
        await run(async (context) => {
            const { page } = await context.db.pluginInstalls.findMany({ where: { userId: OWNER } });

            return page[0];
        });
    const groups = async () =>
        await run(async (context) => {
            const { page } = await context.db.threads.findMany({ where: { userId: OWNER } });

            return page.filter((thread: { groupChat?: unknown }) => thread.groupChat);
        });
    const skillBySlug = async (slug: string) => await run(async (context) => await context.db.skills.findFirst({ where: { slug, userId: OWNER } }));
    const firstGroup = async () => {
        const [group] = await groups();

        return group;
    };
    const skillIdOf = async (slug: string) => {
        const row = await skillBySlug(slug);

        return row._id;
    };
    const markerOf = async (slug: string) => {
        const row = await skillBySlug(slug);

        return row.pluginMarker;
    };
    const links = async () =>
        await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { userId: OWNER } });

            return page;
        });
    const linkKeys = async () => {
        const rows = await links();

        return rows.map((link: { entryKey: string }) => link.entryKey).toSorted((a: string, b: string) => a.localeCompare(b));
    };
    const expectAllSame = async (next: { markdown: string }) => {
        const again = await preview(next);

        expect(again.plan.filter((step) => step.action !== "same")).toStrictEqual([]);
    };
    const addMessage = async (threadId: string) =>
        await run(async (context) => {
            await context.db.insert("messages", {
                message: { content: "hello", role: "user" },
                order: 0,
                status: "success",
                stepOrder: 0,
                text: "hello",
                threadId,
                tool: false,
                userId: OWNER,
            });
        });

    it("creates a group the new version adds, with the plugin's skills as participants, and a second preview is all same", async () => {
        await install(["analyst", "critic"]);

        const next = await fileOf(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" }, "1.1.0");

        expect(await planOf(next)).toContainEqual({ action: "create", entryKey: "group:panel" });

        const result = await update(next);

        expect(result).toMatchObject({ skipped: [], version: "1.1.0" });
        expect(result.applied).toContain("group:panel");

        const [group] = await groups();
        const analyst = await skillBySlug("analyst");
        const critic = await skillBySlug("critic");

        expect(group).toMatchObject({ groupChat: { mode: "round-robin" }, title: "Panel" });
        expect(group.groupChat.participants.map((participant: { skillId: string }) => participant.skillId)).toStrictEqual([analyst._id, critic._id]);
        expect(await installRow()).toMatchObject({ partial: false, status: "installed", version: "1.1.0" });
        await expectAllSame(next);
    });

    it("creates a group that names a skill the same update adds", async () => {
        await install(["analyst", "critic"]);

        const next = await fileOf(["analyst", "critic", "reviewer"], { participants: ["analyst", "reviewer"], title: "Panel" }, "1.1.0");
        const result = await update(next);

        expect(result.skipped).toStrictEqual([]);

        const [group] = await groups();
        const reviewer = await skillBySlug("reviewer");

        expect(group.groupChat.participants.map((participant: { skillId: string }) => participant.skillId)).toContain(reviewer._id);
        await expectAllSame(next);
    });

    it("rewrites a changed group in place, keeps its messages, and a second preview is all same", async () => {
        await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

        const [before] = await groups();

        await addMessage(before._id);

        const next = await fileOf(
            ["analyst", "critic", "reviewer"],
            { mode: "parallel", participants: ["analyst", "critic", "reviewer"], synthesizer: "critic", title: "Review board" },
            "1.1.0",
        );

        expect(await planOf(next)).toContainEqual({ action: "update", entryKey: "group:panel" });

        const result = await update(next);

        expect(result).toMatchObject({ skipped: [], version: "1.1.0" });
        expect(result.applied).toContain("group:panel");

        const after = await groups();

        expect(after).toHaveLength(1);
        expect(after[0]._id).toBe(before._id);
        expect(after[0]).toMatchObject({ groupChat: { mode: "parallel" }, title: "Review board" });
        expect(after[0].groupChat.participants).toHaveLength(3);
        expect(after[0].groupChat.synthesizerSkillId).toBe(await skillIdOf("critic"));

        const { page: messages } = await run(async (context) => await context.db.messages.findMany({ where: { threadId: before._id } }));

        expect(messages).toHaveLength(1);
        expect(await installRow()).toMatchObject({ partial: false, status: "installed" });
        await expectAllSame(next);
    });

    it("keeps a group the person edited, and reports it", async () => {
        await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

        const [before] = await groups();

        await run(async (context) => await context.db.patch("threads", before._id, { title: "My own title" }));

        const next = await fileOf(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Renamed" }, "1.1.0");

        expect(await planOf(next)).toContainEqual({ action: "keep-edited", entryKey: "group:panel" });

        const result = await update(next);

        expect(result.skipped).toContainEqual({ action: "keep-edited", entryKey: "group:panel" });
        expect(await firstGroup()).toMatchObject({ pluginMarker: before.pluginMarker, title: "My own title" });
    });

    it("deletes a dropped group with no messages, with its link, and leaves the skills linked", async () => {
        await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

        const next = await fileOf(["analyst", "critic"], undefined, "1.1.0");

        expect(await planOf(next)).toContainEqual({ action: "delete", entryKey: "group:panel" });

        const result = await update(next);

        expect(result).toMatchObject({ skipped: [], version: "1.1.0" });
        expect(result.applied).toContain("group:panel");
        expect(await groups()).toHaveLength(0);
        expect(await linkKeys()).toStrictEqual(["skill:analyst", "skill:critic"]);
        expect(await markerOf("critic")).toBeTruthy();
        expect(await installRow()).toMatchObject({ partial: false, status: "installed" });
        await expectAllSame(next);
    });

    it("keeps and detaches a dropped group that has a message, and its skills stay in the plugin when the file keeps them", async () => {
        await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

        const [before] = await groups();

        await addMessage(before._id);

        const result = await update(await fileOf(["analyst", "critic"], undefined, "1.1.0"));

        expect(result.skipped).toContainEqual({ action: "delete", entryKey: "group:panel" });

        const [kept] = await groups();

        expect(kept).toMatchObject({ _id: before._id, pluginInstallId: "", pluginMarker: "" });
        expect(await linkKeys()).toStrictEqual(["skill:analyst", "skill:critic"]);
        expect(await markerOf("analyst")).toBeTruthy();
        expect(await markerOf("critic")).toBeTruthy();
        expect(await installRow()).toMatchObject({ partial: true, status: "installed" });
    });

    describe("the group delete fence", () => {
        const deletePage = async (args: Record<string, unknown>) =>
            await run(async (context) => await context.runMutation(deleteAllForThreadIdAsync, { detachSkills: false, ...args } as never));

        it("deletes the group when the generation and fingerprint still match", async () => {
            await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

            const group = await firstGroup();
            const row = await installRow();
            const page = await deletePage({
                expectedGroupFingerprint: groupFingerprint(group),
                pluginGeneration: row.generation,
                pluginInstallId: row._id,
                threadId: group._id,
            });

            expect(page.kept).toBeUndefined();
            expect(await groups()).toHaveLength(0);
        });

        it("keeps a group the owner edited after retire decided to delete it", async () => {
            await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

            const group = await firstGroup();
            const row = await installRow();
            const judged = groupFingerprint(group);

            await run(async (context) => await context.db.patch("threads", group._id, { title: "My own title" }));

            const page = await deletePage({
                expectedGroupFingerprint: judged,
                pluginGeneration: row.generation,
                pluginInstallId: row._id,
                threadId: group._id,
            });

            expect(page).toMatchObject({ isDone: true, kept: true });
            expect(await firstGroup()).toMatchObject({ _id: group._id, pluginInstallId: "", pluginMarker: "", title: "My own title" });
        });

        it("keeps a group when another action took the install over", async () => {
            await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

            const group = await firstGroup();
            const row = await installRow();
            const page = await deletePage({
                pluginGeneration: row.generation + 1,
                pluginInstallId: row._id,
                threadId: group._id,
            });

            expect(page).toMatchObject({ isDone: true, kept: true });
            expect(await firstGroup()).toMatchObject({ _id: group._id, pluginInstallId: "" });
        });

        it("never stops a later page", async () => {
            await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

            const group = await firstGroup();
            const row = await installRow();
            const page = await deletePage({
                expectedGroupFingerprint: "stale",
                messagesDone: true,
                pinsDone: true,
                pluginGeneration: row.generation + 1,
                pluginInstallId: row._id,
                streamsDone: true,
                threadId: group._id,
            });

            expect(page.kept).toBeUndefined();
            expect(page.isDone).toBe(true);
        });
    });

    it("a message that lands before the delete keeps the group detached, and the plugin's skills keep their links and markers", async () => {
        await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

        const [group] = await groups();
        const { _id: installId } = await installRow();

        await addMessage(group._id);

        const page = await run(
            async (context) => await context.runMutation(deleteAllForThreadIdAsync, { detachSkills: false, pluginInstallId: installId, threadId: group._id }),
        );

        expect(page).toMatchObject({ isDone: true, kept: true });
        expect(await firstGroup()).toMatchObject({ _id: group._id, pluginInstallId: "", pluginMarker: "" });
        expect(await markerOf("analyst")).toBeTruthy();
        expect(await markerOf("critic")).toBeTruthy();
        expect(await linkKeys()).toStrictEqual(["group:panel", "skill:analyst", "skill:critic"]);
    });

    it("deletes a dropped skill that only a dropped group used", async () => {
        await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

        const result = await update(await fileOf(["analyst"], undefined, "1.1.0"));

        expect(result.skipped).toStrictEqual([]);
        expect(result.applied).toEqual(expect.arrayContaining(["group:panel", "skill:critic"]));
        expect(await groups()).toHaveLength(0);
        expect(await skillBySlug("critic")).toBeNull();
    });

    it("refuses before it writes when a group names a skill that is gone", async () => {
        await install(["analyst", "critic"]);

        const critic = await skillBySlug("critic");

        await run(async (context) => await context.db.delete("skills", critic._id));

        const next = await fileOf(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" }, "1.1.0");
        const planned = await preview(next);

        await expect(
            as().action(procedureAt("plugins_update", "updatePlugin"), {
                confirmDowngrade: false,
                contentHash: next.contentHash,
                expectedGeneration: planned.generation,
                expectedInstallId: planned.installId,
                markdown: next.markdown,
            } as never),
        ).rejects.toThrow("names a skill that is not in the plugin any more");
        expect(await installRow()).toMatchObject({ generation: planned.generation, status: "installed", version: "1.0.0" });
        expect(await groups()).toHaveLength(0);
    });

    it("removes a skill and adds a group of the same name in one update", async () => {
        await install(["analyst", "critic", "panel"]);

        const next = await fileOf(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" }, "1.1.0");
        const planned = await preview(next);

        expect(planned.plan).toContainEqual({ action: "delete", entryKey: "skill:panel" });

        const result = await update(next);

        expect(result.skipped).toStrictEqual([]);
        expect(await skillBySlug("panel")).toBeNull();
        expect(await groups()).toHaveLength(1);
        await expectAllSame(next);
    });

    it("after a failed group rewrite, repair marks the install partial, and running the update again finishes the group", async () => {
        await install(["analyst", "critic"], { participants: ["analyst", "critic"], title: "Panel" });

        const next = await fileOf(["analyst", "critic", "reviewer"], { participants: ["analyst", "critic", "reviewer"], title: "Review board" }, "1.1.0");
        const planned = await preview(next);
        const updateGroupChild = procedureAt("plugins_update_apply", "updateGroupChild") as { handler: (...args: unknown[]) => unknown };
        const spy = vi.spyOn(updateGroupChild, "handler").mockRejectedValueOnce(new Error("group write failed"));

        try {
            await expect(
                as().action(procedureAt("plugins_update", "updatePlugin"), {
                    confirmDowngrade: false,
                    contentHash: next.contentHash,
                    expectedGeneration: planned.generation,
                    expectedInstallId: planned.installId,
                    markdown: next.markdown,
                } as never),
            ).rejects.toThrow();
        } finally {
            spy.mockRestore();
        }

        // The new skill was created before the group failed, so the install is kept for repair with the new file.
        expect(await installRow()).toMatchObject({ contentHash: next.contentHash, status: "needs-repair" });

        const repaired = await as().action(procedureAt("plugins_repair_resume", "repairPlugin"), {
            contentHash: next.contentHash,
            markdown: next.markdown,
            pluginSlug: SLUG,
        } as never);

        expect(repaired).toMatchObject({ status: "installed" });
        expect(await installRow()).toMatchObject({ partial: true, status: "installed", version: "1.1.0" });
        expect(await firstGroup()).toMatchObject({ title: "Panel" });

        const again = await preview(next);

        expect(again.plan).toContainEqual({ action: "update", entryKey: "group:panel" });
        expect(again.plan).toContainEqual({ action: "same", entryKey: "skill:reviewer" });

        const finished = await update(next);

        expect(finished).toMatchObject({ skipped: [], version: "1.1.0" });
        expect(finished.applied).toContain("group:panel");
        expect(await installRow()).toMatchObject({ partial: false, status: "installed" });
        expect(await firstGroup()).toMatchObject({ title: "Review board" });
        await expectAllSame(next);
    });
});
