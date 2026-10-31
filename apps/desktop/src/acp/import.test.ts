/**
 * Importing an agent's saved sessions against the scripted agent (`testing/fake-agent.mjs`), which checks every
 * frame the host writes against the SDK's schema and refuses `session/list` or `session/load` unless it advertised them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PostResult } from "./host-events";
import { AcpImporter, hostSessionIdOf } from "./import";
import type { ImportIo } from "./import-post";
import { AcpManager } from "./manager";
import { spawnAgent } from "./process";
import { Scratch } from "./testing/harness";

let scratch: Scratch;
let manager: AcpManager;

/** A post as the backend reads it. */
interface Payload {
    deviceId: string;
    events: { capabilities?: { groups: { sessions: unknown } }; kind: string }[];
    firstSeq?: number;
    sessionId: string;
    threadId?: string;
}

let posted: Payload[];
let deviceId: string | undefined;
let backend: (payload: Payload) => PostResult;

const APPROVED = { folderId: "f1", folderLabel: "neore" };

const make = (env: Record<string, string>, approved: () => { folderId: string; folderLabel: string } | undefined = () => APPROVED): AcpImporter => {
    manager = new AcpManager({
        appVersion: "9.9.9",
        onChange: () => {},
        plan: (_key, folder) => scratch.plan(env, folder),
        spawn: spawnAgent,
        startupTimeoutMs: 8000,
    });

    const io: ImportIo = {
        deviceId: () => deviceId,
        now: () => 1_700_000_000_000,
        random: () => 0.5,
        request: async (payload) => {
            const parsed = JSON.parse(payload) as Payload;

            posted.push(parsed);

            return backend(parsed);
        },
        sleep: async () => {},
    };

    return new AcpImporter({
        agentLabel: (key) => key === "fake" ? "Fake Agent" : undefined,
        agents: manager,
        hostInfo: approved,
        io,
    });
};

/** A backend that holds nothing yet: the open makes the thread, every batch is taken, the end finishes. */
const freshBackend = (): (payload: Payload) => PostResult => {
    let held = 0;

    return (payload) => {
        const [first] = payload.events;

        if (first?.kind === "import_open") {
            return { ended: false, existing: false, kind: "ok", next: 0, threadId: "thread-1" };
        }

        held = (payload.firstSeq ?? 0) + payload.events.filter((event) => event.kind === "import_turn").length;

        return { ended: payload.events.some((event) => event.kind === "import_end"), kind: "ok", next: held, threadId: "thread-1" };
    };
};

const frames = (name: string) => scratch.methods().filter((method) => method === name);

beforeEach(() => {
    scratch = new Scratch();
    posted = [];
    deviceId = "device-1";
    backend = freshBackend();
});

afterEach(() => {
    manager.killAll();
    expect(scratch.violations()).toEqual([]);
    scratch.dispose();
});

describe("listing", () => {
    it("lists the sessions of the approved folder, newest first, across pages", async () => {
        const importer = make({ FAKE_AGENT_ELSEWHERE: "1", FAKE_AGENT_PAGES: "1", FAKE_AGENT_SESSIONS: "list,load" });

        await expect(importer.list("fake", scratch.work)).resolves.toEqual([
            { sessionId: "s-new", title: "New chat", updatedAt: "2026-02-01T00:00:00Z" },
            { sessionId: "s-old", title: "Old chat", updatedAt: "2026-01-01T00:00:00Z" },
        ]);
        expect(scratch.log().filter((entry) => entry.received?.method === "session/list")).toHaveLength(2);
    });

    it("sends no list frame to an agent that did not advertise listing", async () => {
        for (const sessions of ["", "load"]) {
            const importer = make({ FAKE_AGENT_SESSIONS: sessions });

            // eslint-disable-next-line no-await-in-loop -- one agent after another
            await expect(importer.list("fake", scratch.work)).rejects.toThrow("does not list its saved sessions");
        }

        expect(frames("session/list")).toEqual([]);
    });
});

