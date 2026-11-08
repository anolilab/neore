/**
 * The sign-in check and sign-out against the real scripted agent (`testing/fake-agent.mjs`), which checks every
 * frame against the SDK's schema. `FAKE_AGENT_AUTH_FILE` stands for the agent's own stored sign-in.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AcpManager } from "./manager";
import { spawnAgent } from "./process";
import { AgentSignIn } from "./sign-in";
import { Scratch } from "./testing/harness";

const SENTINEL = "sentinel-secret-5c1d";

let scratch: Scratch;
let authFile: string;

const setUp = (env: Record<string, string>): { manager: AcpManager; signIn: AgentSignIn } => {
    const manager = new AcpManager({
        appVersion: "9.9.9",
        onChange: () => {},
        plan: (_key, folder) => scratch.plan(env, folder),
        spawn: spawnAgent,
        startupTimeoutMs: 8000,
    });

    return { manager, signIn: new AgentSignIn({ agents: manager, folder: path.join(scratch.dir, "sign-in"), now: () => 42 }) };
};

beforeEach(() => {
    scratch = new Scratch();
    authFile = path.join(scratch.dir, "agent-auth");
    writeFileSync(authFile, "");
});

afterEach(() => {
    expect(scratch.violations()).toStrictEqual([]);
    scratch.dispose();
});

describe("the sign-in check", () => {
    it("reports a signed-in agent, opening the session in the same private folder each time", async () => {
        const { signIn } = setUp({ FAKE_AGENT_AUTH_FILE: authFile, FAKE_AGENT_LOGOUT: "1" });

        await expect(signIn.status("fake")).resolves.toStrictEqual({ agentKey: "fake", canSignOut: true, checkedAt: 42, detail: "", state: "signed_in" });
        await signIn.status("fake");

        const folders = scratch.log().flatMap((entry) => (entry.sessionNew === undefined ? [] : [(entry.sessionNew as { cwd: string }).cwd]));

        expect(folders).toStrictEqual([path.join(scratch.dir, "sign-in", "fake"), path.join(scratch.dir, "sign-in", "fake")]);
        expect(scratch.methods()).not.toContain("session/prompt");
    });

    it("reports a signed-out agent when it answers AUTH_REQUIRED", async () => {
        const { signIn } = setUp({ FAKE_AGENT_AUTH: "1" });

        await expect(signIn.status("fake")).resolves.toMatchObject({ canSignOut: false, detail: "", state: "signed_out" });
    });

    it("reports any other failure as unknown, in the agent's words with the user's values masked", async () => {
        const { signIn } = setUp({ API_KEY: SENTINEL, FAKE_AGENT_SESSION_ERROR: "1" });
        const status = await signIn.status("fake");

        expect(status.state).toBe("unknown");
        expect(status.detail).toContain("cannot start");
        expect(status.detail).not.toContain(SENTINEL);
    });
});

describe("signing out", () => {
    it("ends the agent's open sessions, signs it out, and reports what the agent says afterwards", async () => {
        const { manager, signIn } = setUp({ FAKE_AGENT_AUTH_FILE: authFile, FAKE_AGENT_LOGOUT: "1" });
        const sessionId = await manager.startSession("fake", "Fake", scratch.work);

        await expect(signIn.signOut("fake")).resolves.toMatchObject({ state: "signed_out" });
        expect(manager.statusOf(sessionId)).toBe("ended");
        expect(existsSync(authFile)).toBe(false);
        expect(scratch.methods()).toContain("logout");
    });

    it("refuses an agent that has no sign-out before ending any of its sessions", async () => {
        const { manager, signIn } = setUp({ FAKE_AGENT_AUTH_FILE: authFile });
        const sessionId = await manager.startSession("fake", "Fake", scratch.work);

        await expect(signIn.signOut("fake")).rejects.toThrow("cannot be signed out from Neore");
        expect(manager.statusOf(sessionId)).not.toBe("ended");
        expect(scratch.methods()).not.toContain("logout");
        expect(existsSync(authFile)).toBe(true);
        manager.killAll();
    });

    it("starts no session of the agent and no second sign-out while one runs", async () => {
        const { manager, signIn } = setUp({ FAKE_AGENT_AUTH_FILE: authFile, FAKE_AGENT_LOGOUT: "1" });
        const signingOut = signIn.signOut("fake");

        await expect(manager.startSession("fake", "Fake", scratch.work)).rejects.toThrow("being signed out");
        await expect(signIn.signOut("fake")).rejects.toThrow("already being signed out");
        await expect(signingOut).resolves.toMatchObject({ state: "signed_out" });
    });

    it("refuses a start that would replace a thread's session without ending that session", async () => {
        const { manager } = setUp({ FAKE_AGENT_AUTH_FILE: authFile });
        const running = await manager.startSession("fake", "Fake", scratch.work, { sessionId: "session-1", threadId: "thread-1" });
        let release = (): void => {};
        const holding = manager.holdingAgent("fake", async () => await new Promise<void>((resolve) => { release = resolve; }));

        await expect(manager.startSession("fake", "Fake", scratch.work, { sessionId: "session-2", threadId: "thread-1" })).rejects.toThrow("being signed out");
        expect(manager.statusOf(running)).not.toBe("ended");
        release();
        await holding;
        manager.killAll();
    });
});
