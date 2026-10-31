// A scripted ACP agent for the host's tests (not linted: a test double, read next to the tests). It checks
// every frame the host sends against the SDK's published JSON schema and against the protocol's ordering rules, and writes what it saw (and any violation) to
// $FAKE_AGENT_LOG as JSON lines. What it does is chosen by the first word of each prompt (see `behaviours`).
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";

import { z } from "zod";

const require = createRequire(import.meta.url);
const schema = require("@agentclientprotocol/sdk/schema/v1/schema.json");
const check = (name) => z.fromJSONSchema({ $ref: `#/$defs/${name}`, $defs: schema.$defs });
const REQUEST_SCHEMAS = {
    initialize: check("InitializeRequest"),
    "session/new": check("NewSessionRequest"),
    "session/prompt": check("PromptRequest"),
    "session/list": check("ListSessionsRequest"),
    "session/load": check("LoadSessionRequest"),
};

// FAKE_AGENT_SESSIONS = "list", "load" or "list,load": which saved-session methods the agent advertises (and answers).
const advertised = new Set((process.env.FAKE_AGENT_SESSIONS ?? "").split(",").filter(Boolean));
// The sessions the agent keeps. One is for a folder nobody approved, which a host must not offer.
const SAVED = [
    { sessionId: "s-old", title: "Old chat", updatedAt: "2026-01-01T00:00:00Z" },
    { sessionId: "s-new", title: "New chat", updatedAt: "2026-02-01T00:00:00Z" },
];
const HISTORY = {
    "s-new": [
        ["user_message_chunk", "fix the "],
        ["user_message_chunk", "bug"],
        ["agent_thought_chunk", "hm"],
        ["agent_message_chunk", "Done"],
        ["agent_message_chunk", "."],
        ["user_message_chunk", "and the tests"],
        ["agent_message_chunk", "Tests too."],
    ],
    "s-old": [["user_message_chunk", "older question"]],
};
const CANCEL_SCHEMA = check("CancelNotification");
const PERMISSION_RESPONSE_SCHEMA = check("RequestPermissionResponse");

const logFile = process.env.FAKE_AGENT_LOG;
const record = (entry) => logFile && appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
const violation = (message, frame) => {
    record({ violation: message, frame });
    process.stderr.write(`violation: ${message}\n`);
};

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const reply = (id, stopReason) => {
    // The turn is over the moment the response is written, whatever the agent still sends after it.
    state.promptRunning = false;
    send({ id, result: { stopReason } });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.env.FAKE_AGENT_FAIL_INIT === "1") {
    process.stderr.write(`failing at start, env=${JSON.stringify(process.env)}\n`);
    process.exit(2);
}

const state = { sessionId: undefined, promptRunning: false, cancelled: false, nextRequest: 1000, waiting: new Map(), seenIds: new Set() };

const ask = (params) =>
    new Promise((resolve) => {
        const id = state.nextRequest++;

        state.waiting.set(id, resolve);
        send({ id, method: "session/request_permission", params });
    });

const options = () => [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    ...(process.env.FAKE_AGENT_NO_REJECT === "1" ? [] : [{ optionId: "reject", name: "Reject", kind: "reject_once" }]),
];

const permissionRequest = (sessionId, index) => ({
    sessionId,
    toolCall: { toolCallId: `perm-${index}`, title: `Run command ${index}`, kind: "execute", status: "pending", rawInput: { command: `echo ${index}` }, locations: [{ path: "/work/file.txt" }] },
    options: options(),
});

