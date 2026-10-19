/**
 * `useDeltaStreams` with the REAL unlock store. Only `useQuery` from `@lunora/react`
 * is replaced: it records the args each stream query was built with and answers the
 * list query with one active stream, so the cursor (deltas) query is built too.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetAllUnlockProofs, rememberUnlockProof } from "@neore/client-runtime";

import useDeltaStreams from "./use-delta-streams";

const harness = vi.hoisted(() => {
    return {
        calls: [] as { args: Record<string, unknown> }[],
        serve: undefined as ((cursor: number) => { end: number; parts: never[]; start: number; streamId: string }[]) | undefined,
    };
});

vi.mock("@lunora/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@lunora/react")>();

    return {
        ...actual,
        useQuery: (_reference: unknown, args: Record<string, unknown>) => {
            harness.calls.push({ args });

            const streamArgs = args.streamArgs as { kind: string } | undefined;

            if (streamArgs?.kind === "list") {
                return { streams: { messages: [{ order: 1, status: "streaming", stepOrder: 0, streamId: "stream-1" }] } };
            }

            if (streamArgs?.kind === "deltas" && harness.serve) {
                const cursor = (args.streamArgs as { cursors: { cursor: number }[] }).cursors[0]?.cursor ?? 0;

                return { streams: { deltas: harness.serve(cursor) } };
            }

            return undefined;
        },
    };
});

const query = { __lunoraRef: "chat_functions:getThreadUIMessages" } as never;

const argsByKind = (kind: "deltas" | "list") =>
    harness.calls.filter((call) => (call.args.streamArgs as { kind?: string } | undefined)?.kind === kind).map((call) => call.args);

afterEach(() => {
    forgetAllUnlockProofs();
    harness.calls.length = 0;
    harness.serve = undefined;
});

describe("live stream queries on a chat", () => {
    it("an unlocked chat sends the proof with the stream list AND the deltas query", () => {
        rememberUnlockProof("thread-1", "proof-1", Date.now() + 60_000);

        renderHook(() => useDeltaStreams(query, { threadId: "thread-1" } as never));

        expect(argsByKind("list")[0]).toMatchObject({ threadId: "thread-1", unlockProof: "proof-1" });
        expect(argsByKind("deltas")[0]).toMatchObject({ threadId: "thread-1", unlockProof: "proof-1" });
    });

    it("a locked chat sends no proof with either query", () => {
        renderHook(() => useDeltaStreams(query, { threadId: "thread-1" } as never));

        expect(argsByKind("list")[0]).not.toHaveProperty("unlockProof");
        expect(argsByKind("deltas")[0]).not.toHaveProperty("unlockProof");
    });

    it("a chat that is not named by the proof gets none", () => {
        rememberUnlockProof("thread-2", "proof-other", Date.now() + 60_000);

        renderHook(() => useDeltaStreams(query, { threadId: "thread-1" } as never));

        expect(argsByKind("deltas")[0]).not.toHaveProperty("unlockProof");
    });
});

describe("a gap in the deltas", () => {
    const delta = (start: number, end: number) => {
        return { end, parts: [], start, streamId: "stream-1" };
    };

    it("does not throw: it drops the stream's deltas and re-fetches from the start", () => {
        let gapServed = false;

        harness.serve = (cursor) => {
            if (cursor === 0) {
                return [delta(0, 5)];
            }

            if (!gapServed) {
                // the server skipped ahead of what we hold
                gapServed = true;

                return [delta(9, 12)];
            }

            return [];
        };

        const { result } = renderHook(() => useDeltaStreams(query, { threadId: "thread-1" } as never));
        const requestedCursors = argsByKind("deltas").map((args) => (args.streamArgs as { cursors: { cursor: number }[] }).cursors[0]?.cursor);

        // 0 -> held [0,5]; 5 -> gap -> reset; 0 again -> [0,5]; never the hole [9,12].
        expect(requestedCursors).toEqual([0, 5, 0, 5]);
        expect(result.current?.[0]?.deltas.map(({ end, start }) => [start, end])).toEqual([[0, 5]]);
    });

    it("treats a new stream's first delta as a gap when it does not start at 0", () => {
        let served = false;

        harness.serve = () => {
            if (!served) {
                served = true;

                return [delta(9, 12)];
            }

            return [delta(0, 5)];
        };

        const { result } = renderHook(() => useDeltaStreams(query, { threadId: "thread-1" } as never));

        expect(result.current?.[0]?.deltas.map(({ end, start }) => [start, end])).toEqual([[0, 5]]);
    });
});
