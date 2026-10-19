import { describe, expect, it } from "vitest";

import parseNeore, { isNeoreExport } from "./neore";

// The export shape, as `collectConversations` (backend/lunora/gdpr/steps.ts) projects it:
// `projectMessage` and `projectThread` keep only these fields. `role` is absent from exports made before it was added,
// and so are `parentMessageId` (messages) and `activeLeafMessageId` (threads): the branch fields the importer reads.
const row = (fields: {
    _id?: string;
    createdAt: number;
    order: number;
    parentMessageId?: string;
    role?: string;
    stepOrder: number;
    text?: string;
    tool?: boolean;
}) => {
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

/** A thread whose rows carry ids and parents, as an export made now writes them. `activeLeafMessageId` is the switcher's pointer. */
const branchedThread = (messages: ReturnType<typeof row>[], activeLeafMessageId?: string) => {
    return { messages, thread: { activeLeafMessageId, createdAt: 1_700_000_000_000, title: "Branches" } };
};

const textsOf = (thread: unknown) => {
    const [conversation] = parseNeore([exportRoot([thread])]);

    return conversation?.messages.map((message) => `${message.role}:${message.content}`);
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

    it("skips system and tool rows instead of guessing their role from stepOrder", () => {
        const thread = {
            messages: [
                row({ createdAt: 1_700_000_000_100, order: 0, role: "user", stepOrder: 0, text: "Hi" }),
                // Both would read as a turn under the stepOrder rule: a step-1 row as an assistant, a step-0 row as a user.
                row({ createdAt: 1_700_000_000_200, order: 0, role: "system", stepOrder: 1, text: "You are helpful" }),
                row({ createdAt: 1_700_000_000_300, order: 1, role: "tool", stepOrder: 0, text: "Tool output" }),
                row({ createdAt: 1_700_000_000_400, order: 1, role: "assistant", stepOrder: 1, text: "Hello" }),
            ],
            thread: { createdAt: 1_700_000_000_000, title: "Roles" },
        };
        const [conversation] = parseNeore(exportRoot([thread]));

        expect(conversation?.messages).toEqual([
            { content: "Hi", createdAt: 1_700_000_000_100, role: "user" },
            { content: "Hello", createdAt: 1_700_000_000_400, role: "assistant" },
        ]);
    });

    it("detects an export whose first conversation is damaged but a later one is whole", () => {
        expect(isNeoreExport(exportRoot([{ thread: "oops" }, threadWithTurns]))).toBe(true);
        expect(parseNeore([exportRoot([{ thread: "oops" }, threadWithTurns])])).toHaveLength(1);
    });

    it("does not detect a file whose every conversation is damaged", () => {
        expect(isNeoreExport(exportRoot([{ thread: "oops" }, { messages: "no" }]))).toBe(false);
    });

    it("skips a null or non-object conversation and keeps the rest of the file", () => {
        const [conversation, ...rest] = parseNeore([exportRoot([null, "oops", threadWithTurns, 7])]);

        expect(rest).toEqual([]);
        expect(conversation?.title).toBe("Greeting");
    });

    it("skips a null message row rather than failing its conversation", () => {
        const withNull = { messages: [null, ...threadWithTurns.messages], thread: threadWithTurns.thread };
        const [conversation] = parseNeore([exportRoot([withNull])]);

        expect(conversation?.messages).toEqual(parseNeore([exportRoot([threadWithTurns])])[0]?.messages);
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

describe("parseNeore with an active branch", () => {
    // A prompt with two replies (a regenerate: both are children of the prompt, sharing its order).
    const twoReplies = (leaf?: string) =>
        branchedThread(
            [
                row({ _id: "p", createdAt: 1, order: 0, role: "user", stepOrder: 0, text: "Plan a trip" }),
                row({ _id: "a", createdAt: 2, order: 0, parentMessageId: "p", role: "assistant", stepOrder: 1, text: "Option A" }),
                row({ _id: "b", createdAt: 3, order: 0, parentMessageId: "p", role: "assistant", stepOrder: 1, text: "Option B" }),
            ],
            leaf,
        );

    it("imports only the reply on the active branch", () => {
        expect(textsOf(twoReplies("a"))).toEqual(["user:Plan a trip", "assistant:Option A"]);
        expect(textsOf(twoReplies("b"))).toEqual(["user:Plan a trip", "assistant:Option B"]);
    });

    it("keeps the active branch when the prompt was edited", () => {
        const edited = branchedThread(
            [
                row({ _id: "p1", createdAt: 1, order: 0, role: "user", stepOrder: 0, text: "Hi" }),
                row({ _id: "r1", createdAt: 2, order: 0, parentMessageId: "p1", role: "assistant", stepOrder: 1, text: "Hello" }),
                // The original prompt and its edit are siblings under the same reply, and each has its own answer.
                row({ _id: "po", createdAt: 3, order: 1, parentMessageId: "r1", role: "user", stepOrder: 0, text: "Plan a trip" }),
                row({ _id: "ro", createdAt: 4, order: 1, parentMessageId: "po", role: "assistant", stepOrder: 1, text: "Reply to the original" }),
                row({ _id: "pe", createdAt: 5, order: 1, parentMessageId: "r1", role: "user", stepOrder: 0, text: "Plan a trip, please" }),
                row({ _id: "re", createdAt: 6, order: 1, parentMessageId: "pe", role: "assistant", stepOrder: 1, text: "Reply to the edit" }),
            ],
            "re",
        );

        expect(textsOf(edited)).toEqual(["user:Hi", "assistant:Hello", "user:Plan a trip, please", "assistant:Reply to the edit"]);
    });

    it("follows an edit of the first prompt that is stored as a top-level sibling, not as a dangling id", () => {
        const firstPromptEdited = branchedThread(
            [
                row({ _id: "q0", createdAt: 1, order: 0, role: "user", stepOrder: 0, text: "Original" }),
                row({ _id: "r0", createdAt: 2, order: 0, parentMessageId: "q0", role: "assistant", stepOrder: 1, text: "Answer to original" }),
                row({ _id: "q1", createdAt: 3, order: 0, parentMessageId: "root", role: "user", stepOrder: 0, text: "Edited" }),
                row({ _id: "r1", createdAt: 4, order: 0, parentMessageId: "q1", role: "assistant", stepOrder: 1, text: "Answer to edit" }),
            ],
            "r1",
        );

        expect(textsOf(firstPromptEdited)).toEqual(["user:Edited", "assistant:Answer to edit"]);
    });

    it("keeps every step of the active reply, even when the leaf is its first step", () => {
        const multiStep = branchedThread(
            [
                row({ _id: "p", createdAt: 1, order: 0, role: "user", stepOrder: 0, text: "Look it up" }),
                row({ _id: "s1", createdAt: 2, order: 0, parentMessageId: "p", role: "assistant", stepOrder: 1, text: "Checking" }),
                row({ _id: "s2", createdAt: 3, order: 0, role: "assistant", stepOrder: 2, tool: true }),
                row({ _id: "s3", createdAt: 4, order: 0, role: "assistant", stepOrder: 3, text: "Found it" }),
                row({ _id: "q", createdAt: 5, order: 1, role: "user", stepOrder: 0, text: "Thanks" }),
                row({ _id: "y", createdAt: 6, order: 1, role: "assistant", stepOrder: 1, text: "Welcome" }),
            ],
            // The stored leaf points at the first step, which the rest of the turn descends from.
            "s1",
        );

        expect(textsOf(multiStep)).toEqual(["user:Look it up", "assistant:Checking\n\nFound it", "user:Thanks", "assistant:Welcome"]);
    });

    it("keeps a dangling parent on the previous row, as the backend displays it", () => {
        const dangling = branchedThread(
            [
                row({ _id: "p", createdAt: 1, order: 0, role: "user", stepOrder: 0, text: "Hi" }),
                row({ _id: "a", createdAt: 2, order: 0, parentMessageId: "p", role: "assistant", stepOrder: 1, text: "A" }),
                row({ _id: "b", createdAt: 3, order: 0, parentMessageId: "deleted", role: "assistant", stepOrder: 1, text: "B" }),
            ],
            "b",
        );

        // `B` hangs off `A` (the row before it), so the two are one reply's steps, as the backend shows them.
        expect(textsOf(dangling)).toEqual(["user:Hi", "assistant:A\n\nB"]);
    });

    it("terminates on rows that name each other as parents", () => {
        const mutual = branchedThread(
            [
                row({ _id: "a", createdAt: 1, order: 0, parentMessageId: "b", role: "user", stepOrder: 0, text: "First" }),
                row({ _id: "b", createdAt: 2, order: 0, parentMessageId: "a", role: "assistant", stepOrder: 1, text: "Second" }),
            ],
            "b",
        );

        expect(textsOf(mutual)).toEqual(["user:First", "assistant:Second"]);
    });

    it("shows the latest reply when the stored leaf is no longer in the file", () => {
        expect(textsOf(twoReplies("deleted"))).toEqual(["user:Plan a trip", "assistant:Option B"]);
    });

    it("imports a never-branched thread exactly as before, with no leaf", () => {
        expect(textsOf(branchedThread([...threadWithTurns.messages], undefined))).toEqual(textsOf(threadWithTurns));
    });
});
