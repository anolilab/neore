import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostEvent, HostRequest } from "./protocol";
import type { HostHandle } from "./session";
import { HIGH_WATERMARK_CHARS, LOW_WATERMARK_CHARS, startSession } from "./session";

/** A host that records what it is sent and emits what a test tells it to. */
const fakeHost = () => {
    const posted: HostRequest[] = [];
    let message: (event: HostEvent) => void = () => {};
    let exit: () => void = () => {};
    const handle: HostHandle = {
        kill: vi.fn(() => exit()),
        onExit: (listener) => {
            exit = listener;
        },
        onMessage: (listener) => {
            message = listener;
        },
        post: (request) => {
            posted.push(request);
        },
    };

    return { emit: (event: HostEvent) => message(event), handle, posted, stop: () => exit() };
};

const spawn = { args: ["-l"], cols: 80, cwd: "/tmp", env: {}, file: "/bin/sh", rows: 24 };

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

const started = async (host = fakeHost(), onData = vi.fn(), onExit = vi.fn()) => {
    const promise = startSession({ onData, onExit, spawn, startHost: () => host.handle });

    host.emit({ pid: 4242, type: "started" });

    return { host, onData, onExit, session: await promise };
};

describe("startSession", () => {
    it("asks the host to spawn and resolves once it reports the shell", async () => {
        const { host, session } = await started();

        expect(host.posted[0]).toEqual({ type: "spawn", ...spawn });
        expect(session.pid).toBe(4242);
    });

    it("gives up and kills the host when it does not start in time", async () => {
        const host = fakeHost();
        const promise = startSession({ deadlineMs: 1000, onData: vi.fn(), onExit: vi.fn(), spawn, startHost: () => host.handle });
        const assertion = expect(promise).rejects.toThrow("did not start in time");

        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
        expect(host.handle.kill).toHaveBeenCalled();
    });

    it("rejects with the host's reason when the shell cannot be started", async () => {
        const host = fakeHost();
        const promise = startSession({ onData: vi.fn(), onExit: vi.fn(), spawn, startHost: () => host.handle });

        host.emit({ message: "Failed to load native module", type: "error" });
        await expect(promise).rejects.toThrow("Failed to load native module");
        expect(host.handle.kill).toHaveBeenCalled();
    });

    it("rejects when the host goes away before the shell starts", async () => {
        const host = fakeHost();
        const promise = startSession({ onData: vi.fn(), onExit: vi.fn(), spawn, startHost: () => host.handle });

        host.stop();
        await expect(promise).rejects.toThrow("stopped before the shell started");
    });
});

describe("a running session", () => {
    it("passes output, input and resizes through", async () => {
        const { host, onData, session } = await started();

        host.emit({ data: "hello", type: "data" });
        session.write("ls\n");
        session.resize(100, 30);

        expect(onData).toHaveBeenCalledWith("hello");
        expect(host.posted).toContainEqual({ data: "ls\n", type: "input" });
        expect(host.posted).toContainEqual({ cols: 100, rows: 30, type: "resize" });
    });

    it("reports the shell's exit once", async () => {
        const { host, onExit } = await started();

        host.emit({ exitCode: 0, signal: 0, type: "exit" });
        host.stop();

        expect(onExit).toHaveBeenCalledTimes(1);
        expect(onExit).toHaveBeenCalledWith({ crashed: false, exitCode: 0 });
    });

    it("reports a host that vanished as a crash", async () => {
        const { host, onExit } = await started();

        host.stop();

        expect(onExit).toHaveBeenCalledWith({ crashed: true, exitCode: null });
    });

    it("ignores input and output after the end", async () => {
        const { host, onData, session } = await started();

        host.emit({ exitCode: 1, signal: 0, type: "exit" });
        host.emit({ data: "late", type: "data" });
        session.write("x");

        expect(onData).not.toHaveBeenCalled();
        expect(host.posted.filter((request) => request.type === "input")).toHaveLength(0);
    });

    it("kill asks the host to hang up, and kills a host that stays", async () => {
        const { host, session } = await started();

        session.kill();
        expect(host.posted).toContainEqual({ type: "kill" });
        expect(host.handle.kill).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2500);
        expect(host.handle.kill).toHaveBeenCalledTimes(1);
    });

    it("killNow signals the shell before it returns, then kills the host", async () => {
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
        const { host, session } = await started();

        session.killNow();

        expect(signal).toHaveBeenCalledWith(4242, "SIGHUP");
        expect(host.handle.kill).toHaveBeenCalled();
        signal.mockRestore();
    });
});

describe("backpressure", () => {
    it("pauses the shell past the high mark and resumes it at the low mark", async () => {
        const { host, session } = await started();
        const chunk = "x".repeat(64 * 1024);
        let sent = 0;

        while (sent < HIGH_WATERMARK_CHARS) {
            host.emit({ data: chunk, type: "data" });
            sent += chunk.length;
        }

        expect(host.posted.filter((request) => request.type === "pause")).toHaveLength(1);

        // Still above the low mark: stays paused.
        session.ack(sent - LOW_WATERMARK_CHARS - 1024);
        expect(host.posted.filter((request) => request.type === "resume")).toHaveLength(0);

        session.ack(2048);
        expect(host.posted.filter((request) => request.type === "resume")).toHaveLength(1);
    });
});
