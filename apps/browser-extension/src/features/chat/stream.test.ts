import { afterEach, describe, expect, it, vi } from "vitest";

import { streamReply } from "./stream";

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

describe(streamReply, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("follows resume markers and delivers every chunk exactly once", async () => {
        const gateway = fakeGateway();

        vi.stubGlobal("fetch", gateway);

        let text = "";

        await streamReply(
            "https://gateway.example",
            "token",
            (delta) => {
                text += delta.text;
            },
            new AbortController().signal,
        );

        expect(text).toBe(texts.join(""));
        expect(gateway.mock.calls.map((call) => (JSON.parse(String(call[1]?.body)) as { lastChunkIndex?: number }).lastChunkIndex)).toStrictEqual([
            undefined,
            30,
            60,
            90,
        ]);
        expect(gateway.mock.calls.every((call) => (JSON.parse(String(call[1]?.body)) as { resumable?: boolean }).resumable === true)).toBe(true);
    });

    it("stops following resumes once aborted", async () => {
        const gateway = fakeGateway();
        const controller = new AbortController();

        vi.stubGlobal("fetch", gateway);

        let text = "";

        await streamReply(
            "https://gateway.example",
            "token",
            (delta) => {
                text += delta.text;

                if (text.length > 0 && gateway.mock.calls.length === 2) {
                    controller.abort();
                }
            },
            controller.signal,
        );

        expect(gateway).toHaveBeenCalledTimes(2);
    });
});
