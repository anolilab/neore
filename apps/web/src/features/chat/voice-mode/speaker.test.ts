import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Synthesize } from "./speaker";
import { speakReply, splitForTts, stopReplySpeech, TTS_CHUNK_CHARS, TTS_FIRST_CHUNK_CHARS } from "./speaker";
import { ttsPauseMs } from "./tts-availability";

interface FakeUtterance extends EventTarget {
    lang: string;
    text: string;
    voice: unknown;
}

/** A `SpeechSynthesisUtterance` stand-in: an event target carrying its text. */
function createUtterance(this: unknown, text: string): FakeUtterance {
    return Object.assign(new EventTarget(), { lang: "", text, voice: null });
}

const audioState = { failPlay: false, instances: [] as FakeAudio[] };

class FakeAudio extends EventTarget {
    public paused = true;

    public constructor(public source: string) {
        super();
        audioState.instances.push(this);
    }

    public pause(): void {
        this.paused = true;
    }

    public async play(): Promise<void> {
        if (audioState.failPlay) {
            throw new Error("NotAllowedError");
        }

        this.paused = false;
    }

    public end(): void {
        this.dispatchEvent(new Event("ended"));
    }
}

const spoken: FakeUtterance[] = [];
const synthesis = {
    addEventListener: vi.fn(),
    cancel: vi.fn(() => {
        const dropped = [...spoken];

        spoken.length = 0;

        for (const utterance of dropped) {
            utterance.dispatchEvent(new Event("error"));
        }
    }),
    getVoices: () => [{ default: true, lang: "en-US", name: "Test Voice" }],
    removeEventListener: vi.fn(),
    speak: (utterance: FakeUtterance) => {
        spoken.push(utterance);
    },
};

/** Lets pending promise chains (a synthesis, a `play()`) run. */
const flush = async (): Promise<void> => {
    for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
    }
};

const LONG_REPLY = `${"First sentence here. ".repeat(12)}${"More of the reply follows. ".repeat(40)}`;

const urls = { count: 0 };

const nextObjectUrl = (): string => {
    urls.count += 1;

    return `blob:${String(urls.count)}`;
};

beforeEach(() => {
    vi.stubGlobal("speechSynthesis", synthesis);
    vi.stubGlobal("SpeechSynthesisUtterance", createUtterance);
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: nextObjectUrl, revokeObjectURL: vi.fn() }));
    audioState.instances = [];
    audioState.failPlay = false;
    spoken.length = 0;
    synthesis.cancel.mockClear();
});

afterEach(() => {
    stopReplySpeech();
    vi.unstubAllGlobals();
});

const audioOf = (text: string) => {
    return { audio: btoa(text.slice(0, 4)), mimeType: "audio/mpeg" };
};

describe(splitForTts, () => {
    it("starts with a short piece and keeps every later one under the per-call cap", () => {
        const chunks = splitForTts(LONG_REPLY.trim());

        expect(chunks.length).toBeGreaterThan(2);
        expect(chunks[0]!.length).toBeLessThanOrEqual(TTS_FIRST_CHUNK_CHARS);
        expect(chunks.every((chunk) => chunk.length <= TTS_CHUNK_CHARS)).toBe(true);
        expect(chunks.join(" ")).toBe(LONG_REPLY.trim());
    });

    it("returns nothing for empty text", () => {
        expect(splitForTts("")).toEqual([]);
    });
});

