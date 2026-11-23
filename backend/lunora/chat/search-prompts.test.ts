/**
 * `searchSentPrompts` feeds the composer's Ctrl+R popup. It lists only the caller's own prompts (user rows of their
 * own threads), newest first, at most 50, and never a locked thread's prompt.
 */
import { lunoraTest } from "@lunora/testing";
import { v } from "lunorash/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internalQuery } from "../lib/crpc";
import schema from "../schema";
import { isSentPromptAvailable, SENT_PROMPT_LINEAGE_READS, searchSentPrompts } from "./functions";
import { typedTextColumn } from "../agent/shared";
import { documentTextPart, guestTextPart, typedTextOf } from "./lib/attached-text";
import { imagePromptPart } from "./lib/first-user-prompt";
import { GOAL_CONTINUATION_AGENT } from "./goals/shared";

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
const OTHER = "user-other";

const withTypedText = (message: unknown, text: string) => {
    const typedText = typedTextColumn(message as never, text);

    return typedText === undefined ? {} : { typedText };
};

/** A row as the writers save it: `text` as sent, `typedText` beside it (`typedTextColumn`). */
const insertMessage = (
    context: any,
    fields: {
        agentName?: string;
        content?: unknown;
        createdAt: number | undefined;
        order: number;
        role: string;
        text: string;
        threadId: string;
        userId: string;
    },
) =>
    context.db.insert("messages", {
        ...(fields.createdAt !== undefined && { createdAt: fields.createdAt }),
        message: { content: fields.content ?? fields.text, role: fields.role },
        ...withTypedText({ content: fields.content ?? fields.text, role: fields.role }, fields.text),
        order: fields.order,
        status: "success",
        stepOrder: 0,
        text: fields.text,
        threadId: fields.threadId,
        tool: false,
        userId: fields.userId,
        ...(fields.agentName !== undefined && { agentName: fields.agentName }),
    });

const insertThread = (context: any, fields: { deleted?: boolean; isTemporary?: boolean; lockedAt?: number; title: string; userId: string }) =>
    context.db.insert("threads", { model: "gpt-4o", status: "active", ...fields });

const search = async (harness: ReturnType<typeof lunoraTest>, searchQuery: string, userId = OWNER) => {
    const result: any = await harness.withIdentity({ userId } as never).query(searchSentPrompts as never, { searchQuery } as never);

    return result.prompts as { createdAt?: number; draftFrom?: string; messageId: string; text: string; threadId: string; threadTitle: string }[];
};

