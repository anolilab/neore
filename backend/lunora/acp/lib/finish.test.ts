import { describe, expect, it } from "vitest";

import type { Id } from "../../_generated/dataModel";
import { MAX_TRANSCRIPT_PAGES, readHostTranscript } from "./finish";

/** A chunk table that never runs out: every page is full of reasoning, which never fills the text cap. */
const endlessReasoning = () => {
    let reads = 0;
    const db = {
        persistentChunks: {
            findMany: async () => {
                reads += 1;

                return { continueCursor: `page-${reads}`, isDone: false, page: [{ reasoning: "thinking ", text: "" }] };
            },
        },
    };

    return { ctx: { db } as unknown as Parameters<typeof readHostTranscript>[0], reads: () => reads };
};

describe("readHostTranscript", () => {
    it("stops after its page budget when the text never fills", async () => {
        const { ctx, reads } = endlessReasoning();

        const transcript = await readHostTranscript(ctx, "stream" as Id<"persistentStreams">);

        expect(reads()).toBe(MAX_TRANSCRIPT_PAGES);
        expect(transcript.reasoning).toBe("thinking ".repeat(MAX_TRANSCRIPT_PAGES));
    });
});
