/**
 * A coding agent's terminals: offered only to a session whose folder is on this computer, each create asked about
 * once (never "always", only in this window), run by the core, read back by the id this session minted, and killed on
 * cancel and released when the session ends. A tool call that shows a terminal reports its output and exit once it ended.
 */
import { describe, expect, it, vi } from "vitest";

import type { HostSessionInfo, SessionObserver } from "./ingest";
import type { PermissionGate, PermissionRequest } from "./permission";
import { AgentSession } from "./session";
import type { TerminalExitStatus, TerminalHost } from "./terminals";
import type { MemoryAgent } from "./testing/harness";
import { memoryAgent } from "./testing/harness";

const HOST_INFO: HostSessionInfo = { agentKey: "example", agentLabel: "Example", folderId: "f1", folderLabel: "neore" };

const fakeHost = () => {
    let finish: (exit: TerminalExitStatus) => void = () => {};
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` is not in this package's TypeScript lib
    const exited = new Promise<TerminalExitStatus>((resolve) => {
        finish = resolve;
    });
    const host = {
        available: vi.fn(() => true),
        kill: vi.fn(),
        output: vi.fn(() => {
            return { exitStatus: null, output: "building...\nok", truncated: false };
        }),
        release: vi.fn(),
        start: vi.fn(async () => 41),
        wait: vi.fn(async () => await exited),
    } satisfies TerminalHost;

    return { finish, host };
};

const allow = (asked: PermissionRequest[]): PermissionGate => {
    return {
        ask: async (request) => {
            asked.push(request);

            return { optionId: "allow", outcome: "selected" };
        },
        cancelSession: () => {},
    };
};

/** The frame the host wrote for `method`, once it has. */
const frameFor = async (agent: MemoryAgent, method: string): Promise<Record<string, unknown>> => {
    await expect.poll(() => agent.written.some((frame) => frame.method === method)).toBe(true);

    return agent.written.find((frame) => frame.method === method) ?? {};
};

/** The host's answer to the agent's request `id`, once it has. */
const answerTo = async (agent: MemoryAgent, id: number): Promise<Record<string, unknown>> => {
    await expect.poll(() => agent.written.some((frame) => frame.id === id && !("method" in frame))).toBe(true);

    return agent.written.find((frame) => frame.id === id && !("method" in frame)) ?? {};
};

const open = async (options: { cancelGraceMs?: number; folderIsRemote?: boolean; gate: PermissionGate; host: TerminalHost; observer?: SessionObserver }) => {
    const agent = memoryAgent();
    const session = new AgentSession({
        agentKey: "example",
        agentLabel: "Example",
        appVersion: "9.9.9",
        folder: "/work",
        gate: options.gate,
        onChange: () => {},
        process: agent.process,
        terminals: options.host,
        ...options.cancelGraceMs !== undefined && { cancelGraceMs: options.cancelGraceMs },
        ...options.folderIsRemote === true && { folderIsRemote: true },
        ...options.observer !== undefined && { hostInfo: HOST_INFO, observer: options.observer },
    });
    const started = session.start();
    const initialize = await frameFor(agent, "initialize");

    agent.say({ id: initialize.id, result: { agentCapabilities: {}, protocolVersion: 1 } });

    const opened = await frameFor(agent, "session/new");

    agent.say({ id: opened.id, result: { sessionId: "sess_1" } });
    await started;

    return { agent, initialize, session };
};

/** Starts a turn, so a request has something to authorize. */
const busy = async (agent: MemoryAgent, session: AgentSession): Promise<Record<string, unknown>> => {
    session.send("build it");

    return await frameFor(agent, "session/prompt");
};

const create = (agent: MemoryAgent, id: number, params: Record<string, unknown> = {}): void => {
    agent.say({ id, method: "terminal/create", params: { args: ["--watch", "it's"], command: "npm test", sessionId: "sess_1", ...params } });
};

describe("a session's terminals", () => {
    it("are offered only by a session whose folder is on this computer", async () => {
        const local = await open({ gate: allow([]), host: fakeHost().host });
        const server = await open({ folderIsRemote: true, gate: allow([]), host: fakeHost().host });

        expect(local.initialize).toMatchObject({ params: { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true } } });
        expect(server.initialize).toMatchObject({ params: { clientCapabilities: { terminal: false } } });

        await busy(server.agent, server.session);
        create(server.agent, 5);
        expect(await answerTo(server.agent, 5)).toMatchObject({ error: { code: -32_601 } });
    });

    it("are not offered where the computer could not start one", async () => {
        const unavailable = await open({ gate: allow([]), host: { ...fakeHost().host, available: () => false } });

        expect(unavailable.initialize).toMatchObject({ params: { clientCapabilities: { terminal: false } } });
    });

    it("asks once, in this window only, with the exact line and only allow-once or decline, then runs it through the core", async () => {
        const asked: PermissionRequest[] = [];
        const { finish, host } = fakeHost();
        const { agent, session } = await open({ gate: allow(asked), host });

        await busy(agent, session);
        create(agent, 5, { cwd: "/work/app", env: [{ name: "CI", value: "1" }], outputByteLimit: 1000 });

        const created = await answerTo(agent, 5);

        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({
            localOnly: true,
            params: {
                options: [
                    { kind: "allow_once", optionId: "allow" },
                    { kind: "reject_once", optionId: "decline" },
                ],
                toolCall: { kind: "execute", rawInput: { command: String.raw`env CI=1 sh -c 'npm test --watch '\''it'\''\'\'''\''s'\'''`, cwd: "/work/app" } },
            },
        });
        expect(host.start).toHaveBeenCalledWith({
            agentKey: "example",
            cwd: "/work/app",
            env: [["CI", "1"]],
            folder: "/work",
            line: String.raw`npm test --watch 'it'\''s'`,
            outputByteLimit: 1000,
        });

        const { terminalId } = created.result as { terminalId: string };

        expect(terminalId.startsWith("term_")).toBe(true);

        agent.say({ id: 6, method: "terminal/output", params: { sessionId: "sess_1", terminalId } });
        expect(await answerTo(agent, 6)).toMatchObject({ result: { output: "building...\nok", truncated: false } });

        agent.say({ id: 7, method: "terminal/kill", params: { sessionId: "sess_1", terminalId } });
        await answerTo(agent, 7);
        expect(host.kill).toHaveBeenCalledWith(41);

        // An id this session did not mint names nothing, whoever's it is.
        agent.say({ id: 8, method: "terminal/output", params: { sessionId: "sess_1", terminalId: "41" } });
        expect(await answerTo(agent, 8)).toMatchObject({ error: { code: -32_602 } });

        agent.say({ id: 9, method: "terminal/release", params: { sessionId: "sess_1", terminalId } });
        await answerTo(agent, 9);

        // The released command exits, and only then is its core handle freed (after its output was read).
        finish({ exitCode: null, signal: "SIGKILL" });
        await expect.poll(() => host.release.mock.calls.length).toBe(1);
        expect(host.release).toHaveBeenCalledWith(41);
    });

    it("starts nothing when the person declines, or outside a running turn", async () => {
        const { host } = fakeHost();
        const decline: PermissionGate = {
            ask: async () => {
                return { optionId: "decline", outcome: "selected" };
            },
            cancelSession: () => {},
        };
        const { agent, session } = await open({ gate: decline, host });

        create(agent, 4);
        expect(await answerTo(agent, 4)).toMatchObject({ error: {} });

        await busy(agent, session);
        create(agent, 5);
        expect(await answerTo(agent, 5)).toMatchObject({ error: { message: "the command was not allowed" } });
        expect(host.start).not.toHaveBeenCalled();
    });

    it("reports a tool call's terminal output and exit once the terminal ended", async () => {
        const tools: unknown[] = [];
        const observer: SessionObserver = {
            permissionRequested: () => {},
            permissionResolved: () => {},
            sessionEnded: () => {},
            sessionOpened: () => {},
            text: () => {},
            thought: () => {},
            tool: (_session, _turn, tool) => {
                tools.push(tool);
            },
            turnEnded: () => {},
            turnStarted: () => {},
        };
        const { finish, host } = fakeHost();
        const { agent, session } = await open({ gate: allow([]), host, observer });

        await busy(agent, session);
        create(agent, 5);

        const answer = await answerTo(agent, 5);
        const { terminalId } = answer.result as { terminalId: string };

        agent.say({
            method: "session/update",
            params: { sessionId: "sess_1", update: { content: [{ terminalId, type: "terminal" }], kind: "execute", sessionUpdate: "tool_call", status: "in_progress", title: "npm test", toolCallId: "call_1" } },
        });
        await expect.poll(() => tools.length).toBe(1);
        expect(tools[0]).not.toHaveProperty("output");

        finish({ exitCode: 0, signal: null });
        await expect.poll(() => tools.length).toBe(2);
        expect(tools[1]).toMatchObject({ exit: { code: 0 }, id: "call_1", output: "building...\nok" });

        agent.say({ id: 6, method: "terminal/wait_for_exit", params: { sessionId: "sess_1", terminalId } });
        expect(await answerTo(agent, 6)).toMatchObject({ result: { exitCode: 0, signal: null } });
    });

    it("ends a command that finishes starting after its turn was cancelled and a queued turn began", async () => {
        let startedWith: (id: number) => void = () => {};
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` is not in this package's TypeScript lib
        const starting = new Promise<number>((resolve) => {
            startedWith = resolve;
        });
        const host = {
            available: vi.fn(() => true),
            kill: vi.fn(),
            output: vi.fn(() => {
                return { exitStatus: null, output: "", truncated: false };
            }),
            release: vi.fn(),
            start: vi.fn(async () => await starting),
            wait: vi.fn(async () => await new Promise<TerminalExitStatus>(() => {})),
        } satisfies TerminalHost;
        const { agent, session } = await open({ gate: allow([]), host });

        const first = await busy(agent, session);

        create(agent, 5);
        await expect.poll(() => host.start.mock.calls.length).toBe(1);

        // The asking turn is cancelled and ends; the queued turn starts and resets the session's cancel flag.
        session.cancel();
        agent.say({ id: first.id, result: { stopReason: "cancelled" } });
        session.send("second");
        await expect.poll(() => agent.written.filter((frame) => frame.method === "session/prompt").length).toBe(2);

        startedWith(41);

        expect(await answerTo(agent, 5)).toMatchObject({ error: {} });
        expect(host.kill).toHaveBeenCalledWith(41);
    });

    it("are killed when the turn is cancelled and released when the session ends", async () => {
        const { host } = fakeHost();
        const { agent, session } = await open({ gate: allow([]), host });

        await busy(agent, session);
        create(agent, 5);
        await answerTo(agent, 5);

        session.cancel();
        expect(host.kill).toHaveBeenCalledWith(41);

        await session.close();
        expect(host.release).toHaveBeenCalledWith(41);
    });

    it("does not end an agent that answered the cancel in time, while a killed command's result is still due", async () => {
        const events: { kind: string; reason?: string }[] = [];
        const observer: SessionObserver = {
            permissionRequested: () => {},
            permissionResolved: () => {},
            sessionEnded: () => {
                events.push({ kind: "sessionEnded" });
            },
            sessionOpened: () => {},
            text: () => {},
            thought: () => {},
            tool: () => {},
            turnEnded: (_session, _turn, reason) => {
                events.push({ kind: "turnEnded", reason });
            },
            turnStarted: () => {},
        };
        const { finish, host } = fakeHost();
        const { agent, session } = await open({ cancelGraceMs: 400, gate: allow([]), host, observer });
        const first = await busy(agent, session);

        create(agent, 5);
        await answerTo(agent, 5);

        session.cancel();
        // The agent stops right away. The grace period runs on, while the killed command's exit is still to come.
        agent.say({ id: first.id, result: { stopReason: "cancelled" } });
        await new Promise((resolve) => {
            setTimeout(() => {
                resolve(undefined);
            }, 1000);
        });
        finish({ exitCode: null, signal: "SIGKILL" });

        await expect.poll(() => events.some((event) => event.kind === "turnEnded")).toBe(true);
        expect(events).toEqual([{ kind: "turnEnded", reason: "cancelled" }]);
    });

    it("reports a cancelled command's exit before the cancelled turn ends", async () => {
        type ToolReport = Parameters<SessionObserver["tool"]>[2];
        const events: { kind: string; tool?: ToolReport }[] = [];
        const observer: SessionObserver = {
            permissionRequested: () => {},
            permissionResolved: () => {},
            sessionEnded: () => {},
            sessionOpened: () => {},
            text: () => {},
            thought: () => {},
            tool: (_session, _turn, tool) => {
                events.push({ kind: "tool", tool });
            },
            turnEnded: () => {
                events.push({ kind: "turnEnded" });
            },
            turnStarted: () => {},
        };
        const { finish, host } = fakeHost();
        const { agent, session } = await open({ gate: allow([]), host, observer });

        const first = await busy(agent, session);

        create(agent, 5);

        const answer = await answerTo(agent, 5);
        const { terminalId } = answer.result as { terminalId: string };

        agent.say({
            method: "session/update",
            params: { sessionId: "sess_1", update: { content: [{ terminalId, type: "terminal" }], kind: "execute", sessionUpdate: "tool_call", status: "in_progress", title: "npm test", toolCallId: "call_1" } },
        });
        await expect.poll(() => events.length).toBe(1);

        session.cancel();
        // The agent answers the cancelled prompt, and the command the cancel killed reports how it ended right after.
        agent.say({ id: first.id, result: { stopReason: "cancelled" } });
        finish({ exitCode: null, signal: "SIGKILL" });

        await expect.poll(() => events.some((event) => event.kind === "turnEnded")).toBe(true);
        await expect.poll(() => events.some((event) => event.kind === "tool" && event.tool?.exit !== undefined)).toBe(true);

        const turnEnd = events.findIndex((event) => event.kind === "turnEnded");
        const exitReport = events.findIndex((event) => event.kind === "tool" && event.tool?.exit !== undefined);

        expect(exitReport).toBeGreaterThan(-1);
        expect(exitReport).toBeLessThan(turnEnd);
        expect(events[exitReport]?.tool).toMatchObject({ id: "call_1", output: "building...\nok" });
    });
});
