/**
 * `saveLocalTurnHandler` against the real schema: the turn lands as two rows
 * in one `order`, only the caller's own local endpoint qualifies, and another
 * user's thread is refused.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listActivePathPage } from "../agent/branches";
import schema from "../schema";
import { saveLocalTurnHandler } from "./local-models";

// `aiUserPreferences` is audited, and its trigger writes the `.global()`
// `documentHistory` table the harness cannot store. Auditing is not under test.
vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

type Harness = ReturnType<typeof lunoraTest>;

const NOT_FOUND_RE = /not found or disabled/u;
const FOREIGN_THREAD_RE = /another user's thread/u;
const NOT_A_PROMPT_RE = /take a prompt of this thread/u;

const OWNER = "owner-user";
const MODEL = "custom:ollama/llama3.2:3b";

let harness: Harness;

const seedEndpoint = async (userId: string, type: string) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("aiUserPreferences", {
                customAIProviders: {
                    ollama: {
                        enabled: true,
                        encryptedKey: "",
                        endpoint: ["http", "//localhost:11434/v1"].join(":"),
                        models: [{ id: "llama3.2:3b" }],
                        name: "Ollama",
                        type,
                    },
                },
                userId,
            }),
    );

const save = async (userId: string, args: Record<string, unknown>) =>
    await harness.run(
        async (ctx: any) => await saveLocalTurnHandler(ctx, userId, { model: MODEL, outcome: "complete", prompt: "hi", reply: "hello", ...args } as never),
    );

const rowsOf = async (threadId: string) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db
                .query("messages")
                .withIndex("threadId_status_tool_order_stepOrder", (q: any) => q.eq("threadId", threadId))
                .collect(),
    );

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe(saveLocalTurnHandler, () => {
    it("creates a thread and saves the prompt and reply as one turn", async () => {
        await seedEndpoint(OWNER, "local-browser");

        const result = await save(OWNER, { prompt: "Explain CSP in one line" });
        const thread = await harness.run(async (ctx: any) => await ctx.db.get(result.threadId));
        const saved = await rowsOf(result.threadId);
        const rows = saved.toSorted((a: any, b: any) => a.stepOrder - b.stepOrder);

        expect(thread).toMatchObject({ model: MODEL, tags: ["chat", "local"], title: "Explain CSP in one line", userId: OWNER });
        expect(rows.map((row: any) => [row.message.role, row.order, row.stepOrder])).toStrictEqual([
            ["user", 0, 0],
            ["assistant", 0, 1],
        ]);
        expect(rows[1]).toMatchObject({ provider: "local-browser", text: "hello" });
        expect(rows[1].usage).toBeUndefined();
    });

    it("appends the next turn to an existing thread", async () => {
        await seedEndpoint(OWNER, "local-browser");

        const first = await save(OWNER, {});

        await save(OWNER, { prompt: "again", threadId: first.threadId });

        const saved = await rowsOf(first.threadId);
        const orders = saved.map((row: any) => row.order as number).toSorted((a: number, b: number) => a - b);

        expect(orders).toStrictEqual([0, 0, 1, 1]);
    });

    it("refuses a server-side endpoint, so the client cannot write replies under it", async () => {
        await seedEndpoint(OWNER, "openai");

        await expect(save(OWNER, {})).rejects.toThrow(NOT_FOUND_RE);
    });

    it("refuses another user's thread", async () => {
        await seedEndpoint(OWNER, "local-browser");
        await seedEndpoint("intruder", "local-browser");

        const { threadId } = await save(OWNER, {});

        await expect(save("intruder", { threadId })).rejects.toThrow(FOREIGN_THREAD_RE);
    });
});

describe("regenerate and edit on the local path", () => {
    /** The displayed path, oldest first, with the switcher position of each row that has siblings. */
    const activePath = async (threadId: string) => {
        const thread = await harness.run(async (ctx: any) => await ctx.db.get(threadId));
        const page: any = await harness.run(async (ctx: any) => await listActivePathPage(ctx, thread, { cursor: null, numItems: 50 }));
        const rows = [...page.page].toSorted((a: any, b: any) => a.order - b.order || a.stepOrder - b.stepOrder);

        return rows.map((row: any) => {
            const branch = page.branches.get(row._id);

            return { branch: branch ? `${branch.index + 1}/${branch.count}` : undefined, role: row.message.role, text: row.text };
        });
    };

    it("saves a regenerate as a sibling reply to the same prompt, shown as 2/2", async () => {
        await seedEndpoint(OWNER, "local-browser");

        const first = await save(OWNER, { prompt: "hi", reply: "first answer" });
        const regenerated = await save(OWNER, {
            branch: { kind: "regenerate", messageId: first.userMessageId },
            prompt: "hi",
            reply: "second answer",
            threadId: first.threadId,
        });

        // No duplicate prompt: the regenerate answers the existing one.
        expect(regenerated.userMessageId).toBe(first.userMessageId);
        expect(await rowsOf(first.threadId)).toHaveLength(3);
        expect(await activePath(first.threadId)).toStrictEqual([
            { branch: undefined, role: "user", text: "hi" },
            { branch: "2/2", role: "assistant", text: "second answer" },
        ]);
    });

    it("continues the next turn from the regenerated reply, not the old one", async () => {
        await seedEndpoint(OWNER, "local-browser");

        const first = await save(OWNER, { prompt: "hi", reply: "first answer" });

        await save(OWNER, { branch: { kind: "regenerate", messageId: first.userMessageId }, prompt: "hi", reply: "second answer", threadId: first.threadId });
        await save(OWNER, { prompt: "and then?", reply: "more", threadId: first.threadId });

        const path = await activePath(first.threadId);

        expect(path.map((row) => row.text)).toStrictEqual(["hi", "second answer", "and then?", "more"]);
    });

    it("saves an edit as a sibling prompt with its own reply, the original kept", async () => {
        await seedEndpoint(OWNER, "local-browser");

        const first = await save(OWNER, { prompt: "hi", reply: "first answer" });
        const edited = await save(OWNER, {
            branch: { kind: "edit", messageId: first.userMessageId },
            prompt: "hello instead",
            reply: "edited answer",
            threadId: first.threadId,
        });

        expect(edited.userMessageId).not.toBe(first.userMessageId);
        expect(await rowsOf(first.threadId)).toHaveLength(4);
        expect(await activePath(first.threadId)).toStrictEqual([
            { branch: "2/2", role: "user", text: "hello instead" },
            { branch: undefined, role: "assistant", text: "edited answer" },
        ]);
    });

    it("refuses a branch whose target is not a prompt of the thread", async () => {
        await seedEndpoint(OWNER, "local-browser");

        const first = await save(OWNER, {});

        await expect(save(OWNER, { branch: { kind: "regenerate", messageId: first.assistantMessageId }, threadId: first.threadId })).rejects.toThrow(
            NOT_A_PROMPT_RE,
        );
    });
});
