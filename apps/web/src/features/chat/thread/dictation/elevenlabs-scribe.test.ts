/**
 * How a Scribe session ends: the server closing cleanly on its own is an end
 * (`onEnd`), an unclean close is an error, and a close that follows our own
 * `stop()` reports nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startScribeSession } from "./elevenlabs-scribe";

type Listener = (event: unknown) => void;

/** Every socket a session opened, newest last. */
const sockets: FakeSocket[] = [];

/** The socket the session opened, driven by the test. */
class FakeSocket {
    public static readonly CLOSED = 3;

    public static readonly CONNECTING = 0;

    public static readonly OPEN = 1;

    public readonly listeners = new Map<string, Listener[]>();

    public readyState = FakeSocket.CONNECTING;

    public readonly sent: string[] = [];

    public constructor() {
        sockets.push(this);
    }

    public addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    public close(): void {
        this.serverClose(true);
    }

    public emit(type: string, event: unknown = {}): void {
        const listeners = this.listeners.get(type) ?? [];

        for (const listener of listeners) {
            listener(event);
        }
    }

    public open(): void {
        this.readyState = FakeSocket.OPEN;
        this.emit("open");
    }

    public send(data: string): void {
        this.sent.push(data);
    }

    /** The server (or our own `close()`) closing the socket. */
    public serverClose(wasClean: boolean): void {
        if (this.readyState === FakeSocket.CLOSED) {
            return;
        }

        this.readyState = FakeSocket.CLOSED;
        this.emit("close", { wasClean });
    }
}

/** The capture worklet (called with `new`); no audio frames are ever posted. */
function createWorkletNode() {
    return { connect: vi.fn(), disconnect: vi.fn(), port: { addEventListener: vi.fn(), close: vi.fn(), removeEventListener: vi.fn(), start: vi.fn() } };
}

const node = () => {
    return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
};

const createAudioContext = () =>
    ({
        audioWorklet: { addModule: vi.fn(async () => undefined) },
        close: vi.fn(async () => undefined),
        createGain: node,
        createMediaStreamSource: node,
        destination: {},
        resume: vi.fn(async () => undefined),
        sampleRate: 48_000,
    }) as unknown as AudioContext;

const createCallbacks = () => {
    return {
        onCommitted: vi.fn<(text: string) => void>(),
        onEnd: vi.fn<() => void>(),
        onError: vi.fn<(message: string) => void>(),
        onPartial: vi.fn<(text: string) => void>(),
    };
};

const start = async (callbacks: ReturnType<typeof createCallbacks>) => {
    const session = await startScribeSession({ audioContext: createAudioContext(), callbacks, token: "token" });
    const socket = sockets.at(-1);

    if (!socket) {
        throw new Error("The session opened no socket");
    }

    socket.open();

    return { session, socket };
};

beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("AudioWorkletNode", createWorkletNode);
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
            getUserMedia: async () => {
                return { getTracks: () => [{ stop: vi.fn() }] };
            },
        },
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    sockets.length = 0;
});

describe("scribe session end", () => {
    it("reports a clean close by the server as an end, once", async () => {
        const callbacks = createCallbacks();
        const { socket } = await start(callbacks);

        socket.serverClose(true);
        socket.emit("close", { wasClean: true });

        expect(callbacks.onEnd).toHaveBeenCalledOnce();
        expect(callbacks.onError).not.toHaveBeenCalled();
    });

    it("reports an unclean close as an error, not an end", async () => {
        const callbacks = createCallbacks();
        const { socket } = await start(callbacks);

        socket.serverClose(false);

        expect(callbacks.onError).toHaveBeenCalledOnce();
        expect(callbacks.onEnd).not.toHaveBeenCalled();
    });

    it("reports nothing for the close its own stop() causes", async () => {
        const callbacks = createCallbacks();
        const { session, socket } = await start(callbacks);

        await session.stop();
        socket.emit("close", { wasClean: true });

        expect(socket.readyState).toBe(FakeSocket.CLOSED);
        expect(callbacks.onEnd).not.toHaveBeenCalled();
        expect(callbacks.onError).not.toHaveBeenCalled();
    });

    it("reports nothing when the server closes while stop() waits for the final commit", async () => {
        const callbacks = createCallbacks();
        const { session, socket } = await start(callbacks);

        // Uncommitted text makes stop() send a final commit and wait for it.
        socket.emit("message", { data: JSON.stringify({ message_type: "partial_transcript", text: "hello" }) });

        const stopping = session.stop();

        socket.serverClose(true);
        await stopping;

        expect(callbacks.onEnd).not.toHaveBeenCalled();
        expect(callbacks.onError).not.toHaveBeenCalled();
    });
});