describe("searchSentPrompts", () => {
    it("lists the caller's sent prompts from two threads, newest first, and nothing else", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                const deploys = await insertThread(context, { title: "Release", userId: OWNER });
                const notes = await insertThread(context, { title: "Notes", userId: OWNER });
                const theirs = await insertThread(context, { title: "Theirs", userId: OTHER });

                const older = await insertMessage(context, {
                    createdAt: 100,
                    order: 0,
                    role: "user",
                    text: "deploy the staging build",
                    threadId: deploys,
                    userId: OWNER,
                });
                const reply = await insertMessage(context, {
                    createdAt: 110,
                    order: 1,
                    role: "assistant",
                    text: "deploy finished",
                    threadId: deploys,
                    userId: OWNER,
                });
                const newer = await insertMessage(context, {
                    createdAt: 300,
                    order: 0,
                    role: "user",
                    text: "deploy to production",
                    threadId: notes,
                    userId: OWNER,
                });
                const other = await insertMessage(context, {
                    createdAt: 400,
                    order: 0,
                    role: "user",
                    text: "deploy from someone else",
                    threadId: theirs,
                    userId: OTHER,
                });

                return { deploys, newer, notes, older, other, reply, theirs };
            });

            const prompts = await search(harness, "deploy");

            expect(prompts.map((prompt) => prompt.messageId)).toEqual([ids.newer, ids.older]);
            expect(prompts.map((prompt) => prompt.threadId)).toEqual([ids.notes, ids.deploys]);
            expect(prompts.map((prompt) => prompt.threadTitle)).toEqual(["Notes", "Release"]);
            expect(prompts[0]?.text).toBe("deploy to production");
            expect(prompts.map((prompt) => prompt.messageId)).not.toContain(ids.reply);
            expect(prompts.map((prompt) => prompt.messageId)).not.toContain(ids.other);
        } finally {
            harness.close();
        }
    });

    it("leaves out a locked thread's prompt", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                const open = await insertThread(context, { title: "Open", userId: OWNER });
                const locked = await insertThread(context, { lockedAt: 2, title: "Locked chat", userId: OWNER });

                const shown = await insertMessage(context, {
                    createdAt: 100,
                    order: 0,
                    role: "user",
                    text: "deploy the open chat",
                    threadId: open,
                    userId: OWNER,
                });
                const hidden = await insertMessage(context, {
                    createdAt: 200,
                    order: 0,
                    role: "user",
                    text: "deploy the secret chat",
                    threadId: locked,
                    userId: OWNER,
                });

                return { hidden, shown };
            });

            const prompts = await search(harness, "deploy");

            expect(prompts.map((prompt) => prompt.messageId)).toEqual([ids.shown]);
            expect(prompts.map((prompt) => prompt.messageId)).not.toContain(ids.hidden);
        } finally {
            harness.close();
        }
    });

    it("returns at most 50 prompts", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Busy", userId: OWNER });

                for (let index = 0; index < 60; index += 1) {
                    await insertMessage(context, {
                        createdAt: index,
                        order: index,
                        role: "user",
                        text: `deploy number ${index}`,
                        threadId: thread,
                        userId: OWNER,
                    });
                }
            });

            const result: any = await harness.withIdentity({ userId: OWNER } as never).query(searchSentPrompts as never, { searchQuery: "deploy" } as never);

            expect(result.prompts).toHaveLength(50);
            expect(result.prompts[0]?.text).toBe("deploy number 59");
            // 60 hits fill neither window, but the list dropped ten of them.
            expect(result.truncated).toBe(true);
        } finally {
            harness.close();
        }
    });

    it("lists a match from every thread when the matches span more threads than one lookup batch", async () => {
        const harness = lunoraTest(schema as never);
        const threadCount = 40;

        try {
            await harness.run(async (context: any) => {
                for (let index = 0; index < threadCount; index += 1) {
                    const thread = await insertThread(context, { title: `Chat ${index}`, userId: OWNER });

                    await insertMessage(context, {
                        createdAt: index,
                        order: 0,
                        role: "user",
                        text: `deploy from chat ${index}`,
                        threadId: thread,
                        userId: OWNER,
                    });
                }
            });

            const prompts = await search(harness, "deploy");

            expect(prompts).toHaveLength(threadCount);
            expect(new Set(prompts.map((prompt) => prompt.threadId)).size).toBe(threadCount);
        } finally {
            harness.close();
        }
    });

    it("leaves out a temporary chat's prompt", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                const kept = await insertThread(context, { title: "Kept", userId: OWNER });
                // As `insertTemporaryThread` saves one: the marker and the thread's flag together.
                const temporary = await insertThread(context, { isTemporary: true, title: "Temporary", userId: OWNER });

                await context.db.insert("temporaryThreads", { expiresAt: Date.now() + 60_000, threadId: temporary, userId: OWNER });

                const shown = await insertMessage(context, {
                    createdAt: 100,
                    order: 0,
                    role: "user",
                    text: "deploy the kept chat",
                    threadId: kept,
                    userId: OWNER,
                });
                const hidden = await insertMessage(context, {
                    createdAt: 200,
                    order: 0,
                    role: "user",
                    text: "deploy the temporary chat",
                    threadId: temporary,
                    userId: OWNER,
                });

                return { hidden, shown };
            });

            const prompts = await search(harness, "deploy");

            expect(prompts.map((prompt) => prompt.messageId)).toEqual([ids.shown]);
            expect(prompts.map((prompt) => prompt.messageId)).not.toContain(ids.hidden);
        } finally {
            harness.close();
        }
    });

    it("leaves out a goal's continuation round, which nobody typed", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Goal chat", userId: OWNER });

                const typed = await insertMessage(context, {
                    createdAt: 100,
                    order: 0,
                    role: "user",
                    text: "deploy the staging build",
                    threadId: thread,
                    userId: OWNER,
                });
                const continuation = await insertMessage(context, {
                    agentName: GOAL_CONTINUATION_AGENT,
                    createdAt: 200,
                    order: 1,
                    role: "user",
                    text: "deploy the staging build again, toward the goal",
                    threadId: thread,
                    userId: OWNER,
                });

                return { continuation, typed };
            });

            const prompts = await search(harness, "deploy");

            expect(prompts.map((prompt) => prompt.messageId)).toEqual([ids.typed]);
            expect(prompts.map((prompt) => prompt.messageId)).not.toContain(ids.continuation);
        } finally {
            harness.close();
        }
    });

    it("searches a query longer than the input limit by its first words, not refusing it", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const shown = await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Long", userId: OWNER });

                return insertMessage(context, {
                    createdAt: 100,
                    order: 0,
                    role: "user",
                    text: "deploy the staging build",
                    threadId: thread,
                    userId: OWNER,
                });
            });

            const prompts = await search(harness, `deploy build ${"build ".repeat(120)}`);

            expect(prompts.map((prompt) => prompt.messageId)).toEqual([shown]);
        } finally {
            harness.close();
        }
    });

    it("says so when the search reached its window, so a newer prompt cut off by it is not lost silently", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Busy", userId: OWNER });

                for (let index = 0; index < 405; index += 1) {
                    await insertMessage(context, {
                        createdAt: index,
                        order: index,
                        role: "user",
                        text: `deploy number ${index}`,
                        threadId: thread,
                        userId: OWNER,
                    });
                }
            });

            const result: any = await harness.withIdentity({ userId: OWNER } as never).query(
                searchSentPrompts as never,
                {
                    searchQuery: "deploy",
                } as never,
            );

            expect(result.truncated).toBe(true);
        } finally {
            harness.close();
        }
    });

    it("reads the smaller window first and widens it only when too few prompts survived", async () => {
        const harness = lunoraTest(schema as never);
        const key = "agent_messages:typedTextSearch";
        const textSearch = registry.get(key);
        const windows: number[] = [];

        // Records each window the search asks the index for, then answers it as the real query does.
        registry.set(
            key,
            internalQuery.input({ limit: v.number(), text: v.string(), userId: v.string() }).query(async ({ args, ctx }: any) => {
                windows.push(args.limit);

                return await ctx.runQuery(textSearch, args);
            }),
        );

        try {
            await harness.run(async (context: any) => {
                const prompts = await insertThread(context, { title: "Prompts", userId: OWNER });
                const replies = await insertThread(context, { title: "Replies", userId: OWNER });

                for (let index = 0; index < 120; index += 1) {
                    await insertMessage(context, {
                        createdAt: index,
                        order: index,
                        role: "user",
                        text: `deploy number ${index}`,
                        threadId: prompts,
                        userId: OWNER,
                    });
                }

                for (let index = 0; index < 30; index += 1) {
                    await insertMessage(context, {
                        createdAt: index,
                        order: 200 + index,
                        role: "user",
                        text: `release step ${index}`,
                        threadId: prompts,
                        userId: OWNER,
                    });
                }

                // Stored after the prompts, so they win the index's tie-break on equal scores and take the first window of a
                // "release" search: prompts of a trashed chat, which count only once the thread filter has run. Replies are
                // not in the typed-words index, so they take no place in a window.
                const trashed = await insertThread(context, { title: "Trashed", userId: OWNER });

                await context.db.patch("threads", trashed, { deleted: true });

                for (let index = 0; index < 110; index += 1) {
                    await insertMessage(context, {
                        createdAt: 1000 + index,
                        order: index,
                        role: "user",
                        text: `release draft ${index}`,
                        threadId: trashed,
                        userId: OWNER,
                    });
                    await insertMessage(context, {
                        createdAt: 2000 + index,
                        order: index,
                        role: "assistant",
                        text: `release note ${index}`,
                        threadId: replies,
                        userId: OWNER,
                    });
                }
            });

            // A common word whose first window gives a full list reads no further.
            expect(await search(harness, "deploy")).toHaveLength(50);
            expect(windows).toEqual([100]);

            windows.length = 0;

            // Rows that list nothing filled the first window: the search widens and still finds the prompts behind them.
            expect(await search(harness, "release")).toHaveLength(30);
            expect(windows).toEqual([100, 400]);
        } finally {
            registry.set(key, textSearch);
            harness.close();
        }
    });

    it("answers nothing for a blank query", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Plain", userId: OWNER });

                await insertMessage(context, { createdAt: 1, order: 0, role: "user", text: "deploy", threadId: thread, userId: OWNER });
            });

            expect(await search(harness, " ".repeat(3))).toEqual([]);
        } finally {
            harness.close();
        }
    });

    it("searches a query of more words than the index takes by its first ones, not failing it", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const shown = await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Words", userId: OWNER });

                return insertMessage(context, { createdAt: 1, order: 0, role: "user", text: "alpha beta gamma", threadId: thread, userId: OWNER });
            });
            const words = ["alpha", "beta", "gamma", ...Array.from({ length: 14 }, (_, index) => `word${String(index)}`)];

            expect(words).toHaveLength(17);
            // The 17th word is cut, so the search runs, and the prompt has none of the extra words: nothing matches.
            expect(await search(harness, words.join(" "))).toEqual([]);
            const prefixed = await search(harness, "alpha beta gam");

            expect(prefixed.map((prompt) => prompt.messageId)).toEqual([shown]);
        } finally {
            harness.close();
        }
    });

    it("refuses a query far past the search's length before reading anything", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await expect(search(harness, "a".repeat(10_001))).rejects.toThrow();
        } finally {
            harness.close();
        }
    });

    it("lists and searches only what was typed, never an attached document, a quoted line or the image request's placeholder", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Report", userId: OWNER });
                const content = [documentTextPart("report.pdf", "quarterly revenue table"), { text: "summarise this report", type: "text" }];
                const quote = "> the deploy log says retry later\n\nwhy did the deploy fail";
                const typed = (text: string, order: number, parts: unknown = text) =>
                    insertMessage(context, { content: parts, createdAt: order + 1, order, role: "user", text, threadId: thread, userId: OWNER });

                return {
                    imageAsked: await typed("Generate an image", 3, [imagePromptPart()]),
                    imageTyped: await typed("Generate an image of a lighthouse", 4),
                    quoted: await typed(quote, 2),
                    shown: await typed(content.map((part) => part.text).join(" "), 0, content),
                };
            });

            expect(await search(harness, "revenue")).toEqual([]);

            const prompts = await search(harness, "summarise");

            expect(prompts.map((prompt) => prompt.messageId)).toEqual([ids.shown]);
            expect(prompts[0]?.text).toBe("summarise this report");

            // A word only in the quote matches nothing; the person's own words match and come back without the quote.
            expect(await search(harness, "retry")).toEqual([]);

            const replies = await search(harness, "fail");

            expect(replies.map((prompt) => [prompt.messageId, prompt.text])).toEqual([[ids.quoted, "why did the deploy fail"]]);

            // An image asked for with no prompt carries the app's placeholder: only the typed request with the same words lists.
            const images = await search(harness, "generate image");

            expect(images.map((prompt) => prompt.messageId)).toEqual([ids.imageTyped]);
        } finally {
            harness.close();
        }
    });

    it("stores the message as it was sent and indexes the typed words alone, as the memory's typed-text reader reads them", async () => {
        const harness = lunoraTest(schema as never);
        const document = documentTextPart("notes.pdf", "lighthouse keeper rota");
        const typedParts = [
            { providerOptions: { neore: { pageContext: true } }, text: "A captured lighthouse page", type: "text" },
            { text: "plan the lighthouse visit", type: "text" },
            imagePromptPart(),
            { text: "> the guide said dawn\n\nand book the ferry", type: "text" },
        ];
        const message = { content: [document, ...typedParts], role: "user" } as const;

        try {
            const { addMessagesHandler } = await import("../agent/messages");
            const saved = await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Trip", userId: OWNER });
                const { messages } = await addMessagesHandler(context, { messages: [{ message }], threadId: thread, userId: OWNER } as never);

                return messages[0];
            });

            // `text` keeps every part in the order it was sent; `typedText` is `typedTextOf`'s, each typed part its own paragraph.
            expect(saved?.text?.startsWith(document.text)).toBe(true);
            expect(saved?.typedText).toBe(typedTextOf(message));
            expect(saved?.typedText).toBe("plan the lighthouse visit\n\nand book the ferry");
            const listed = await search(harness, "lighthouse");

            expect(listed.map((prompt) => [prompt.messageId, prompt.text])).toEqual([[saved?._id, saved?.typedText]]);
            // A guest's note is no typing of the person's: it adds nothing to the indexed words.
            expect(
                typedTextColumn({ content: [guestTextPart("a guest wrote this", "note-1"), { text: "my words", type: "text" }], role: "user" } as never, ""),
            ).toBe("my words");
        } finally {
            harness.close();
        }
    });

    it("finds a reply to a quote longer than the index takes, by the reply's words", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const { addMessagesHandler } = await import("../agent/messages");
            const messageId = await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Quote", userId: OWNER });
                // Past the index's 1,000 terms, in the same part as the reply: the quote is not typed, so it is not indexed.
                const quote = `> ${Array.from({ length: 1500 }, (_, index) => `line${String(index)}`).join(" ")}`;
                const { messages } = await addMessagesHandler(context, {
                    messages: [{ message: { content: [{ text: `${quote}\n\nwhy did the lighthouse go dark`, type: "text" }], role: "user" } }],
                    threadId: thread,
                    userId: OWNER,
                } as never);

                return messages[0]?._id;
            });

            const replies = await search(harness, "lighthouse");

            expect(replies.map((prompt) => [prompt.messageId, prompt.text])).toEqual([[messageId, "why did the lighthouse go dark"]]);
            expect(await search(harness, "line5")).toEqual([]);
        } finally {
            harness.close();
        }
    });

    it("searches an edited prompt by its new words, never its old ones", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const messageId = await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Edits", userId: OWNER });

                return insertMessage(context, { createdAt: 1, order: 0, role: "user", text: "deploy the staging build", threadId: thread, userId: OWNER });
            });
            const { updateMessage } = await import("../agent/messages");

            await harness.run(async (context: any) =>
                context.runMutation(updateMessage, {
                    messageId,
                    patch: { message: { content: [documentTextPart("a.txt", "deploy notes"), { text: "rename the release", type: "text" }], role: "user" } },
                }),
            );

            expect(await search(harness, "deploy")).toEqual([]);
            const renamed = await search(harness, "rename");

            expect(renamed.map((prompt) => prompt.text)).toEqual(["rename the release"]);

            // Nothing typed any more: the old words leave the index too.
            await harness.run(async (context: any) =>
                context.runMutation(updateMessage, {
                    messageId,
                    patch: { message: { content: [documentTextPart("a.txt", "rename notes")], role: "user" } },
                }),
            );

            expect(await search(harness, "rename")).toEqual([]);
        } finally {
            harness.close();
        }
    });

    it("finds a prompt by its typed words when a long attached document comes before them", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const { addMessagesHandler } = await import("../agent/messages");
            const messageId = await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Manual", userId: OWNER });
                // Past the index's 1,000 terms: the document is saved ahead of the typed words, as `/chat/start` saves it.
                const manual = documentTextPart("manual.txt", Array.from({ length: 1500 }, (_, index) => `page${String(index)}`).join(" "));
                const { messages } = await addMessagesHandler(context, {
                    messages: [{ message: { content: [manual, { text: "translate the lighthouse chapter", type: "text" }], role: "user" } }],
                    threadId: thread,
                    userId: OWNER,
                } as never);

                return messages[0]?._id;
            });

            const prompts = await search(harness, "lighthouse");

            expect(prompts.map((prompt) => [prompt.messageId, prompt.text])).toEqual([[messageId, "translate the lighthouse chapter"]]);
        } finally {
            harness.close();
        }
    });

    it("lists a prompt copied into a branch once, and keeps a not-typed prompt's mark", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                const original = await insertThread(context, { title: "Original", userId: OWNER });
                const branch = await insertThread(context, { title: "Branch", userId: OWNER });
                const branchOfBranch = await insertThread(context, { title: "Branch of branch", userId: OWNER });

                await context.db.insert("threadRelationships", {
                    branchType: "branch",
                    createdAt: 6,
                    parentThreadId: original,
                    threadId: branch,
                    userId: OWNER,
                });
                await context.db.insert("threadRelationships", {
                    branchType: "branch",
                    createdAt: 7,
                    parentThreadId: branch,
                    threadId: branchOfBranch,
                    userId: OWNER,
                });

                for (const threadId of [original, branch, branchOfBranch]) {
                    await insertMessage(context, { createdAt: 5, order: 0, role: "user", text: "deploy it now", threadId, userId: OWNER });
                }

                await insertMessage(context, {
                    content: [{ providerOptions: { neore: { notTyped: { draft: "suggestion" } } }, text: "deploy a preview", type: "text" }],
                    createdAt: 9,
                    order: 1,
                    role: "user",
                    text: "deploy a preview",
                    threadId: original,
                    userId: OWNER,
                });
            });

            const prompts = await search(harness, "deploy");

            expect(prompts.map((prompt) => prompt.text)).toEqual(["deploy a preview", "deploy it now"]);
            expect(prompts.map((prompt) => prompt.draftFrom)).toEqual(["suggestion", undefined]);
        } finally {
            harness.close();
        }
    });

    it("lists the same words sent at the same time in two unrelated chats once per chat", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                const work = await insertThread(context, { title: "Work", userId: OWNER });
                const home = await insertThread(context, { title: "Home", userId: OWNER });

                for (const threadId of [work, home]) {
                    await insertMessage(context, { createdAt: 5, order: 0, role: "user", text: "deploy it now", threadId, userId: OWNER });
                }

                return { home, work };
            });

            const prompts = await search(harness, "deploy");

            expect(prompts).toHaveLength(2);
            expect(prompts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ threadId: ids.home, threadTitle: "Home" }),
                    expect.objectContaining({ threadId: ids.work, threadTitle: "Work" }),
                ]),
            );
        } finally {
            harness.close();
        }
    });

    it("reads a bounded number of branch links however many branch families share a search, and drops no prompt", async () => {
        const harness = lunoraTest(schema as never);
        const families = 50;

        try {
            await harness.run(async (context: any) => {
                for (let index = 0; index < families; index += 1) {
                    const original = await insertThread(context, { title: `Original ${index}`, userId: OWNER });
                    const branch = await insertThread(context, { title: `Branch ${index}`, userId: OWNER });

                    await context.db.insert("threadRelationships", {
                        branchType: "branch",
                        createdAt: index,
                        parentThreadId: original,
                        threadId: branch,
                        userId: OWNER,
                    });

                    for (const threadId of [original, branch]) {
                        await insertMessage(context, { createdAt: index, order: 0, role: "user", text: `deploy family ${index}`, threadId, userId: OWNER });
                    }
                }
            });

            const prompts = await search(harness, "deploy");
            const texts = prompts.map((prompt) => prompt.text);
            const firstRepeat = texts.findIndex((text, index) => texts.indexOf(text) !== index);

            // A family takes two link reads (the branch's link, the original's lack of one): the newest families list once
            // until the reads run out. From there a copy lists beside its original instead of costing more reads.
            expect(firstRepeat).toBe(SENT_PROMPT_LINEAGE_READS / 2 + 1);
            // No family is skipped: newest first, with no gap.
            expect([...new Set(texts)]).toEqual(Array.from({ length: new Set(texts).size }, (_, index) => `deploy family ${families - 1 - index}`));
        } finally {
            harness.close();
        }
    });

    it("orders a prompt saved without a send time by when it was stored, not as the oldest", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                const thread = await insertThread(context, { title: "Times", userId: OWNER });
                const timed = await insertMessage(context, { createdAt: 1, order: 0, role: "user", text: "deploy first", threadId: thread, userId: OWNER });
                const untimed = await insertMessage(context, {
                    createdAt: undefined,
                    order: 1,
                    role: "user",
                    text: "deploy second",
                    threadId: thread,
                    userId: OWNER,
                });

                return { timed, untimed };
            });

            const prompts = await search(harness, "deploy");

            expect(prompts.map((prompt) => prompt.messageId)).toEqual([ids.untimed, ids.timed]);
        } finally {
            harness.close();
        }
    });
});

