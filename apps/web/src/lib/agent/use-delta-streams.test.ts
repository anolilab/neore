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
    return { calls: [] as { args: Record<string, unknown> }[] };
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
