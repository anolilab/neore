/**
 * The GDPR export must contain EVERY message of every thread the user owns.
 *
 * It runs inside a workflow with no user identity. It used to read through the
 * public `listThreadsByUserId` / `listMessagesByThreadId`, which answer an
 * identity-less caller with an empty page — so exports shipped with no
 * conversations at all, and nothing noticed.
 *
 * 36 messages across three threads, deliberately past 25: a 12-row fixture
 * cannot tell a complete read from one capped at a default page size.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";

import { listMessagesByThreadIdAdmitted } from "../agent/messages";
import { getThreadInternal, listThreadsByUserIdInternal } from "../agent/threads";
import schema from "../schema";
import { collectConversations, collectThreadTags } from "./steps";

/**
 * The harness's `ctx.runQuery` takes the REGISTERED procedure object, not a
 * generated `{ __lunoraRef }`. Route `internal.<module>.<fn>` to the real
 * procedures so the step under test runs unmodified.
 */
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const THREADS = 3;
const MESSAGES_PER_THREAD = 12;

describe("collectConversations", () => {
    it("exports all messages of all the user's threads, and nobody else's", async () => {
        registry.set("agent_messages:listMessagesByThreadIdAdmitted", listMessagesByThreadIdAdmitted);
        registry.set("agent_threads:listThreadsByUserIdInternal", listThreadsByUserIdInternal);
        registry.set("gdpr_steps:collectThreadTags", collectThreadTags);

        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                for (let t = 0; t < THREADS; t += 1) {
                    const threadId = await context.db.insert("threads", { status: "active", title: `Thread ${String(t)}`, userId: "user-1" });

                    for (let m = 0; m < MESSAGES_PER_THREAD; m += 1) {
                        await context.db.insert("messages", {
                            // The first message of the first thread carries an imported display time.
                            ...(t === 0 && m === 0 && { createdAt: 1_600_000_000_000 }),
                            message: { content: `t${String(t)}-m${String(m)}`, role: m % 2 === 0 ? "user" : "assistant" },
                            order: m,
                            status: "success",
                            stepOrder: 0,
                            text: `t${String(t)}-m${String(m)}`,
                            threadId,
                            tool: false,
                            userId: "user-1",
                        });
                    }
                }

                const otherThread = await context.db.insert("threads", { status: "active", title: "Not mine", userId: "user-2" });

                await context.db.insert("messages", {
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    text: "someone else",
                    threadId: otherThread,
                    tool: false,
                    userId: "user-2",
                });
            });

            // Internal functions are unreachable from the harness's external
            // boundary, as in production — dispatch it the way the workflow does.
            const conversations = await harness.action(async (context: any) => await context.runAction(collectConversations, { userId: "user-1" }));
            const exported = conversations as { messages: { text?: string }[]; thread: { title?: string } }[];

            expect(exported).toHaveLength(THREADS);
            expect(exported.flatMap((conversation) => conversation.messages)).toHaveLength(THREADS * MESSAGES_PER_THREAD);
            expect(exported.map((conversation) => conversation.thread.title)).not.toContain("Not mine");

            // The row has no role column; the export reads it from the stored UI message so a re-import can tell a reply that opens its own order from a prompt.
            const first = exported.find((conversation) => conversation.messages[0]?.text === "t0-m0");
            const roles = first?.messages.map((message) => (message as { role?: string }).role);
            const times = first?.messages.map((message) => (message as { createdAt?: number }).createdAt);

            expect(roles?.slice(0, 2)).toEqual(["user", "assistant"]);
            // A re-import keeps an imported message's source time; a row without one falls back to its creation time.
            expect(times?.[0]).toBe(1_600_000_000_000);
            expect(times?.[1]).toBeGreaterThan(1_600_000_000_000);

            for (const conversation of exported) {
                // Ascending, complete, in order.
                expect(conversation.messages.map((message) => message.text?.split("-", 2)[1])).toEqual(
                    Array.from({ length: MESSAGES_PER_THREAD }, (_unused, index) => `m${String(index)}`),
                );
            }
        } finally {
            harness.close();
        }
    });
    it("exports each message's parent and each thread's active leaf, so a re-import can keep the active branch", async () => {
        registry.set("agent_messages:listMessagesByThreadIdAdmitted", listMessagesByThreadIdAdmitted);
        registry.set("agent_threads:listThreadsByUserIdInternal", listThreadsByUserIdInternal);
        registry.set("gdpr_steps:collectThreadTags", collectThreadTags);

        const harness = lunoraTest(schema as never);

        try {
            const ids: Record<string, string> = {};

            await harness.run(async (context: any) => {
                // A prompt with two replies (a regenerate); the switcher points at the second.
                const threadId = await context.db.insert("threads", { status: "active", title: "Branched", userId: "user-b" });

                ids.thread = String(threadId);
                const prompt = await context.db.insert("messages", {
                    message: { content: "Plan", role: "user" },
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    text: "Plan",
                    threadId,
                    tool: false,
                    userId: "user-b",
                });
                const first = await context.db.insert("messages", {
                    message: { content: "A", role: "assistant" },
                    order: 0,
                    parentMessageId: prompt,
                    status: "success",
                    stepOrder: 1,
                    text: "A",
                    threadId,
                    tool: false,
                    userId: "user-b",
                });
                const second = await context.db.insert("messages", {
                    message: { content: "B", role: "assistant" },
                    order: 0,
                    parentMessageId: prompt,
                    status: "success",
                    stepOrder: 1,
                    text: "B",
                    threadId,
                    tool: false,
                    userId: "user-b",
                });

                await context.db.patch(threadId, { activeLeafMessageId: second });
                ids.first = String(first);
                ids.second = String(second);
                ids.prompt = String(prompt);

                const plain = await context.db.insert("threads", { status: "active", title: "Plain", userId: "user-b" });

                await context.db.insert("messages", {
                    message: { content: "Hi", role: "user" },
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    text: "Hi",
                    threadId: plain,
                    tool: false,
                    userId: "user-b",
                });
                ids.plain = String(plain);
            });

            const conversations = await harness.action(async (context: any) => await context.runAction(collectConversations, { userId: "user-b" }));
            const exported = conversations as {
                messages: { _id: string; parentMessageId?: string; text?: string }[];
                thread: { _id: string; activeLeafMessageId?: string; title?: string };
            }[];

            const branched = exported.find((conversation) => conversation.thread.title === "Branched");
            const plain = exported.find((conversation) => conversation.thread.title === "Plain");

            // The ids in the export resolve within the same export: the leaf and the parents name exported rows.
            expect(branched?.thread._id).toBe(ids.thread);
            expect(branched?.thread.activeLeafMessageId).toBe(ids.second);
            expect(branched?.messages.map((message) => message._id)).toEqual(expect.arrayContaining([ids.prompt, ids.first, ids.second]));
            expect(branched?.messages.find((message) => message._id === ids.first)?.parentMessageId).toBe(ids.prompt);
            expect(branched?.messages.find((message) => message._id === ids.second)?.parentMessageId).toBe(ids.prompt);
            expect(branched?.messages.find((message) => message._id === ids.prompt)?.parentMessageId).toBeUndefined();

            // A thread that never branched has no leaf, and its rows have no parent.
            expect(plain?.thread._id).toBe(ids.plain);
            expect(plain?.thread.activeLeafMessageId).toBeUndefined();
            expect(plain?.messages.every((message) => message.parentMessageId === undefined)).toBe(true);
        } finally {
            harness.close();
        }
    });
});