describe("importing", () => {
    it("loads the session and saves it as turns, opening with what the agent advertised", async () => {
        const importer = make({ FAKE_AGENT_SESSIONS: "list,load" });

        await expect(importer.import("fake", scratch.work, "s-new", "New chat")).resolves.toEqual({ droppedTurns: 0, shortenedTurns: 0, status: "imported", turns: 2 });

        const [open, turns] = posted;

        expect(open).toMatchObject({
            deviceId: "device-1",
            events: [{ agentKey: "fake", agentLabel: "Fake Agent", folderId: "f1", folderLabel: "neore", kind: "import_open", nativeSessionId: "s-new", title: "New chat" }],
            kind: "turn",
            sessionId: hostSessionIdOf("fake", "s-new"),
        });
        expect(open?.events[0]?.capabilities?.groups.sessions).toEqual({
            listNative: { degradation: "none", supported: true },
            load: { degradation: "none", supported: true },
        });
        expect(JSON.stringify(posted)).not.toContain(scratch.work);
        expect(turns).toMatchObject({
            events: [
                { kind: "import_turn", reasoning: "hm", text: "Done.", user: "fix the bug" },
                { kind: "import_turn", text: "Tests too.", user: "and the tests" },
                { kind: "import_end" },
            ],
            firstSeq: 0,
            threadId: "thread-1",
        });
        expect(scratch.log().find((entry) => entry.received?.method === "session/load")?.received?.params).toMatchObject({ cwd: scratch.work, sessionId: "s-new" });
    });

    it("sends nothing past the open when the session is already in Neore", async () => {
        const importer = make({ FAKE_AGENT_SESSIONS: "list,load" });

        backend = () => {
            return { ended: true, existing: true, kind: "ok", next: 2, threadId: "thread-1" };
        };

        await expect(importer.import("fake", scratch.work, "s-new")).resolves.toEqual({ status: "already" });
        expect(posted).toHaveLength(1);
    });

    it("posts nothing when the folder's approval was withdrawn while the history loaded", async () => {
        const answers = [APPROVED];
        const importer = make({ FAKE_AGENT_SESSIONS: "list,load" }, () => answers.shift());

        backend = freshBackend();

        await expect(importer.import("fake", scratch.work, "s-new")).rejects.toThrow("approve this folder");
        expect(posted).toEqual([]);
    });

    it("resumes an import the backend holds part of", async () => {
        const importer = make({ FAKE_AGENT_SESSIONS: "list,load" });
        const fresh = freshBackend();

        backend = (payload) => payload.events[0]?.kind === "import_open" ? { ended: false, existing: true, kind: "ok", next: 1, threadId: "thread-1" } : fresh(payload);

        await importer.import("fake", scratch.work, "s-new");

        expect(posted[1]).toMatchObject({ events: [{ text: "Tests too." }, { kind: "import_end" }], firstSeq: 1 });
    });

    it("sends no load frame to an agent that did not advertise loading, and posts nothing", async () => {
        for (const sessions of ["", "list"]) {
            const importer = make({ FAKE_AGENT_SESSIONS: sessions });

            // eslint-disable-next-line no-await-in-loop -- one agent after another
            await expect(importer.import("fake", scratch.work, "s-new")).rejects.toThrow("does not load its saved sessions");
        }

        expect(frames("session/load")).toEqual([]);
        expect(posted).toEqual([]);
    });

    it("sends no load frame for an agent that loads but does not list, or for a session outside the folder", async () => {
        await expect(make({ FAKE_AGENT_SESSIONS: "load" }).import("fake", scratch.work, "s-new")).rejects.toThrow("does not list its saved sessions");

        const importer = make({ FAKE_AGENT_ELSEWHERE: "1", FAKE_AGENT_SESSIONS: "list,load" });

        await expect(importer.import("fake", scratch.work, "s-elsewhere")).rejects.toThrow("not one of this folder's saved sessions");
        await expect(importer.import("fake", scratch.work, "s-unlisted")).rejects.toThrow("not one of this folder's saved sessions");
        expect(frames("session/load")).toEqual([]);
        expect(posted).toEqual([]);
    });

    it("starts nothing for a computer that is not paired, or an agent that is not registered", async () => {
        const importer = make({ FAKE_AGENT_SESSIONS: "list,load" });

        deviceId = undefined;
        await expect(importer.import("fake", scratch.work, "s-new")).rejects.toThrow("pair this computer");
        deviceId = "device-1";
        await expect(importer.import("nobody", scratch.work, "s-new")).rejects.toThrow("not registered");
        expect(scratch.methods()).toEqual([]);
    });

    it("leaves no thread behind when the agent cannot load the session", async () => {
        const importer = make({ FAKE_AGENT_SESSIONS: "list,load" });

        await expect(importer.import("fake", scratch.work, "s-missing")).rejects.toThrow();
        expect(posted).toEqual([]);
    });

    it("gives up on a backend that refuses", async () => {
        const importer = make({ FAKE_AGENT_SESSIONS: "list,load" });

        backend = () => {
            return { kind: "refused" };
        };

        await expect(importer.import("fake", scratch.work, "s-new")).rejects.toThrow("refused");
        expect(posted).toHaveLength(1);
    });

    it("retries a post that fails and then goes on from the same place", async () => {
        const importer = make({ FAKE_AGENT_SESSIONS: "list,load" });
        const fresh = freshBackend();
        let failures = 2;

        backend = (payload) => {
            if (payload.events[0]?.kind !== "import_open" && failures > 0) {
                failures -= 1;

                return { kind: "retry" };
            }

            return fresh(payload);
        };

        await expect(importer.import("fake", scratch.work, "s-new")).resolves.toMatchObject({ status: "imported" });
        expect(posted.filter((payload) => payload.firstSeq === 0)).toHaveLength(3);
    });
});
