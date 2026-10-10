import { describe, expect, it, vi } from "vitest";

import { api } from "../../_generated/api";
import { internal } from "../../_generated/internal";
import { loadRunContext } from "./agent-run";

// The agent and tool builders pull in the whole agent client, which this pure
// data-loading path never touches.
vi.mock("./get-agent", () => {
    return { default: vi.fn() };
});
vi.mock("./agent-tools", () => {
    return { buildAgentTools: vi.fn() };
});

/** A promise the test settles by hand, to observe what starts before what. */
const deferred = <T>() => {
    const settle: { resolve?: (value: T) => void } = {};
    const promise = new Promise<T>((resolve) => {
        settle.resolve = resolve;
    });

    return { promise, resolve: (value: T) => settle.resolve?.(value) };
};

const makeCtx = (prefs: Promise<{ memoryEnabled: boolean }>, settings: Promise<{ projectId?: string } | null>) => {
    const runQuery = vi.fn(async (reference: unknown) => {
        switch (reference) {
            case api.agent.projects.getProject: {
                return { context: "Project notes" };
            }
            case internal.auth.functions.getDecryptedProviderKeysQuery: {
                return {};
            }
            case internal.auth.functions.getUserPreferencesQuery: {
                return await prefs;
            }
            case internal.chat.functions.getThreadSettings: {
                return await settings;
            }
            default: {
                throw new Error("unexpected query");
            }
        }
    });
    const runAction = vi.fn(async (reference: unknown) => {
        if (reference === internal.knowledge.retrieve.search) {
            return [{ chunkId: "c1", chunkIndex: 2, content: "Excerpt", fileId: "f1", fileName: "doc.pdf", score: 0.8 }];
        }

        if (reference === internal.memory.retrieve.retrieveRelevantMemories) {
            return [{ category: "preference", confidence: 1, memory: "Likes tea", memoryId: "m1", score: 0.9 }];
        }

        throw new Error("unexpected action");
    });

    return { ctx: { runAction, runQuery } as unknown as Parameters<typeof loadRunContext>[0], runAction, runQuery };
};

const args = { promptText: "What should I drink?", threadId: "t1", userId: "u1" };

describe(loadRunContext, () => {
    it("starts knowledge retrieval before the preferences and settings are read", async () => {
        const prefs = deferred<{ memoryEnabled: boolean }>();
        const settings = deferred<{ projectId?: string } | null>();
        const { ctx, runAction } = makeCtx(prefs.promise, settings.promise);

        const loading = loadRunContext(ctx, args);

        await vi.waitFor(() => {
            expect(runAction).toHaveBeenCalledWith(internal.knowledge.retrieve.search, { query: args.promptText, threadId: "t1", userId: "u1" });
        });
        // Memory is opt-in: nothing is retrieved before the preference is known.
        expect(runAction).not.toHaveBeenCalledWith(internal.memory.retrieve.retrieveRelevantMemories, expect.anything());

        prefs.resolve({ memoryEnabled: true });
        settings.resolve({ projectId: "p1" });

        const result = await loading;

        expect(result.contextParts).toHaveLength(3);
        expect(result.contextParts[0]).toContain("Likes tea");
        expect(result.contextParts[1]).toContain("[1] doc.pdf (passage 3):\nExcerpt");
        expect(result.knowledgeSources).toHaveLength(1);
        expect(result.contextParts[2]).toBe("PROJECT CONTEXT:\nProject notes");
        expect(result.retrievedMemories).toStrictEqual([{ memoryId: "m1", score: 0.9 }]);
    });

    it("retrieves no memories for a user who has not opted in, and reads no project without one", async () => {
        const { ctx, runAction, runQuery } = makeCtx(Promise.resolve({ memoryEnabled: false }), Promise.resolve(null));

        const result = await loadRunContext(ctx, args);

        expect(runAction).not.toHaveBeenCalledWith(internal.memory.retrieve.retrieveRelevantMemories, expect.anything());
        expect(runQuery).not.toHaveBeenCalledWith(api.agent.projects.getProject, expect.anything());
        expect(result.memoryEnabled).toBe(false);
        expect(result.retrievedMemories).toStrictEqual([]);
    });
});