/**
 * A locked chat is the owner's own data-access right: the export carries its
 * title and every message, while the list stays a stub for clients. The lock
 * protects against someone using an already-signed-in browser, not against the
 * owner's export (plan note, GDPR open question 5). The export is only ever
 * built for the user the workflow names, so another user's locked chat stays out.
 */
describe("collectConversations: a locked chat", () => {
    const LOCKED_TITLE = "Secret plan";

    const registerReaders = () => {
        registry.set("agent_messages:listMessagesByThreadIdAdmitted", listMessagesByThreadIdAdmitted);
        registry.set("agent_threads:listThreadsByUserIdInternal", listThreadsByUserIdInternal);
        registry.set("agent_threads:getThreadInternal", getThreadInternal);
        registry.set("gdpr_steps:collectThreadTags", collectThreadTags);
    };

    it("exports the owner's locked chat with its title and every message", async () => {
        registerReaders();

        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                const threadId = await context.db.insert("threads", { lockedAt: 1_700_000_000_000, status: "active", title: LOCKED_TITLE, userId: "user-1" });

                for (let m = 0; m < 3; m += 1) {
                    await context.db.insert("messages", {
                        message: { content: `secret-${String(m)}`, role: "user" },
                        order: m,
                        status: "success",
                        stepOrder: 0,
                        text: `secret-${String(m)}`,
                        threadId,
                        tool: false,
                        userId: "user-1",
                    });
                }
            });

            const conversations = (await harness.action(async (context: any) => await context.runAction(collectConversations, { userId: "user-1" }))) as {
                messages: { text?: string }[];
                thread: { title?: string };
            }[];
            const locked = conversations.find((conversation) => conversation.thread.title === LOCKED_TITLE);

            expect(locked?.messages.map((message) => message.text)).toEqual(["secret-0", "secret-1", "secret-2"]);
        } finally {
            harness.close();
        }
    });

    it("does not export a locked chat to another user", async () => {
        registerReaders();

        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                await context.db.insert("threads", { lockedAt: 1_700_000_000_000, status: "active", title: LOCKED_TITLE, userId: "user-1" });
                await context.db.insert("threads", { status: "active", title: "Mine", userId: "user-2" });
            });

            const conversations = (await harness.action(async (context: any) => await context.runAction(collectConversations, { userId: "user-2" }))) as {
                thread: { title?: string };
            }[];

            expect(conversations.map((conversation) => conversation.thread.title)).toEqual(["Mine"]);
        } finally {
            harness.close();
        }
    });
});
