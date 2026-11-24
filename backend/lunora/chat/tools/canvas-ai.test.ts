/**
 * A canvas edit reads its document first, and writes the document's message and charges the image allowance only for a request
 * that will run. A refused or invalid request leaves the document and the allowance untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Document = { content?: string; threadId?: string; userId: string };

const state = vi.hoisted(() => {
    return {
        document: null as Document | null,
        log: [] as string[],
    };
});

vi.mock("@neore/ai/models", () => {
    return { MEDIA_DEFAULT_MODELS: { image: "fal-ai/recraft/v3/text-to-image" } };
});
vi.mock("../../agent/client", () => {
    return { createTool: (definition: unknown) => definition };
});
vi.mock("../../_generated/internal", () => {
    return {
        internal: {
            agent: { documents: { getDocumentInternal: "getDocumentInternal", updateDocumentInternal: "updateDocumentInternal" } },
            auth: { functions: { getUserAuthFlagsQuery: "getUserAuthFlagsQuery" } },
            chat: { functions: { editImage: "editImage", generateImage: "generateImage" } },
            lib: { rate_limiter_mutations: { applyRateLimit: "applyRateLimit" } },
        },
    };
});
vi.mock("../lib/agent-run", () => {
    return {
        readRunPlan: async () => {
            return { isAdmin: false, plan: null };
        },
    };
});

interface CanvasTool {
    execute: (
        context: unknown,
        input: { documentId: string; operation: string; prompt?: string },
    ) => Promise<{ code?: string; error?: string; message: string; resultUrl?: string }>;
}

const { default: canvasAITool } = await import("./canvas-ai");
const tool = canvasAITool as unknown as CanvasTool;

/** `chargeOk` is what the daily allowance answers when the edit asks for its unit. */
const makeContext = (chargeOk = true) => {
    return {
        messageId: "message-1",
        runAction: async (reference: string) => {
            state.log.push(`action:${reference}`);

            return { resultUrl: "https://fal.example/edited.png" };
        },
        runMutation: async (reference: string) => {
            if (reference === "applyRateLimit") {
                state.log.push("charge");

                return chargeOk ? { ok: true } : { ok: false, retryAfter: 60 };
            }

            state.log.push(`write:${reference}`);

            return undefined;
        },
        runQuery: async (reference: string) => {
            if (reference === "getUserAuthFlagsQuery") {
                return { isAnonymous: false, plan: null, role: null };
            }

            state.log.push(`read:${reference}`);

            return state.document;
        },
        threadId: "thread-1",
        userId: "user-1",
    };
};

const sideEffects = () => state.log.filter((entry) => entry === "charge" || entry.startsWith("write:") || entry.startsWith("action:"));

beforeEach(() => {
    state.document = { content: "data:image/png;base64,AAAA", threadId: "thread-1", userId: "user-1" };
    state.log.length = 0;
});

describe("canvas edits draw on the daily image allowance", () => {
    it("reads, charges, writes the message, then edits, in that order", async () => {
        const output = await tool.execute(makeContext(), { documentId: "doc-1", operation: "style_transfer", prompt: "watercolour" });

        expect(state.log).toStrictEqual(["read:getDocumentInternal", "charge", "write:updateDocumentInternal", "action:editImage"]);
        expect(output.resultUrl).toBe("https://fal.example/edited.png");
    });

    it("writes nothing and calls no provider when the allowance is spent", async () => {
        const output = await tool.execute(makeContext(false), { documentId: "doc-1", operation: "upscale" });

        expect(output.code).toBe("DAILY_IMAGE_LIMIT_REACHED");
        expect(state.log).toStrictEqual(["read:getDocumentInternal", "charge"]);
    });

    it("refuses a style transfer without a prompt before anything is charged or written", async () => {
        const output = await tool.execute(makeContext(), { documentId: "doc-1", operation: "style_transfer" });

        expect(output.error).toBe("Missing prompt");
        expect(sideEffects()).toStrictEqual([]);
    });

    it("refuses a design with no image preview before anything is charged or written", async () => {
        state.document = { content: undefined, threadId: "thread-1", userId: "user-1" };

        const output = await tool.execute(makeContext(), { documentId: "doc-1", operation: "remove_background" });

        expect(output.error).toBe("No image preview");
        expect(sideEffects()).toStrictEqual([]);
    });

    it("refuses another user's design as not found, with nothing written or charged", async () => {
        state.document = { content: "data:image/png;base64,AAAA", threadId: "thread-1", userId: "someone-else" };

        const output = await tool.execute(makeContext(), { documentId: "doc-1", operation: "upscale" });

        expect(output.error).toBe("Document not found");
        expect(sideEffects()).toStrictEqual([]);
    });

    it("refuses a design of another thread as not found, with nothing written or charged", async () => {
        state.document = { content: "data:image/png;base64,AAAA", threadId: "thread-2", userId: "user-1" };

        const output = await tool.execute(makeContext(), { documentId: "doc-1", operation: "upscale" });

        expect(output.error).toBe("Document not found");
        expect(sideEffects()).toStrictEqual([]);
    });
});