describe("isSentPromptAvailable", () => {
    const available = (harness: ReturnType<typeof lunoraTest>, messageId: string, userId = OWNER) =>
        harness.withIdentity({ userId } as never).query(isSentPromptAvailable as never, { messageId } as never) as Promise<boolean>;

    it("answers yes for a prompt newer matches pushed out of the search's list, and no where the search would not list it", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await harness.run(async (context: any) => {
                const busy = await insertThread(context, { title: "Busy", userId: OWNER });
                const pushed = await insertMessage(context, { createdAt: 0, order: 0, role: "user", text: "deploy number 0", threadId: busy, userId: OWNER });

                for (let index = 1; index < 60; index += 1) {
                    await insertMessage(context, {
                        createdAt: index,
                        order: index,
                        role: "user",
                        text: `deploy number ${index}`,
                        threadId: busy,
                        userId: OWNER,
                    });
                }

                const reply = await insertMessage(context, { createdAt: 61, order: 60, role: "assistant", text: "deploy done", threadId: busy, userId: OWNER });
                // Saved in a listed chat, but nobody typed it: a goal's round and a guest's note sent on.
                const goalRound = await insertMessage(context, {
                    agentName: GOAL_CONTINUATION_AGENT,
                    createdAt: 62,
                    order: 61,
                    role: "user",
                    text: "deploy again",
                    threadId: busy,
                    userId: OWNER,
                });
                const guestNote = await insertMessage(context, {
                    content: [guestTextPart("deploy from a guest", "note-1")],
                    createdAt: 63,
                    order: 62,
                    role: "user",
                    text: "deploy from a guest",
                    threadId: busy,
                    userId: OWNER,
                });
                const promptIn = async (fields: { deleted?: boolean; isTemporary?: boolean; lockedAt?: number }, userId = OWNER) => {
                    const threadId = await insertThread(context, { ...fields, title: "Other", userId });

                    return insertMessage(context, { createdAt: 70, order: 0, role: "user", text: "deploy elsewhere", threadId, userId });
                };

                return {
                    goalRound,
                    guestNote,
                    locked: await promptIn({ lockedAt: 1 }),
                    pushed,
                    reply,
                    temporary: await promptIn({ isTemporary: true }),
                    theirs: await promptIn({}, OTHER),
                    trashed: await promptIn({ deleted: true }),
                };
            });

            const listed = await search(harness, "deploy");

            expect(listed.map((prompt) => prompt.messageId)).not.toContain(ids.pushed);
            await expect(available(harness, ids.pushed)).resolves.toBe(true);

            for (const refused of [ids.goalRound, ids.guestNote, ids.locked, ids.reply, ids.temporary, ids.theirs, ids.trashed]) {
                await expect(available(harness, refused)).resolves.toBe(false);
            }
        } finally {
            harness.close();
        }
    });
});
