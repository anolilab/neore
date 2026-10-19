import { describe, expect, it } from "vitest";

import parseNeore, { isNeoreExport } from "./neore";

// The export shape, as `collectConversations` (backend/lunora/gdpr/steps.ts) projects it:
// `projectMessage` and `projectThread` keep only these fields. `role` is absent from exports made before it was added.
const row = (fields: { createdAt: number; order: number; role?: string; stepOrder: number; text?: string; tool?: boolean }) => {
    return {
        _id: `m_${fields.order}_${fields.stepOrder}`,
        model: undefined,
        status: "success",
        tool: false,
        ...fields,
    };
};

const exportRoot = (conversations: unknown[]) => {
    return {
        codingAgentRuns: [],
        conversations,
        dataSubject: { email: "user@example.com", id: "user_1" },
        exportDate: "2026-10-19T00:00:00.000Z",
        exportVersion: "1.0",
        files: { files: [], folders: [] },
        knowledgeCollections: [],
        memories: { digests: [], memories: [] },
        profile: {},
        prompts: { promptHistory: [], prompts: [] },
        settings: {},
        subAgentRuns: [],
        threadTags: [],
        usageDaily: [],
    };
};

const threadWithTurns = {
    messages: [
        row({ createdAt: 1_700_000_000_100, order: 0, stepOrder: 0, text: "Hi" }),
        // One reply in three steps: text, a tool call that also carries text, and the tool result.
        row({ createdAt: 1_700_000_000_200, order: 0, stepOrder: 1, text: "Hello" }),
        row({ createdAt: 1_700_000_000_300, order: 0, stepOrder: 2, text: "Let me check", tool: true }),
        row({ createdAt: 1_700_000_000_400, order: 0, stepOrder: 3, tool: true }),
        row({ createdAt: 1_700_000_000_500, order: 0, stepOrder: 4, text: "Done" }),
        row({ createdAt: 1_700_000_001_000, order: 1, stepOrder: 0, text: "Thanks" }),
        row({ createdAt: 1_700_000_001_100, order: 1, stepOrder: 1, text: "You're welcome" }),
    ],
    thread: {
        _id: "t_1",
        category: undefined,
        createdAt: 1_700_000_000_000,
        model: "gpt-x",
        summary: undefined,
        tags: ["chat"],
        title: "Greeting",
        updatedAt: 1_700_000_001_100,
        userTags: [],
    },
};

describe("isNeoreExport", () => {
    it("detects the export root by exportVersion and conversations", () => {
        expect(isNeoreExport(exportRoot([threadWithTurns]))).toBe(true);
    });

    it("detects an export with no conversations", () => {
        expect(isNeoreExport(exportRoot([]))).toBe(true);
    });

    it("does not detect a conversations array without exportVersion", () => {
        expect(isNeoreExport({ conversations: [threadWithTurns] })).toBe(false);
    });

    it("does not detect a non-string exportVersion", () => {
        expect(isNeoreExport({ conversations: [], exportVersion: 1 })).toBe(false);
    });

    it("does not detect when the first conversation is not thread/messages shaped", () => {
        expect(isNeoreExport(exportRoot([{ chat_messages: [] }]))).toBe(false);
    });
});

describe("parseNeore", () => {
    it("keeps order and roles, merges the steps of one reply, and drops rows with no text", () => {
        const [conversation] = parseNeore([exportRoot([threadWithTurns])]);

        expect(conversation?.title).toBe("Greeting");
        expect(conversation?.createdAt).toBe(1_700_000_000_000);
        expect(conversation?.messages).toEqual([
            { content: "Hi", createdAt: 1_700_000_000_100, role: "user" },
            { content: "Hello\n\nLet me check\n\nDone", createdAt: 1_700_000_000_500, role: "assistant" },
            { content: "Thanks", createdAt: 1_700_000_001_000, role: "user" },
            { content: "You're welcome", createdAt: 1_700_000_001_100, role: "assistant" },
        ]);
    });

    it("trusts an exported role over the stepOrder rule, so a reply that opens its own order stays an assistant message", () => {
        const thread = {
            messages: [
                row({ createdAt: 1_700_000_000_100, order: 0, role: "user", stepOrder: 0, text: "Plan the trip" }),
                row({ createdAt: 1_700_000_000_200, order: 0, role: "assistant", stepOrder: 1, text: "Delegating" }),
                // A sub-agent result lands at stepOrder 0 of a new order, but it is not the user speaking.
                row({ createdAt: 1_700_000_000_900, order: 1, role: "assistant", stepOrder: 0, text: "Flights found" }),
            ],
            thread: { createdAt: 1_700_000_000_000, title: "Trip" },
        };
        const [conversation] = parseNeore(exportRoot([thread]));

        expect(conversation?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    });

    it("accepts the root object without the array wrapper", () => {
        expect(parseNeore(exportRoot([threadWithTurns]))).toHaveLength(1);
    });

    it("returns nothing for an export with no conversations", () => {
        expect(parseNeore([exportRoot([])])).toEqual([]);
    });

    it("skips a conversation that has no message with text", () => {
        const empty = { messages: [row({ createdAt: 1, order: 0, stepOrder: 1, tool: true })], thread: { createdAt: 1, title: "Tools only" } };

        expect(parseNeore([exportRoot([empty])])).toEqual([]);
    });

    it("falls back to the first user line when the thread has no title", () => {
        const untitled = { ...threadWithTurns, thread: { ...threadWithTurns.thread, title: undefined } };

        expect(parseNeore([exportRoot([untitled])])[0]?.title).toBe("Hi");
    });

    it("drops a non-positive or missing timestamp rather than storing it", () => {
        const noTimes = {
            messages: [row({ createdAt: 0, order: 0, stepOrder: 0, text: "Hi" })],
            thread: { createdAt: undefined, title: "No times" },
        };

        const [conversation] = parseNeore([exportRoot([noTimes])]);

        expect(conversation?.createdAt).toBeUndefined();
        expect(conversation?.messages[0]?.createdAt).toBeUndefined();
    });
});
