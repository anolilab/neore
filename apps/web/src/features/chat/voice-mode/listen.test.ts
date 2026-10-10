import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ListenCallbacks, ListenSession } from "./listen";
import { classifyListenError, ListenUnsupportedError, superviseQuiet } from "./listen";

vi.mock(import("@/features/chat/thread/dictation/elevenlabs-scribe"), () => {
    return { fetchScribeToken: vi.fn(), startScribeSession: vi.fn() };
});

const TIMEOUT = 1000;

const createCallbacks = () => {
    return {
        onCommitted: vi.fn<(text: string) => void>(),
        onEnd: vi.fn<() => void>(),
        onError: vi.fn<(message: string) => void>(),
        onPartial: vi.fn<(text: string) => void>(),
    };
};

/** A fake engine: exposes the callbacks it was started with. */
const startFake = async (callbacks: ListenCallbacks) => {
    const engine: { callbacks?: ListenCallbacks; stop: ReturnType<typeof vi.fn<() => Promise<void>>> } = { stop: vi.fn(async () => undefined) };
    const session = await superviseQuiet(
        async (supervised): Promise<ListenSession> => {
            engine.callbacks = supervised;

            return { stop: engine.stop };
        },
        callbacks,
        TIMEOUT,
    );

    return { engine: engine as Required<typeof engine>, session };
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe(superviseQuiet, () => {
    it("ends a silent session as a quiet end and stops the engine", async () => {
        const callbacks = createCallbacks();
        const { engine } = await startFake(callbacks);

        await vi.advanceTimersByTimeAsync(TIMEOUT);

        expect(engine.stop).toHaveBeenCalledOnce();
        expect(callbacks.onEnd).toHaveBeenCalledOnce();
    });

    it("restarts the silence timer on every non-blank transcript", async () => {
        const callbacks = createCallbacks();
        const { engine } = await startFake(callbacks);

        await vi.advanceTimersByTimeAsync(TIMEOUT - 100);
        engine.callbacks.onPartial("hello");
        await vi.advanceTimersByTimeAsync(TIMEOUT - 100);
        engine.callbacks.onPartial(" ".repeat(3));
        await vi.advanceTimersByTimeAsync(50);

        expect(callbacks.onEnd).not.toHaveBeenCalled();
        expect(callbacks.onPartial).toHaveBeenCalledWith("hello");

        await vi.advanceTimersByTimeAsync(100);

        expect(callbacks.onEnd).toHaveBeenCalledOnce();
    });

    it("reports an engine's own end once, and never a timeout after it", async () => {
        const callbacks = createCallbacks();
        const { engine } = await startFake(callbacks);

        engine.callbacks.onEnd();
        engine.callbacks.onEnd();
        await vi.advanceTimersByTimeAsync(TIMEOUT * 2);

        expect(callbacks.onEnd).toHaveBeenCalledOnce();
    });

    it("reports nothing after the caller stops it", async () => {
        const callbacks = createCallbacks();
        const { engine, session } = await startFake(callbacks);

        await session.stop();
        engine.callbacks.onEnd();
        await vi.advanceTimersByTimeAsync(TIMEOUT * 2);

        expect(engine.stop).toHaveBeenCalledOnce();
        expect(callbacks.onEnd).not.toHaveBeenCalled();
    });

    it("an error ends the session without a quiet end", async () => {
        const callbacks = createCallbacks();
        const { engine } = await startFake(callbacks);

        engine.callbacks.onError("network");
        await vi.advanceTimersByTimeAsync(TIMEOUT * 2);

        expect(callbacks.onError).toHaveBeenCalledWith("network");
        expect(callbacks.onEnd).not.toHaveBeenCalled();
    });

    it("does not time the engine's start (a permission prompt is not silence)", async () => {
        const callbacks = createCallbacks();
        // The engine takes three timeouts to come up (a slow permission prompt).
        const pending = superviseQuiet(
            async () =>
                await new Promise<ListenSession>((resolve) => {
                    setTimeout(() => resolve({ stop: async () => undefined }), TIMEOUT * 3);
                }),
            callbacks,
            TIMEOUT,
        );

        await vi.advanceTimersByTimeAsync(TIMEOUT * 3);
        await pending;

        expect(callbacks.onEnd).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(TIMEOUT);

        expect(callbacks.onEnd).toHaveBeenCalledOnce();
    });
});

describe(classifyListenError, () => {
    it("maps Web Speech error codes to the translated denied / missing messages", () => {
        expect(classifyListenError(new Error("not-allowed"))).toBe("denied");
        expect(classifyListenError(new Error("service-not-allowed"))).toBe("denied");
        expect(classifyListenError(new Error("audio-capture"))).toBe("missing");
        expect(classifyListenError(new Error("network"))).toBe("other");
    });

    it("maps getUserMedia failures and a missing engine", () => {
        expect(classifyListenError(new DOMException("no", "NotAllowedError"))).toBe("denied");
        expect(classifyListenError(new DOMException("no", "NotFoundError"))).toBe("missing");
        expect(classifyListenError(new ListenUnsupportedError())).toBe("unsupported");
    });
});