const behaviours = {
    async hello(id, sessionId) {
        chunk(sessionId, "Hello");
        chunk(sessionId, " world");
        reply(id, "end_turn");
    },
    async echo(id, sessionId, rest) {
        chunk(sessionId, rest);
        reply(id, "end_turn");
    },
    async tool(id, sessionId) {
        update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Reading a file", kind: "read", status: "in_progress" });
        await waitForCancel();
        if (process.env.FAKE_AGENT_LATE_TOOL === "1") {
            update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
        }
        reply(id, "cancelled");
    },
    async hang() {
        // Never answers, and ignores a cancel.
        await sleep(600_000);
    },
    async slow(id, sessionId) {
        chunk(sessionId, "working");
        await sleep(Number(process.env.FAKE_AGENT_SLOW_MS ?? 150));
        reply(id, "end_turn");
    },
    async perm(id, sessionId, rest) {
        const index = rest || "1";

        update(sessionId, { sessionUpdate: "tool_call", toolCallId: `perm-${index}`, title: `Run command ${index}`, kind: "execute", status: "pending" });
        const response = await ask(permissionRequest(sessionId, index));
        const outcome = response?.result?.outcome;

        if (outcome?.outcome === "selected" && outcome.optionId === "allow") {
            update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: `perm-${index}`, status: "completed" });
            chunk(sessionId, `ran ${index}`);
        } else {
            update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: `perm-${index}`, status: "failed" });
            chunk(sessionId, `declined ${index}: ${outcome?.outcome === "selected" ? outcome.optionId : outcome?.outcome}`);
        }
        reply(id, outcome?.outcome === "cancelled" ? "cancelled" : "end_turn");
    },
    async permmany(id, sessionId, rest) {
        const count = Number(rest || "3");
        const answers = await Promise.all(Array.from({ length: count }, (_, i) => ask(permissionRequest(sessionId, String(i + 1)))));

        chunk(sessionId, answers.map((answer) => answer?.result?.outcome?.optionId ?? answer?.result?.outcome?.outcome).join(","));
        reply(id, "end_turn");
    },
    async early(id, sessionId) {
        // Everything looks finished well before the response arrives.
        update(sessionId, { sessionUpdate: "tool_call", toolCallId: "e1", title: "Quick job", kind: "other", status: "completed" });
        chunk(sessionId, "all done");
        await sleep(120);
        reply(id, "end_turn");
    },
    async late(id, sessionId) {
        update(sessionId, { sessionUpdate: "tool_call", toolCallId: "l1", title: "Slow job", kind: "other", status: "in_progress" });
        reply(id, "end_turn");
        await sleep(30);
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "l1", status: "completed" });
        chunk(sessionId, " (late)");
    },
    async child(id, sessionId) {
        const grandchild = spawn("sleep", ["300"], { stdio: "ignore" });

        chunk(sessionId, `pid:${grandchild.pid} agent:${process.pid}`);
        update(sessionId, { sessionUpdate: "tool_call", toolCallId: "c1", title: "Sleeping", kind: "execute", status: "in_progress" });
        await waitForCancel();
        reply(id, "cancelled");
    },
    async pid(id, sessionId) {
        chunk(sessionId, `agent:${process.pid}`);
        reply(id, "end_turn");
    },
    async fail(id, sessionId) {
        // Answers the prompt with an error and keeps running, as an agent that mishandles its own failure does.
        chunk(sessionId, `agent:${process.pid}`);
        state.promptRunning = false;
        send({ id, error: { code: -32603, message: "the prompt failed" } });
    },
    async env(id, sessionId) {
        chunk(sessionId, JSON.stringify(process.env));
        reply(id, "end_turn");
    },
    async die() {
        process.stderr.write(`dying, env=${JSON.stringify(process.env)}\n`);
        process.exit(3);
    },
};

let cancelWaiter;
const waitForCancel = () => (state.cancelled ? Promise.resolve() : new Promise((resolve) => (cancelWaiter = resolve)));

