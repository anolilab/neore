import { afterEach, describe, expect, it, vi } from "vitest";

import { startStreaming } from "./streaming-placeholder";

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {};
        },
    };
});

const TOTAL = 100;
const PER_REQUEST = 30;
const texts = Array.from({ length: TOTAL }, (_, index) => `w${String(index)} `);

/** A gateway that relays at most PER_REQUEST chunks per request, then a resume marker. */
const fakeGateway = () =>
    vi.fn(async (_url: URL, init?: RequestInit) => {
        const { lastChunkIndex = 0, resumable } = JSON.parse(String(init?.body)) as { lastChunkIndex?: number; resumable?: boolean };
        const end = Math.min(TOTAL, lastChunkIndex + PER_REQUEST);
        const lines = texts.slice(lastChunkIndex, end).map((text) => JSON.stringify({ text }));

        if (end < TOTAL && resumable) {
            lines.push(JSON.stringify({ lastChunkIndex: end, type: "resume" }));
        }

        return new Response(`${lines.join("\n")}\n`, { status: 200 });
    });

const bodies = (gateway: ReturnType<typeof fakeGateway>) =>
    gateway.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { lastChunkIndex?: number; resumable?: boolean });

describe(startStreaming, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("follows resume markers without a reconnect, and delivers every chunk exactly once", async () => {
        const gateway = fakeGateway();
        const onReconnecting = vi.fn();

        vi.stubGlobal("fetch", gateway);

        let text = "";
        const isDone = await startStreaming(
            new URL("https://gateway.example/v1/stream"),
            "s1" as never,
            (delta) => {
                text += delta.text;
            },
            {},
            undefined,
            onReconnecting,
            "token",
            new AbortController().signal,
        );

        expect(isDone).toBe(true);
        expect(text).toBe(texts.join(""));
        expect(bodies(gateway).map((body) => body.lastChunkIndex)).toStrictEqual([undefined, 30, 60, 90]);
        expect(bodies(gateway).every((body) => body.resumable === true)).toBe(true);
        expect(onReconnecting).not.toHaveBeenCalled();
    });

    it("stops at an abort instead of following the next resume", async () => {
        const gateway = fakeGateway();
        const controller = new AbortController();

        vi.stubGlobal("fetch", gateway);

        const isDone = await startStreaming(
            new URL("https://gateway.example/v1/stream"),
            "s1" as never,
            () => {
                if (gateway.mock.calls.length === 2) {
                    controller.abort();
                }
            },
            {},
            undefined,
            undefined,
            "token",
            controller.signal,
        );

        expect(isDone).toBe(false);
        expect(gateway).toHaveBeenCalledTimes(2);
    });
});
