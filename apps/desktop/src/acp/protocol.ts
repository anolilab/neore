/**
 * The protocol this host speaks, and why.
 *
 * - **ACP version 1** (`protocolVersion: 1`), the stable line of `@agentclientprotocol/sdk` 2.0.x. The SDK's
 * `v2` entrypoints are marked experimental and are not used. `protocol.test.ts` pins this number and every
 * frame the host sends against the SDK's own schemas.
 * - **No SDK at runtime.** The SDK is a devDependency: its types and zod schemas check our frames in tests. The
 * host sends a handful of frames and must control each one (a consent gate before spawn, a permission answer
 * that only Rust may fill in), so a ~150-line JSON-RPC client (`jsonrpc.ts`) is smaller than the SDK's
 * connection layer, and keeps zod and 8 MB of package out of the main-process bundle.
 * - **No client-side file system or terminal.** The host advertises `fs.readTextFile`, `fs.writeTextFile` and
 * `terminal` as false (plan §10 Q5), so an agent runs its own tools beside the device sandbox under its own
 * permission prompts. Any `fs/*` or `terminal/*` request is answered "method not found".
 * - **No `authenticate`.** Neore stores no credential for an agent. An agent that needs a login is told so in
 * plain words; the user signs in with the agent's own tool.
 */
import type { InitializeRequest, InitializeResponse, ListSessionsRequest, LoadSessionRequest, NewSessionRequest, PromptRequest } from "@agentclientprotocol/sdk";

import type { JsonRpcConnection } from "./jsonrpc";
import { RpcError } from "./rpc-error";
import type { AgentCapabilities } from "./types";

export const PROTOCOL_VERSION = 1;

export const METHOD = {
    cancel: "session/cancel",
    initialize: "initialize",
    listSessions: "session/list",
    loadSession: "session/load",
    newSession: "session/new",
    prompt: "session/prompt",
    requestPermission: "session/request_permission",
    sessionUpdate: "session/update",
} as const;

/** `AUTH_REQUIRED` in the ACP error codes. */
const AUTH_REQUIRED = -32_000;

const STARTUP_TIMEOUT_MS = 20_000;
const LOAD_TIMEOUT_MS = 120_000;

class AgentVersionError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const withTimeout = async <Value>(promise: Promise<Value>, ms: number, message: string): Promise<Value> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const displayName = (info: { name?: unknown; title?: unknown }): string => {
    if (typeof info.title === "string") {
        return info.title;
    }

    return typeof info.name === "string" ? info.name : "";
};

export interface Handshake {
    agentName: string;
    agentVersion: string;
    capabilities: AgentCapabilities;
    protocolVersion: number;
}

export const initialize = async (connection: JsonRpcConnection, appVersion: string, timeoutMs = STARTUP_TIMEOUT_MS): Promise<Handshake> => {
    const params: InitializeRequest = {
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "neore-desktop", title: "Neore", version: appVersion },
        protocolVersion: PROTOCOL_VERSION,
    };
    const response = (await withTimeout(connection.request(METHOD.initialize, params), timeoutMs, "the agent did not answer the handshake")) as Partial<InitializeResponse> | null;
    const version = response?.protocolVersion;

    if (typeof version !== "number") {
        throw new AgentVersionError("the agent did not report a protocol version");
    }

    // The agent answers with the version it will speak. Anything but ours means disconnecting (ACP, initialization).
    if (version < PROTOCOL_VERSION) {
        throw new AgentVersionError(`this agent is too old: it speaks ACP version ${String(version)}, Neore needs version ${String(PROTOCOL_VERSION)}`);
    }

    if (version > PROTOCOL_VERSION) {
        throw new AgentVersionError(`this agent is too new: it speaks ACP version ${String(version)}, Neore supports version ${String(PROTOCOL_VERSION)}`);
    }

    const info: { name?: unknown; title?: unknown; version?: unknown } = isRecord(response?.agentInfo) ? response.agentInfo : {};

    return {
        agentName: displayName(info),
        agentVersion: typeof info.version === "string" ? info.version : "",
        capabilities: isRecord(response?.agentCapabilities) ? response.agentCapabilities : {},
        protocolVersion: version,
    };
};

