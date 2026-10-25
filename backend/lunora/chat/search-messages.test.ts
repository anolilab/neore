/**
 * `searchMessages` feeds the sidebar and the command palette, which open a hit in
 * the thread's displayed branch. So it returns only what that page can show: no
 * trashed thread, and no reply from a branch the thread is not on.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { textSearch } from "../agent/messages";
import schema from "../schema";
import { searchMessages } from "./functions";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
}, 30_000);

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

const OWNER = "user-owner";

const insertMessage = (context: any, threadId: string, order: number, parentMessageId?: string) =>
    context.db.insert("messages", {
        message: { content: "needle", role: order === 0 ? "user" : "assistant" },
        order,
        parentMessageId,
        status: "success",
        stepOrder: 0,
        text: "needle",
        threadId,
        tool: false,
        userId: OWNER,
    });

const search = async (harness: ReturnType<typeof lunoraTest>) => {
    const result: any = await harness
        .withIdentity({ userId: OWNER } as never)
        .query(searchMessages as never, { paginationOpts: { cursor: null, numItems: 10 }, searchQuery: "needle" } as never);

    return result.page as { _id: string; relevantMessages: { _id: string }[] }[];
};

describe("searchMessages", () => {
    it("skips a trashed thread and a reply from an inactive branch", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                const message = (threadId: string, order: number, parentMessageId?: string) => insertMessage(context, threadId, order, parentMessageId);
                const thread = (fields: { deleted?: boolean }) =>
                    context.db.insert("threads", { model: "gpt-4o", status: "active", title: "T", userId: OWNER, ...fields });

                const trashed = await thread({ deleted: true });

                await message(trashed, 0);

                const branched = await thread({});
                const prompt = await message(branched, 0);
                const inactive = await message(branched, 1, prompt);
                const active = await message(branched, 1, prompt);

                await context.db.patch(branched, { activeLeafMessageId: active });

                const abandoned = await thread({});
                const abandonedPrompt = await message(abandoned, 0);
                const abandonedReply = await message(abandoned, 1, abandonedPrompt);
                const kept = await message(abandoned, 1, abandonedPrompt);

                await context.db.patch(abandoned, { activeLeafMessageId: kept });

                const plain = await thread({});
                const plainMessage = await message(plain, 0);

                return { abandoned, abandonedReply, active, branched, inactive, kept, plain, plainMessage, prompt, trashed };
            });

            const page = await search(harness);
            const byThread = new Map(page.map((entry) => [entry._id, entry.relevantMessages.map((row) => row._id)]));

            expect(byThread.has(ids.trashed)).toBe(false);
            expect(byThread.get(ids.branched)).toHaveLength(2);
            expect(byThread.get(ids.branched)).toEqual(expect.arrayContaining([ids.prompt, ids.active]));
            expect(byThread.get(ids.abandoned)).not.toContain(ids.abandonedReply);
            expect(byThread.get(ids.abandoned)).toContain(ids.kept);
            expect(byThread.get(ids.plain)).toEqual([ids.plainMessage]);
        } finally {
            harness.close();
        }
    });

    it("finds an active hit that sits behind a full window of inactive ones", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                const message = (threadId: string, order: number, parentMessageId?: string) => insertMessage(context, threadId, order, parentMessageId);

                const thread = await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "T", userId: OWNER });
                const prompt = await message(thread, 0);
                const inactive: string[] = [];

                for (let i = 0; i < 110; i += 1) {
                    inactive.push(await message(thread, 1, prompt));
                }

                const active = await message(thread, 1, prompt);

                await context.db.patch(thread, { activeLeafMessageId: active });

                return { active, inactive, prompt, thread };
            });

            const page = await search(harness);
            const hit = page.find((entry) => entry._id === ids.thread);
            const hitIds = hit?.relevantMessages.map((row) => row._id) ?? [];

            expect(hitIds).toContain(ids.active);
            expect(hitIds).toContain(ids.prompt);
            expect(hitIds.some((id) => ids.inactive.includes(id))).toBe(false);
        } finally {
            harness.close();
        }
    });

    it("finds an unlocked hit that sits behind a full window of locked-thread hits", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                // The index returns the newest rows first, so the locked thread's later rows fill the window.
                const open = await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "T", userId: OWNER });
                const message = await insertMessage(context, open, 0);
                const locked = await context.db.insert("threads", { lockedAt: Date.now(), model: "gpt-4o", status: "active", title: "L", userId: OWNER });

                for (let i = 0; i < 110; i += 1) {
                    await insertMessage(context, locked, i);
                }

                return { locked, message, open };
            });

            const page = await search(harness);

            expect(page.map((entry) => entry._id)).toEqual([ids.open]);
            expect(page[0]?.relevantMessages.map((row) => row._id)).toEqual([ids.message]);
        } finally {
            harness.close();
        }
    });

    it("reports whether the index may hold more than the window returned", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                const thread = await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "T", userId: OWNER });

                for (let i = 0; i < 3; i += 1) {
                    await insertMessage(context, thread, i);
                }
            });

            const reach = (limit: number) =>
                harness.run(async (context: any) => await context.runQuery(textSearch, { limit, searchAllMessagesForUserId: OWNER, text: "needle" }));

            const everything: { filled: boolean; messages: unknown[] } = await reach(10);
            const capped: { filled: boolean; messages: unknown[] } = await reach(3);

            expect(everything.messages).toHaveLength(3);
            expect(everything.filled).toBe(false);
            expect(capped.filled).toBe(true);
        } finally {
            harness.close();
        }
    });
});
