/**
 * The prompt outline: the user prompts of the active path, oldest first, through
 * the same access checks as opening the chat.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { getThreadUIMessages } from "./functions";
import { getThreadPromptOutline, isUserPromptRow, MAX_OUTLINE_ROWS, outlineText } from "./prompt-outline";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const OWNER = "user-owner";
const OTHER = "user-other";
const TURNS = 150;

const seed = async (harness: ReturnType<typeof lunoraTest>, extra: Record<string, unknown> = {}, turns = TURNS) =>
    await harness.run(async (context: any) => {
        const threadId = await context.db.insert("threads", { model: "m", status: "active", title: "t", userId: OWNER, ...extra });

        for (let turn = 0; turn < turns; turn += 1) {
            await context.db.insert("messages", {
                message: { content: `question ${String(turn)}`, role: "user" },
                order: turn,
                status: "success",
                stepOrder: 0,
                text: `question ${String(turn)}`,
                threadId,
                tool: false,
                userId: OWNER,
            });
            await context.db.insert("messages", {
                message: { content: `answer ${String(turn)}`, role: "assistant" },
                order: turn,
                status: "success",
                stepOrder: 1,
                text: `answer ${String(turn)}`,
                threadId,
                tool: false,
                userId: OWNER,
            });
        }

        return threadId as string;
    });

const outlineFor = async (harness: ReturnType<typeof lunoraTest>, userId: string, threadId: string) =>
    (await harness.withIdentity({ userId }).query(getThreadPromptOutline as never, { threadId } as never)) as {
        items: { id: string; text: string }[];
        truncated: boolean;
    };

describe("getThreadPromptOutline", () => {
    it("lists every user prompt, oldest first, past the first page of messages", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const threadId = await seed(harness);
            const outline = await outlineFor(harness, OWNER, threadId);

            expect(outline.truncated).toBe(false);
            expect(outline.items).toHaveLength(TURNS);
            expect(outline.items[0]?.text).toBe("question 0");
            expect(outline.items.at(-1)?.text).toBe(`question ${String(TURNS - 1)}`);
            expect(outline.items.some((item) => item.text.startsWith("answer"))).toBe(false);
        } finally {
            harness.close();
        }
    });

    it("stops at the jump's reach and says so, keeping the newest prompts", async () => {
        const harness = lunoraTest(schema as never);

        try {
            // 300 prompts are 600 rows; the scan reads the newest 520, which is 260 prompts.
            const threadId = await seed(harness, {}, 300);
            const outline = await outlineFor(harness, OWNER, threadId);

            expect(outline.truncated).toBe(true);
            expect(outline.items).toHaveLength(MAX_OUTLINE_ROWS / 2);
            expect(outline.items[0]?.text).toBe("question 40");
            expect(outline.items.at(-1)?.text).toBe("question 299");
        } finally {
            harness.close();
        }
    });

    it("uses the same ids as the thread's own message list, so the rail can jump to them", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const threadId = await seed(harness);
            const outline = await outlineFor(harness, OWNER, threadId);
            const page = (await harness
                .withIdentity({ userId: OWNER })
                .query(getThreadUIMessages as never, { paginationOpts: { cursor: null, numItems: 20 }, threadId } as never)) as {
                page: { id: string; role: string }[];
            };
            const loadedPrompts = page.page.filter((message) => message.role === "user").map((message) => message.id);

            expect(loadedPrompts.length).toBeGreaterThan(0);
            expect(outline.items.slice(-loadedPrompts.length).map((item) => item.id)).toStrictEqual(loadedPrompts);
        } finally {
            harness.close();
        }
    });

    it("refuses a stranger, and a locked chat without its proof", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const threadId = await seed(harness);
            const lockedId = await seed(harness, { lockedAt: Date.now() });

            await expect(outlineFor(harness, OTHER, threadId)).rejects.toMatchObject({ code: "NOT_FOUND" });
            await expect(outlineFor(harness, OWNER, lockedId)).rejects.toThrow("This chat is locked.");
        } finally {
            harness.close();
        }
    });
});

describe("helpers", () => {
    it("flattens and cuts prompt text", () => {
        expect(outlineText("  a\n\n b\tc ")).toBe("a b c");
        expect(outlineText("x".repeat(500))).toHaveLength(200);
        expect(outlineText(undefined)).toBe("");
        expect(outlineText("see [Function](https://en.wikipedia.org/wiki/Function_(mathematics)) now")).toBe("see Function now");
        expect(outlineText('see [spec](https://example.com/a "Title here") now')).toBe("see spec now");
        // A target longer than the cut must not survive as a half link.
        expect(outlineText(`${"a".repeat(190)} [docs](https://example.com/${"p".repeat(300)})`)).toBe(`${"a".repeat(190)} docs`);
    });

    it("recognises a user prompt row only", () => {
        expect(isUserPromptRow({ _id: "1", message: { role: "user" }, tool: false })).toBe(true);
        expect(isUserPromptRow({ _id: "2", message: { role: "assistant" }, tool: false })).toBe(false);
        expect(isUserPromptRow({ _id: "3", message: { role: "user" }, tool: true })).toBe(false);
        expect(isUserPromptRow({ _id: "4", tool: false })).toBe(false);
    });
});