/** Opens a session in `cwd` and returns the agent's session id. */
export const newSession = async (connection: JsonRpcConnection, cwd: string, timeoutMs = STARTUP_TIMEOUT_MS): Promise<string> => {
    const params: NewSessionRequest = { cwd, mcpServers: [] };

    try {
        const response = await withTimeout(connection.request(METHOD.newSession, params), timeoutMs, "the agent did not open a session");

        if (!isRecord(response) || typeof response.sessionId !== "string" || response.sessionId === "") {
            throw new Error("the agent did not return a session id");
        }

        return response.sessionId;
    } catch (error) {
        if (error instanceof RpcError && error.code === AUTH_REQUIRED) {
            // eslint-disable-next-line preserve-caught-error -- the cause is the agent's own error, which can quote its environment
            throw new Error("the agent needs you to sign in first. Sign in with the agent's own tool, then start the session again");
        }

        throw error;
    }
};

export const promptParams = (sessionId: string, text: string): PromptRequest => {
    return { prompt: [{ text, type: "text" }], sessionId };
};

/** A session the agent keeps, as `session/list` describes it. */
export interface NativeSession {
    cwd: string;
    sessionId: string;
    title: string;
    /** ISO 8601, when the agent said. */
    updatedAt: string;
}

const MAX_LIST_PAGES = 10;
const MAX_LISTED_SESSIONS = 200;
const LIST_TIMEOUT_MS = 30_000;

const textOf = (value: unknown): string => typeof value === "string" ? value : "";

/**
 * `session/list` for one folder, newest first. The agent may ignore the `cwd` filter, and the user approved this folder
 * only, so an entry for any other working directory is dropped here. Bounded: at most {@link MAX_LIST_PAGES} pages, and
 * {@link MAX_LISTED_SESSIONS} sessions. Call only when the agent advertised `sessionCapabilities.list`.
 */
export const listSessions = async (connection: JsonRpcConnection, cwd: string, timeoutMs = LIST_TIMEOUT_MS): Promise<NativeSession[]> => {
    const found: NativeSession[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES && found.length < MAX_LISTED_SESSIONS; page += 1) {
        const params: ListSessionsRequest = { cursor: cursor ?? null, cwd };
        // eslint-disable-next-line no-await-in-loop -- each page names the next
        const response = await withTimeout(connection.request(METHOD.listSessions, params), timeoutMs, "the agent did not list its sessions");

        if (!isRecord(response) || !Array.isArray(response.sessions)) {
            throw new Error("the agent did not return a list of sessions");
        }

        for (const entry of response.sessions as unknown[]) {
            if (isRecord(entry) && typeof entry.sessionId === "string" && entry.sessionId !== "" && textOf(entry.cwd) === cwd) {
                found.push({ cwd, sessionId: entry.sessionId, title: textOf(entry.title), updatedAt: textOf(entry.updatedAt) });
            }
        }

        cursor = typeof response.nextCursor === "string" && response.nextCursor !== "" ? response.nextCursor : undefined;

        if (cursor === undefined) {
            break;
        }
    }

    const time = (session: NativeSession): number => Date.parse(session.updatedAt) || 0;

    // `sort` on the list this call built: the desktop's tsconfig `lib` predates `toSorted`.
    // eslint-disable-next-line unicorn/no-array-sort
    return found.sort((a, b) => time(b) - time(a)).slice(0, MAX_LISTED_SESSIONS);
};

/**
 * `session/load`: the agent replays the session's history as `session/update` notifications, then answers. The caller
 * collects the notifications. Call only when the agent advertised `loadSession`. A replay is as long as the session, so
 * the deadline is generous.
 */
export const loadSession = async (connection: JsonRpcConnection, sessionId: string, cwd: string, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> => {
    const params: LoadSessionRequest = { cwd, mcpServers: [], sessionId };

    try {
        await withTimeout(connection.request(METHOD.loadSession, params), timeoutMs, "the agent did not finish loading the session");
    } catch (error) {
        if (error instanceof RpcError && error.code === AUTH_REQUIRED) {
            // eslint-disable-next-line preserve-caught-error -- the cause is the agent's own error, which can quote its environment
            throw new Error("the agent needs you to sign in first. Sign in with the agent's own tool, then import again");
        }

        throw error;
    }
};
