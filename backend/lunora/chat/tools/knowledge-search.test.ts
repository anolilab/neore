/**
 * The knowledge_search tool. The default searches no locked chat's own files;
 * only the admitted variant (a run the stream gate admitted) forwards
 * `admittedRun`, and nothing the model sends can set it.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import knowledgeSearchTool, { admittedKnowledgeSearchTool } from "./knowledge-search";

const HITS = [{ chunkIndex: 0, content: "Salary is 100", fileName: "pay.txt", score: 0.9 }];

const contextWith = (search: ReturnType<typeof vi.fn>) => {
    return { runAction: search, threadId: "locked-chat", userId: "owner-1" };
};

/** `wrapTools` attaches the agent's ctx to the tool object; `execute` reads it from there. */
const run = (tool: typeof knowledgeSearchTool, context: unknown, input: unknown) =>
    (tool as unknown as { execute: (input: unknown, options: unknown) => unknown }).execute.call({ ...tool, ctx: context }, input, {});

describe("knowledge_search", () => {
    it("returns the hits the search gives back (positive)", async () => {
        const search = vi.fn(async () => HITS);

        await expect(run(knowledgeSearchTool, contextWith(search), { query: "salary" })).resolves.toStrictEqual({ results: HITS });
    });

    it("does not forward admittedRun from the default tool, so a locked chat stays empty to the gate (negative)", async () => {
        const search = vi.fn(async () => HITS);

        await run(knowledgeSearchTool, contextWith(search), { admittedRun: true, query: "salary" });

        expect(search).toHaveBeenCalledWith(internal.knowledge.retrieve.search, {
            fileIds: undefined,
            query: "salary",
            threadId: "locked-chat",
            userId: "owner-1",
        });
    });

    it("forwards admittedRun from the admitted variant, so the chat's own files are searchable (positive)", async () => {
        const search = vi.fn(async () => HITS);

        await expect(run(admittedKnowledgeSearchTool, contextWith(search), { query: "salary" })).resolves.toStrictEqual({
            results: HITS,
        });
        expect(search).toHaveBeenCalledWith(internal.knowledge.retrieve.search, expect.objectContaining({ admittedRun: true, threadId: "locked-chat" }));
    });
});