describe("speakReply with registry TTS", () => {
    it("plays each piece in order, fetching the next while one plays, and never uses the browser voice", async () => {
        const synthesize = vi.fn<Synthesize>(async ({ text }) => audioOf(text));
        const handle = speakReply(LONG_REPLY, { tts: { synthesize, voice: "Calm_Woman" } });
        const pieces = splitForTts(LONG_REPLY.trim());

        await flush();

        expect(synthesize).toHaveBeenNthCalledWith(1, { text: pieces[0], voice: "Calm_Woman" });
        expect(audioState.instances).toHaveLength(1);
        // The second piece is already on its way while the first plays.
        expect(synthesize).toHaveBeenCalledTimes(2);

        for (let index = 0; index < pieces.length; index += 1) {
            audioState.instances[index]!.end();
            await flush();
        }

        await expect(handle.done).resolves.toBeUndefined();
        expect(audioState.instances).toHaveLength(pieces.length);
        expect(spoken).toHaveLength(0);
    });

    it("falls back to the browser voice when synthesis fails, and reports why", async () => {
        const failure = { data: { code: "TOO_MANY_REQUESTS", retryAfter: 5000 } };
        const onUnavailable = vi.fn();
        const handle = speakReply("Hello there. How are you?", {
            lang: "en-US",
            tts: {
                onUnavailable,
                synthesize: async () => {
                    throw failure;
                },
            },
        });

        await flush();

        expect(onUnavailable).toHaveBeenCalledWith(failure);
        expect(audioState.instances).toHaveLength(0);
        expect(spoken.map((utterance) => utterance.text).join(" ")).toBe("Hello there. How are you?");

        spoken.at(-1)!.dispatchEvent(new Event("end"));

        await expect(handle.done).resolves.toBeUndefined();
    });

    it("hands only the unspoken rest to the browser when a later piece fails", async () => {
        const synthesize = vi.fn<Synthesize>(async ({ text }) => audioOf(text));
        const pieces = splitForTts(LONG_REPLY.trim());

        synthesize.mockImplementationOnce(async ({ text }) => audioOf(text)).mockRejectedValueOnce(new Error("network"));

        speakReply(LONG_REPLY, { tts: { synthesize } });
        await flush();
        audioState.instances[0]!.end();
        await flush();

        // Everything after the piece that played, nothing before it.
        expect(spoken.map((utterance) => utterance.text).join(" ")).toBe(pieces.slice(1).join(" "));
    });

    it("falls back when the audio cannot play (autoplay blocked)", async () => {
        audioState.failPlay = true;

        speakReply("Hello there.", { tts: { synthesize: async ({ text }) => audioOf(text) } });
        await flush();

        expect(spoken.map((utterance) => utterance.text)).toEqual(["Hello there."]);
    });

    it("stops the audio and asks for nothing more when cancelled", async () => {
        const synthesize = vi.fn<Synthesize>(async ({ text }) => audioOf(text));
        const handle = speakReply(LONG_REPLY, { tts: { synthesize } });

        await flush();
        handle.cancel();
        audioState.instances[0]!.end();
        await flush();

        await expect(handle.done).resolves.toBeUndefined();
        expect(audioState.instances[0]!.paused).toBe(true);
        expect(audioState.instances).toHaveLength(1);
        expect(synthesize).toHaveBeenCalledTimes(2);
        expect(spoken).toHaveLength(0);
    });

    it("cancels a reply whose first piece is still being synthesised", async () => {
        // The piece arrives only after the (synchronous) cancel below.
        const handle = speakReply("Hello there.", {
            tts: {
                synthesize: async ({ text }) => {
                    await flush();

                    return audioOf(text);
                },
            },
        });

        handle.cancel();
        await flush();

        expect(audioState.instances).toHaveLength(0);
        expect(spoken).toHaveLength(0);
    });

    it("never speaks two replies at once: a new reply, or stopReplySpeech, cancels the current one", async () => {
        const synthesize = vi.fn<Synthesize>(async ({ text }) => audioOf(text));
        const first = speakReply("First reply.", { tts: { synthesize } });

        await flush();

        const second = speakReply("Second reply.", { tts: { synthesize } });

        await expect(first.done).resolves.toBeUndefined();
        expect(audioState.instances[0]!.paused).toBe(true);

        await flush();
        stopReplySpeech();

        await expect(second.done).resolves.toBeUndefined();
        expect(audioState.instances[1]!.paused).toBe(true);
    });
});

describe("speakReply without TTS", () => {
    it("speaks with the browser voice", async () => {
        const handle = speakReply("**Hi** there.", { lang: "en-US" });

        await flush();

        expect(spoken.map((utterance) => utterance.text)).toEqual(["Hi there."]);
        expect(audioState.instances).toHaveLength(0);

        handle.cancel();

        await expect(handle.done).resolves.toBeUndefined();
    });
});

describe(ttsPauseMs, () => {
    it("stops trying for good on a refusal, until the reset on a spent limit, and not after a one-off failure", () => {
        expect(ttsPauseMs({ data: { code: "FORBIDDEN" } })).toBe(Infinity);
        expect(ttsPauseMs({ code: "NOT_IMPLEMENTED" })).toBe(Infinity);
        expect(ttsPauseMs({ data: { code: "TOO_MANY_REQUESTS", retryAfter: 1234 } })).toBe(1234);
        expect(ttsPauseMs({ data: { code: "TOO_MANY_REQUESTS" } })).toBe(60_000);
        expect(ttsPauseMs(new Error("network"))).toBe(0);
    });
});
