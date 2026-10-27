/**
 * JSON-RPC 2.0 over newline-delimited JSON, the transport ACP uses on an agent's stdin and stdout.
 * Small on purpose: the host decides every outgoing frame, so nothing here adds one of its own.
 */
import type { Readable, Writable } from "node:stream";

import { INTERNAL_ERROR, RpcError } from "./rpc-error";

/** An incoming line longer than this ends the connection (the agent is not speaking the protocol). */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

export interface RpcHandlers {
    /** An agent → host notification. */
    notification: (method: string, params: unknown) => void;
    /** An agent → host request. Throw an `RpcError` to answer with an error. */
    request: (method: string, params: unknown) => Promise<unknown>;
}

interface Pending {
    reject: (error: Error) => void;
    resolve: (value: unknown) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class JsonRpcConnection {
    private readonly pending = new Map<number, Pending>();

    private nextId = 1;

    private partial = "";

    private closed: Error | undefined;

    public constructor(
        input: Readable,
        private readonly output: Writable,
        private readonly handlers: RpcHandlers,
    ) {
        input.setEncoding("utf8");
        input.on("data", (chunk: string) => this.onData(chunk));
        input.on("end", () => this.close(new Error("the agent closed its output")));
        input.on("error", (error) => this.close(error));
        // A write to a dead child's stdin is an EPIPE: the exit is reported through `close`, not thrown here.
        output.on("error", (error) => this.close(error));
    }

    public request<Result = unknown>(method: string, params: unknown): Promise<Result> {
        if (this.closed !== undefined) {
            return Promise.reject(this.closed);
        }

        const id = this.nextId;

        this.nextId += 1;

        return new Promise<Result>((resolve, reject) => {
            this.pending.set(id, { reject, resolve: (value) => resolve(value as Result) });
            this.write({ id, jsonrpc: "2.0", method, params });
        });
    }

    public notify(method: string, params: unknown): void {
        if (this.closed === undefined) {
            this.write({ jsonrpc: "2.0", method, params });
        }
    }

    /** Rejects every request still waiting. Idempotent; the first reason wins. */
    public close(reason: Error): void {
        if (this.closed !== undefined) {
            return;
        }

        this.closed = reason;

        for (const waiter of this.pending.values()) {
            waiter.reject(reason);
        }

        this.pending.clear();
    }

    private onData(chunk: string): void {
        this.partial += chunk;

        if (this.partial.length > MAX_LINE_BYTES) {
            this.close(new Error("the agent sent a message that is too large"));

            return;
        }

        let newline = this.partial.indexOf("\n");

        while (newline !== -1) {
            const line = this.partial.slice(0, newline).trim();

            this.partial = this.partial.slice(newline + 1);

            if (line !== "") {
                this.onLine(line);
            }

            newline = this.partial.indexOf("\n");
        }
    }

    private onLine(line: string): void {
        let message: unknown;

        try {
            message = JSON.parse(line);
        } catch {
            // Some agents print log lines on stdout. They are not frames, and their content is not ours to log.
            return;
        }

        if (!isRecord(message) || message.jsonrpc !== "2.0") {
            return;
        }

        const { id, method } = message;

        if (typeof method !== "string") {
            this.onResponse(id, message);
        } else if (typeof id === "number" || typeof id === "string") {
            this.answer(id, method, message.params);
        } else {
            this.handlers.notification(method, message.params);
        }
    }

    private onResponse(id: unknown, message: Record<string, unknown>): void {
        const waiter = typeof id === "number" ? this.pending.get(id) : undefined;

        if (waiter === undefined || typeof id !== "number") {
            return;
        }

        this.pending.delete(id);

        if (isRecord(message.error)) {
            const { code, message: text } = message.error;

            waiter.reject(new RpcError(typeof code === "number" ? code : INTERNAL_ERROR, typeof text === "string" ? text : "the agent reported an error"));
        } else {
            waiter.resolve(message.result);
        }
    }

    private async answer(id: number | string, method: string, params: unknown): Promise<void> {
        try {
            const result = await this.handlers.request(method, params);

            this.respond({ id, jsonrpc: "2.0", result: result ?? null });
        } catch (error) {
            const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
            const text = error instanceof RpcError ? error.message : "the host could not handle the request";

            this.respond({ error: { code, message: text }, id, jsonrpc: "2.0" });
        }
    }

    private respond(message: Record<string, unknown>): void {
        if (this.closed === undefined) {
            this.write(message);
        }
    }

    private write(message: Record<string, unknown>): void {
        this.output.write(`${JSON.stringify(message)}\n`);
    }
}
