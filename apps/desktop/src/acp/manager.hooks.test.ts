/** File-event hooks through the manager and a real scripted agent: the prompt arrives as a normal turn, and the watcher lives with the session. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HookApprovals } from "./hooks/approvals";
import { FakeFs } from "./hooks/fake-fs";
import { DEBOUNCE_MS } from "./hooks/runner";
import { AcpManager } from "./manager";
import { spawnAgent } from "./process";
import { Scratch } from "./testing/harness";

const REVIEW_PROMPT = /^\[Hook "Review"\] Review the file\./u;

let scratch: Scratch;
let manager: AcpManager;
let fs: FakeFs;
let stateFolder: string;

const hooks = JSON.stringify({
    hooks: [
        { glob: "src/*.ts", id: "review", name: "Review", on: "saved", prompt: "Review the file." },
        { id: "summary", name: "Summary", on: "manual", prompt: "Summarise." },
    ],
    version: 1,
});

const start = async (): Promise<string> => {
    const id = await manager.startSession("fake", "Fake", scratch.work);

    // The watcher is set up right after the handshake.
    await expect.poll(() => fs.watching, { timeout: 4000 }).toBe(true);

    return id;
};

const idle = (id: string) => expect.poll(() => manager.snapshot(id).status, { timeout: 8000 }).toBe("idle");

beforeEach(() => {
    scratch = new Scratch();
    stateFolder = mkdtempSync(path.join(tmpdir(), "neore-hooks-state-"));
    fs = new FakeFs(scratch.work);
    fs.write(".neore/hooks.json", hooks);
    fs.write("src/a.ts");
    manager = new AcpManager({
        appVersion: "9.9.9",
        cancelGraceMs: 400,
        hooks: { approvals: new HookApprovals(path.join(stateFolder, "approvals.json")), fs },
        onChange: () => {},
        plan: (_key, folder) => scratch.plan({}, folder),
        spawn: spawnAgent,
        startupTimeoutMs: 8000,
    });
});

afterEach(() => {
    manager.killAll();
    scratch.dispose();
    rmSync(stateFolder, { force: true, recursive: true });
});

describe("hooks in a session", () => {
    it("sends a manual hook's prompt as a normal turn of the open session, once approved", async () => {
        const id = await start();
        const view = await manager.hooks(id);

        expect(view.state).toBe("unapproved");
        expect(view.hooks.map((hook) => hook.id)).toEqual(["review", "summary"]);

        await expect(manager.runHook(id, "summary", view.hash as string)).rejects.toThrow("approved");
        await manager.approveHooks(id, view.hash as string);
        await manager.runHook(id, "summary", view.hash as string);
        await idle(id);

        expect(manager.snapshot(id).turns[0]).toMatchObject({ stopReason: "end_turn", user: "[Hook \"Summary\"] Summarise." });
        expect(scratch.log().find((entry) => entry.prompt !== undefined)?.prompt).toContain("Summarise.");
        expect(scratch.violations()).toEqual([]);
    });

    it("prompts the open session when an approved file is saved, and not for its own writes afterwards", async () => {
        const id = await start();

        const view = await manager.hooks(id);

        await manager.approveHooks(id, view.hash as string);
        fs.emit("change", "src/a.ts");
        await expect.poll(() => manager.snapshot(id).turns.length, { timeout: DEBOUNCE_MS + 4000 }).toBe(1);
        await idle(id);

        expect(manager.snapshot(id).turns[0]?.user).toMatch(REVIEW_PROMPT);

        // The agent's reply is over; what the watcher delivers right after it is the agent's own.
        fs.emit("change", "src/a.ts");
        await new Promise((resolve) => {
            setTimeout(resolve, DEBOUNCE_MS + 300);
        });

        expect(manager.snapshot(id).turns).toHaveLength(1);
    });

    it("starts nothing by itself: with no session open there is no watcher and no hook to run", async () => {
        expect(fs.watching).toBe(false);
        expect(manager.summaries()).toEqual([]);
        await expect(manager.runHook("no-such-session", "summary", "x")).rejects.toThrow("no longer exists");
    });

    it("stops watching when the session is closed", async () => {
        const id = await start();

        await manager.close(id);

        expect(fs.closed).toBe(true);
        await expect(manager.runHook(id, "summary", "x")).rejects.toThrow("ended");
    });

    it("stops watching when the agent goes away on its own", async () => {
        const id = await start();

        manager.killAll();
        await expect.poll(() => fs.closed, { timeout: 8000 }).toBe(true);
        expect(manager.snapshot(id).status).toBe("ended");
    });
});
