/**
 * `searchPastChats` backs the agent's `searchPastChats` tool: the caller's own typed words from their other chats, as
 * title, day and excerpt, never a reply, another person's row, the chat it answers in or a locked chat.
 */
import { lunoraTest } from "@lunora/testing";
import { LunoraError, v } from "lunorash/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internalQuery } from "../lib/crpc";
import schema from "../schema";
import { typedTextColumn } from "../agent/shared";
import { searchPastChats } from "./past-chats";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "bots_functions", await import("../bots/functions"));
}, 30_000);

vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

const OWNER = "user-owner";
const OTHER = "user-other";
const SENT_AT = Date.UTC(2026, 2, 4, 23, 30);
const NOW = Date.UTC(2026, 3, 1);

type Hit = { sentAt: number; snippet: string; title: string };
type Result = { hits: Hit[]; preparing?: true; truncated?: true; unavailable?: string };

const insertPrompt = (context: any, fields: { createdAt?: number; order?: number; role?: string; text: string; threadId: string; userId?: string }) => {
    const role = fields.role ?? "user";
    const typedText = typedTextColumn({ content: fields.text, role } as never, fields.text);

    return context.db.insert("messages", {
        createdAt: fields.createdAt ?? SENT_AT,
        message: { content: fields.text, role },
        ...(typedText !== undefined && { typedText }),
        order: fields.order ?? 0,
        status: "success",
        stepOrder: 0,
        text: fields.text,
        threadId: fields.threadId,
        tool: false,
        userId: fields.userId ?? OWNER,
    });
};

const insertThread = (
    context: any,
    fields: { botId?: string; externalThreadId?: string; isPublic?: boolean; lockedAt?: number; tags?: string[]; title: string; userId?: string },
) => context.db.insert("threads", { model: "gpt-4o", status: "active", tags: ["chat"], userId: OWNER, ...fields });

/** An untagged chat (as a branch, side chat or import is created), with one link per entry of `links`, in order. */
const insertUntaggedThread = async (
    context: any,
    title: string,
    parentThreadId?: string,
    options: { createdBy?: string; links?: ("branch" | "comparison" | "side" | undefined)[] } = {},
) => {
    const threadId = await context.db.insert("threads", {
        model: "gpt-4o",
        status: "active",
        title,
        userId: OWNER,
        ...(options.createdBy !== undefined && { createdBy: options.createdBy }),
    });

    if (parentThreadId !== undefined) {
        const links = options.links ?? ["branch"];

        for (const [index, branchType] of links.entries()) {
            await context.db.insert("threadRelationships", {
                ...(branchType !== undefined && { branchType }),
                createdAt: index,
                parentThreadId,
                threadId,
                userId: OWNER,
            });
        }
    }

    return threadId;
};

const withMemory = (context: any, memoryEnabled = true) => context.db.insert("userSettings", { memoryEnabled, userId: OWNER });

const searchIn = (harness: ReturnType<typeof lunoraTest>, args: { limit?: number; query: string; threadId: string }) =>
    harness.run(async (context: any) => (await context.runQuery(searchPastChats, { now: NOW, userId: OWNER, ...args })) as Result);

