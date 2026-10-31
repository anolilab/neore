/**
 * A session the backend starts with a saved session id (harness switch S4): the agent is asked to load it when it
 * said it can, and the backend is told whether that worked. A load that fails opens a fresh session and says why, so
 * the thread hands the conversation over instead of starting from nothing. Against the scripted agent, which refuses
 * `session/load` unless it advertised it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HostSessionInfo, SessionObserver } from "./ingest";
import { AcpManager } from "./manager";
import { spawnAgent } from "./process";
import { Scratch } from "./testing/harness";

let scratch: Scratch;
let manager: AcpManager;
let opened: HostSessionInfo[];

const observer: SessionObserver = {
    permissionRequested: () => {},
    permissionResolved: () => {},
    sessionEnded: () => {},
    sessionOpened: (_id, info) => {
        opened.push(info);
    },
    text: () => {},
    thought: () => {},
    tool: () => {},
    turnEnded: () => {},
    turnStarted: () => {},
};

const startWith = async (env: Record<string, string>, nativeSessionId?: string): Promise<void> => {
    manager = new AcpManager({
        appVersion: "9.9.9",
        hostInfo: () => {
            return { folderId: "f1", folderLabel: "neore" };
        },
        observer,
        onChange: () => {},
        plan: (_key, folder) => scratch.plan(env, folder),
        spawn: spawnAgent,
        startupTimeoutMs: 8000,
    });

    await manager.startSession("fake", "Fake Agent", scratch.work, {
        sessionId: "web-1",
        threadId: "t1",
        ...nativeSessionId !== undefined && { nativeSessionId },
    });
};

const methods = () => scratch.methods();

beforeEach(() => {
    scratch = new Scratch();
    opened = [];
});

afterEach(() => {
    manager.killAll();
    expect(scratch.violations()).toEqual([]);
    scratch.dispose();
});

describe("a start with a saved session id", () => {
    it("loads it when the agent advertised loading, reports it, and opens no new session", async () => {
        await startWith({ FAKE_AGENT_SESSIONS: "list,load" }, "s-new");

        expect(methods()).toContain("session/load");
        expect(methods()).not.toContain("session/new");
        expect(opened[0]).toMatchObject({ nativeSessionId: "s-new", reattach: { loaded: true } });
    });

    it("sends no load frame to an agent that did not advertise it, and opens a new session saying why", async () => {
        await startWith({ FAKE_AGENT_SESSIONS: "list" }, "s-new");

        expect(methods()).not.toContain("session/load");
        expect(methods()).toContain("session/new");
        expect(opened[0]?.reattach?.loaded).toBe(false);
        expect(opened[0]?.reattach?.reason).toContain("does not load");
        expect(opened[0]?.nativeSessionId).toBe("fake-session-1");
    });

    it("opens a new session and gives the agent's reason when the load fails", async () => {
        await startWith({ FAKE_AGENT_SESSIONS: "load" }, "s-gone");

        expect(methods()).toContain("session/load");
        expect(methods()).toContain("session/new");
        expect(opened[0]).toMatchObject({ nativeSessionId: "fake-session-1", reattach: { loaded: false } });
        expect(opened[0]?.reattach?.reason).toBeTruthy();
    });

    it("reports nothing about a reattach on an ordinary start", async () => {
        await startWith({ FAKE_AGENT_SESSIONS: "load" });

        expect(methods()).not.toContain("session/load");
        expect(opened[0]?.reattach).toBeUndefined();
    });
});
