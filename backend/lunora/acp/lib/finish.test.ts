import { describe, expect, it } from "vitest";

import type { Id } from "../../_generated/dataModel";
import { MAX_TAIL_PAGES, MAX_TRANSCRIPT_PAGES, OMITTED_MARKER, readHostTranscript } from "./finish";

type Chunk = { reasoning?: string; seq: number; text: string };

/** A chunk table that pages like the real one: ordered by seq, `limit` rows a page, a cursor that is the next offset. */
const chunkTable = (chunks: Chunk[]) => {
    const reads: string[] = [];
    const db = {
        persistentChunks: {
            findMany: async ({ cursor, limit, orderBy }: { cursor?: string; limit: number; orderBy: [{ seq: "asc" | "desc" }] }) => {
                const direction = orderBy[0].seq;

                reads.push(direction);

                const ordered = direction === "asc" ? chunks : chunks.toReversed();
                const start = cursor === undefined ? 0 : Number(cursor);
                const end = start + limit;

                return { continueCursor: String(end), isDone: end >= ordered.length, page: ordered.slice(start, end) };
            },
        },
    };

    return { ctx: { db } as unknown as Parameters<typeof readHostTranscript>[0], reads };
};

const textOf = async (ctx: Parameters<typeof readHostTranscript>[0]) => {
    const { text } = await read(ctx);

    return text;
};

const read = (ctx: Parameters<typeof readHostTranscript>[0]) => readHostTranscript(ctx, "stream" as Id<"persistentStreams">);

/** `count` chunks of tool events (no text), then whatever follows. */
const events = (count: number, from = 0): Chunk[] =>
    Array.from({ length: count }, (_, index) => {
        return { seq: from + index, text: "" };
    });

describe("readHostTranscript", () => {
    it("reads a short turn whole, in order, without going back for a tail", async () => {
        const { ctx, reads } = chunkTable([
            { seq: 0, text: "Hello" },
            { seq: 1, text: "" },
            { seq: 2, text: " there" },
        ]);

        expect(await textOf(ctx)).toBe("Hello there");
        expect(new Set(reads)).toEqual(new Set(["asc"]));
    });

    it("stops the front read at its page budget when the text never fills", async () => {
        const { ctx, reads } = chunkTable(
            events(200 * (MAX_TRANSCRIPT_PAGES + MAX_TAIL_PAGES + 1)).map((chunk) => {
                return { ...chunk, reasoning: "thinking " };
            }),
        );

        const transcript = await read(ctx);

        expect(reads.filter((direction) => direction === "asc")).toHaveLength(MAX_TRANSCRIPT_PAGES);
        expect(reads.filter((direction) => direction === "desc")).toHaveLength(MAX_TAIL_PAGES);
        // The front pages and the tail pages are what was read, not the whole history.
        expect(transcript.reasoning).toBe("thinking ".repeat(200 * (MAX_TRANSCRIPT_PAGES + MAX_TAIL_PAGES)));
    });

    it("keeps the final reply of a turn with more tool events than the front budget reads", async () => {
        const chunks = [{ seq: 0, text: "Looking. " }, ...events(200 * MAX_TRANSCRIPT_PAGES + 50, 1)];

        chunks.push({ seq: chunks.length, text: "All" }, { seq: chunks.length + 1, text: " done." });

        const { ctx } = chunkTable(chunks);

        expect(await textOf(ctx)).toBe("Looking. All done.");
    });

    it("marks what it left out when the front and the tail do not meet", async () => {
        const chunks = [{ seq: 0, text: "Looking. " }, ...events(200 * (MAX_TRANSCRIPT_PAGES + MAX_TAIL_PAGES) + 50, 1)];

        chunks.push({ seq: chunks.length, text: "All" }, { seq: chunks.length + 1, text: " done." });

        const { ctx } = chunkTable(chunks);

        expect(await textOf(ctx)).toBe(`Looking. ${OMITTED_MARKER}All done.`);
    });

    it("joins the tail on without a marker when it starts where the front read stopped", async () => {
        const chunks = [...events(200 * MAX_TRANSCRIPT_PAGES), { seq: 200 * MAX_TRANSCRIPT_PAGES, text: "Done." }];
        const { ctx } = chunkTable(chunks);

        expect(await textOf(ctx)).toBe("Done.");
    });
});