describe("searchPastChats", () => {
    it("returns the caller's own typed words from their other private chats, with title, send time and excerpt", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context);

                const here = await insertThread(context, { title: "Today" });
                const trip = await insertThread(context, { title: "Trip planning" });
                const locked = await insertThread(context, { lockedAt: 1, title: "Locked" });
                const theirs = await insertThread(context, { title: "Theirs", userId: OTHER });
                const botChat = await insertThread(context, { botId: "bot-1", title: "Bot chat" });
                const branch = await insertThread(context, { title: "Branch of today" });

                await insertPrompt(context, { text: "we booked the Lisbon apartment near Alfama", threadId: trip });
                await insertPrompt(context, { order: 1, role: "assistant", text: "Lisbon replies are not the user's words", threadId: trip });
                await insertPrompt(context, { text: "Lisbon again, asked here", threadId: here });
                // A branch's copy of this chat's prompt: the same words, sent at the same time.
                await insertPrompt(context, { text: "Lisbon again, asked here", threadId: branch });
                await insertPrompt(context, { text: "Lisbon secret in a locked chat", threadId: locked });
                await insertPrompt(context, { text: "Lisbon from someone else", threadId: theirs, userId: OTHER });
                await insertPrompt(context, { text: "Lisbon in another bot's chat", threadId: botChat });

                return here;
            });

            const expected = { hits: [{ sentAt: SENT_AT, snippet: "we booked the Lisbon apartment near Alfama", title: "Trip planning" }] };

            expect(await searchIn(harness, { query: "Lisbon", threadId: current })).toStrictEqual(expected);
            // Every word of the query must be in the prompt, as the index matches.
            expect(await searchIn(harness, { query: "Alfama Lisbon", threadId: current })).toStrictEqual(expected);
            expect(await searchIn(harness, { query: "Alfama zebra", threadId: current })).toStrictEqual({ hits: [] });
        } finally {
            harness.close();
        }
    });

    it("in a bot's chat, reads that bot's chats and the chats with no bot, not another bot's", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context);

                const bot = await context.db.insert("bots", {
                    computerEnabled: false,
                    createdAt: 0,
                    instructions: "Be brief.",
                    model: "gpt-4o",
                    name: "Helper",
                    updatedAt: 0,
                    userId: OWNER,
                });
                const here = await insertThread(context, { botId: bot, title: "Today" });

                await insertPrompt(context, {
                    createdAt: SENT_AT + 2,
                    text: "Lisbon with the bot",
                    threadId: await insertThread(context, { botId: bot, title: "Bot" }),
                });
                await insertPrompt(context, {
                    createdAt: SENT_AT + 1,
                    text: "Lisbon without a bot",
                    threadId: await insertThread(context, { title: "Plain" }),
                });
                await insertPrompt(context, {
                    text: "Lisbon with another bot",
                    threadId: await insertThread(context, { botId: "bot-other", title: "Other bot" }),
                });

                return here;
            });

            const { hits } = await searchIn(harness, { query: "Lisbon", threadId: current });

            expect(hits.map((hit) => hit.title).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["Bot", "Plain"]);
        } finally {
            harness.close();
        }
    });

    it("reads only chats a person types into, and their branches: no messenger, sub-agent, worker, task, trigger, eval, pull request or import chat", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context);

                const here = await insertThread(context, { title: "Today" });
                const sources: { externalThreadId?: string; tags?: string[]; title: string }[] = [
                    { externalThreadId: "slack:C1:1799999000.000001", title: "Messenger" },
                    { tags: ["sub-agent"], title: "Sub-agent" },
                    { tags: ["sub-agent", "worker"], title: "Worker" },
                    { tags: ["task"], title: "Task" },
                    { tags: ["trigger"], title: "Trigger" },
                    { tags: ["eval"], title: "Eval" },
                    // A pull request chat opens with a message the server writes.
                    { tags: ["chat", "develop"], title: "Pull request" },
                    { tags: ["chat", "kind-added-later"], title: "Unknown kind" },
                ];

                for (const [index, source] of sources.entries()) {
                    await insertPrompt(context, {
                        createdAt: SENT_AT + index,
                        text: `Lisbon from ${source.title}`,
                        threadId: await insertThread(context, source),
                    });
                }

                const plain = await insertThread(context, { title: "Plain" });
                const task = await insertThread(context, { tags: ["task"], title: "Task parent" });

                await insertPrompt(context, { createdAt: SENT_AT + 10, text: "Lisbon typed by the user", threadId: plain });
                await insertPrompt(context, {
                    createdAt: SENT_AT + 11,
                    text: "Lisbon typed in a branch",
                    threadId: await insertUntaggedThread(context, "Branch", plain),
                });
                await insertPrompt(context, {
                    createdAt: SENT_AT + 12,
                    text: "Lisbon copied from a task",
                    threadId: await insertUntaggedThread(context, "Branch of a task", task),
                });
                await insertPrompt(context, { createdAt: SENT_AT + 13, text: "Lisbon imported", threadId: await insertUntaggedThread(context, "Import") });

                return here;
            });

            const { hits } = await searchIn(harness, { query: "Lisbon", threadId: current });

            expect(hits.map((hit) => hit.title).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["Branch", "Plain"]);
        } finally {
            harness.close();
        }
    });

    it("searches nothing from a sub-agent's or worker's chat, whose result is posted where others may read it", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const children = await harness.run(async (context: any) => {
                await withMemory(context);
                await insertPrompt(context, { text: "Lisbon apartment", threadId: await insertThread(context, { title: "Other" }) });

                return [
                    await insertThread(context, { tags: ["sub-agent"], title: "Sub-agent" }),
                    await insertThread(context, { tags: ["sub-agent", "worker"], title: "Worker" }),
                ];
            });

            for (const threadId of children) {
                expect(await searchIn(harness, { query: "Lisbon", threadId })).toStrictEqual({ hits: [], unavailable: "background_run" });
            }
        } finally {
            harness.close();
        }
    });

    it("answers in no chat shared with someone a moment ago", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context);

                const here = await insertThread(context, { title: "Today" });

                await insertPrompt(context, { text: "Lisbon apartment", threadId: await insertThread(context, { title: "Other" }) });
                await context.db.insert("threadAccess", {
                    grantedAt: NOW - 1,
                    grantedBy: OWNER,
                    ownerId: OWNER,
                    permission: "read",
                    threadId: here,
                    userId: OTHER,
                });

                return here;
            });

            expect(await searchIn(harness, { query: "Lisbon", threadId: current })).toStrictEqual({ hits: [], unavailable: "not_private" });
        } finally {
            harness.close();
        }
    });

    it("trusts only the server's copy links: a link the owner can write and an import are no source, a branch behind another link is", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context);

                const here = await insertThread(context, { title: "Today" });
                const plain = await insertThread(context, { title: "Plain" });
                const rows: [string, Parameters<typeof insertUntaggedThread>[3]][] = [
                    // What the public relationship mutation can write.
                    ["Comparison link", { links: ["comparison"] }],
                    ["Untyped link", { links: [undefined] }],
                    // An import linked to a chat, even through a branch link.
                    ["Import", { createdBy: "import:chatgpt", links: ["comparison"] }],
                    ["Import as branch", { createdBy: "import:chatgpt", links: ["branch"] }],
                    // A real branch whose first link is not a copy link.
                    ["Branch behind a comparison", { links: ["comparison", "branch"] }],
                    ["Side chat", { links: ["side"] }],
                ];

                for (const [index, [title, options]] of rows.entries()) {
                    await insertPrompt(context, {
                        createdAt: SENT_AT + index,
                        text: `Lisbon in ${title}`,
                        threadId: await insertUntaggedThread(context, title, plain, options),
                    });
                }

                return here;
            });

            const { hits } = await searchIn(harness, { query: "Lisbon", threadId: current });

            expect(hits.map((hit) => hit.title).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["Branch behind a comparison", "Side chat"]);
        } finally {
            harness.close();
        }
    });

    it("does not call a full window cut short when it gave every hit asked for", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context);

                const here = await insertThread(context, { title: "Today" });

                // A common word: more matching prompts than the first index window reads.
                for (let index = 0; index < 120; index += 1) {
                    await insertPrompt(context, {
                        createdAt: SENT_AT + index,
                        text: `common word ${String(index)}`,
                        threadId: await insertThread(context, { title: `Chat ${String(index)}` }),
                    });
                }

                return here;
            });

            const result = await searchIn(harness, { query: "common", threadId: current });

            expect(result.hits).toHaveLength(5);
            expect(result).not.toHaveProperty("truncated");
        } finally {
            harness.close();
        }
    });

    it("caps the hits at 8 whatever the limit asks, and returns 5 by default", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context);

                const here = await insertThread(context, { title: "Today" });

                for (let index = 0; index < 12; index += 1) {
                    const thread = await insertThread(context, { title: `Chat ${String(index)}` });

                    await insertPrompt(context, { createdAt: SENT_AT + index, text: `migration step ${String(index)}`, threadId: thread });
                }

                return here;
            });

            const capped = await searchIn(harness, { limit: 50, query: "migration", threadId: current });
            const byDefault = await searchIn(harness, { query: "migration", threadId: current });

            expect(capped.hits).toHaveLength(8);
            expect(byDefault.hits).toHaveLength(5);
        } finally {
            harness.close();
        }
    });

    it("searches nothing while memory is off", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context, false);

                const here = await insertThread(context, { title: "Today" });
                const other = await insertThread(context, { title: "Other" });

                await insertPrompt(context, { text: "Lisbon apartment", threadId: other });

                return here;
            });

            expect(await searchIn(harness, { query: "Lisbon", threadId: current })).toStrictEqual({ hits: [], unavailable: "memory_off" });
        } finally {
            harness.close();
        }
    });

    it("answers in no chat other people can read", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context);

                const here = await insertThread(context, { isPublic: true, title: "Shared" });
                const other = await insertThread(context, { title: "Other" });

                await insertPrompt(context, { text: "Lisbon apartment", threadId: other });

                return here;
            });

            expect(await searchIn(harness, { query: "Lisbon", threadId: current })).toStrictEqual({ hits: [], unavailable: "not_private" });
        } finally {
            harness.close();
        }
    });
});