const handle = async (message) => {
    if (message.jsonrpc !== "2.0") {
        return violation("jsonrpc is not 2.0", message);
    }

    if (message.method === undefined) {
        // A response to something we asked.
        const waiter = state.waiting.get(message.id);

        if (waiter === undefined) {
            return violation("response to an unknown request", message);
        }
        if (message.result !== undefined && !PERMISSION_RESPONSE_SCHEMA.safeParse(message.result).success) {
            violation("permission response does not match the schema", message);
        }
        state.waiting.delete(message.id);
        return waiter(message);
    }

    const isRequest = message.id !== undefined;

    if (isRequest) {
        if (message.id === null || state.seenIds.has(message.id)) {
            return violation("request id is null or reused", message);
        }
        state.seenIds.add(message.id);
    }

    if (message.method === "session/cancel") {
        if (!CANCEL_SCHEMA.safeParse(message.params).success) {
            violation("session/cancel does not match the schema", message);
        }
        if (isRequest) {
            violation("session/cancel must be a notification", message);
        }
        state.cancelled = true;
        record({ cancel: message.params });
        if (process.env.FAKE_AGENT_IGNORE_CANCEL !== "1") {
            cancelWaiter?.();
        }
        return undefined;
    }

    const requestSchema = REQUEST_SCHEMAS[message.method];

    if (requestSchema === undefined || !isRequest) {
        return violation(`unexpected frame ${message.method}`, message);
    }
    if (!requestSchema.safeParse(message.params).success) {
        violation(`${message.method} does not match the schema`, message);
    }

    if (message.method === "initialize") {
        return send({
            id: message.id,
            result: {
                protocolVersion: Number(process.env.FAKE_AGENT_VERSION ?? 1),
                agentCapabilities: {
                    loadSession: advertised.has("load"),
                    promptCapabilities: { image: false, audio: false, embeddedContext: false },
                    ...advertised.has("list") && { sessionCapabilities: { list: {} } },
                },
                agentInfo: { name: "fake-agent", title: "Fake Agent", version: "1.2.3" },
                authMethods: [],
            },
        });
    }

    if (message.method === "session/new") {
        record({ sessionNew: message.params });
        if (process.env.FAKE_AGENT_AUTH === "1") {
            return send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
        }
        if (process.env.FAKE_AGENT_SESSION_ERROR === "1") {
            // An agent's own error text can quote its environment.
            return send({ id: message.id, error: { code: -32603, message: `cannot start: ${process.env.API_KEY}` } });
        }
        state.sessionId = "fake-session-1";
        return send({ id: message.id, result: { sessionId: state.sessionId } });
    }

    if (message.method === "session/list" || message.method === "session/load") {
        const name = message.method === "session/list" ? "list" : "load";

        if (!advertised.has(name)) {
            return violation(`${message.method} without advertising it`, message);
        }
        if (!REQUEST_SCHEMAS[message.method].safeParse(message.params).success) {
            violation(`${message.method} does not match the schema`, message);
        }
        record({ [name]: message.params });

        if (name === "list") {
            const second = message.params.cursor === "p2";
            const mine = process.env.FAKE_AGENT_PAGES === "1" ? [SAVED[second ? 1 : 0]] : SAVED;
            const sessions = mine.map((entry) => ({ ...entry, cwd: message.params.cwd }));

            if (process.env.FAKE_AGENT_ELSEWHERE === "1") {
                sessions.push({ sessionId: "s-elsewhere", title: "Other folder", cwd: "/elsewhere" });
            }

            return send({ id: message.id, result: { sessions, ...process.env.FAKE_AGENT_PAGES === "1" && !second && { nextCursor: "p2" } } });
        }

        const history = HISTORY[message.params.sessionId];

        if (history === undefined) {
            return send({ id: message.id, error: { code: -32002, message: "Resource not found" } });
        }

        state.sessionId = message.params.sessionId;
        for (const [kind, text] of history) {
            update(state.sessionId, { sessionUpdate: kind, content: { type: "text", text } });
        }
        update(state.sessionId, { sessionUpdate: "tool_call", toolCallId: "h1", title: "Read", kind: "read", status: "completed" });

        return send({ id: message.id, result: {} });
    }

    // session/prompt
    if (state.sessionId === undefined) {
        return violation("prompt before session/new", message);
    }
    if (message.params.sessionId !== state.sessionId) {
        violation("prompt for an unknown session", message);
    }
    if (state.promptRunning) {
        violation("a second prompt while one is running", message);
    }

    state.promptRunning = true;
    state.cancelled = false;
    const text = message.params.prompt?.[0]?.text ?? "";
    const [word, ...rest] = text.split(" ");
    const behaviour = behaviours[word] ?? behaviours.hello;

    record({ prompt: text });
    await behaviour(message.id, state.sessionId, rest.join(" "));
    return undefined;
};

createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim() === "") {
        return;
    }
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return violation("a frame that is not JSON", line);
    }
    record({ received: message });
    handle(message).catch((error) => violation(`fake agent failed: ${error.message}`, message));
});
process.stdin.on("end", () => process.exit(0));