describe("searchPastChats while the typed-words index is still being built", () => {
    const key = "agent_messages:typedTextSearch";

    const searchFailingWith = async (error: Error) => {
        const harness = lunoraTest(schema as never);
        const textSearch = registry.get(key);

        registry.set(
            key,
            internalQuery.input({ limit: v.number(), text: v.string(), userId: v.string() }).query(async () => {
                throw error;
            }),
        );

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context);

                return insertThread(context, { title: "Today" });
            });

            return await searchIn(harness, { query: "Lisbon", threadId: current });
        } finally {
            registry.set(key, textSearch);
            harness.close();
        }
    };

    it("answers preparing, with no hits", async () => {
        expect(await searchFailingWith(new LunoraError("SEARCH_INDEX_BUILDING", "search index is still backfilling"))).toStrictEqual({
            hits: [],
            preparing: true,
        });
    });

    it("still fails on any other index error", async () => {
        await expect(searchFailingWith(new LunoraError("INTERNAL", "boom"))).rejects.toThrow("boom");
    });

    it("says the search was cut short when the widest index window was full", async () => {
        const harness = lunoraTest(schema as never);
        const textSearch = registry.get(key);

        registry.set(
            key,
            internalQuery.input({ limit: v.number(), text: v.string(), userId: v.string() }).query(async () => {
                return { filled: true, messages: [] };
            }),
        );

        try {
            const current = await harness.run(async (context: any) => {
                await withMemory(context);

                return insertThread(context, { title: "Today" });
            });

            expect(await searchIn(harness, { query: "Lisbon", threadId: current })).toStrictEqual({ hits: [], truncated: true });
        } finally {
            registry.set(key, textSearch);
            harness.close();
        }
    });
});
