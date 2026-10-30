/**
 * Progress tokens for an `@ai-sdk/mcp` client.
 *
 * The client sends no `progressToken` and treats every notification as an
 * error ("Unsupported message type"), and it does not export its transports —
 * so this hooks the one `transport` it holds (a custom transport passed to
 * `createMCPClient` ends up in the same field): `send` gets the token of the
 * tool call that is running (`currentProgressCall`) on a `tools/call` request,
 * and `onmessage` takes `notifications/progress` for those tokens before the
 * client sees it. A client shaped differently is left alone: no token goes out
 * and the server simply reports no progress.
 */
import type { MCPClient } from "@ai-sdk/mcp";

import { currentProgressCall, readProgressParams } from "./mcp-progress";
import type { ProgressCall } from "./mcp-progress";

interface Message {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
}

interface HookableTransport {
    onmessage?: (message: Message) => void;
    send: (message: Message, options?: unknown) => Promise<void>;
}

const transportOf = (client: MCPClient): HookableTransport | undefined => {
    const { transport } = client as unknown as { transport?: Partial<HookableTransport> };

    return typeof transport?.send === "function" ? (transport as HookableTransport) : undefined;
};

/** Makes `client`'s tool calls report progress to the call they run under. Call it once per client. */
export const attachProgressTokens = (client: MCPClient): void => {
    const transport = transportOf(client);

    if (!transport) {
        return;
    }

    const calls = new Map<string, ProgressCall>();
    const tokenOfRequest = new Map<number | string, string>();
    const { send } = transport;

    transport.send = async (message, options) => {
        const { id } = message;
        const call = message.method === "tools/call" && id !== undefined ? currentProgressCall() : undefined;

        if (!call || id === undefined) {
            return await send.call(transport, message, options);
        }

        calls.set(call.token, call);
        tokenOfRequest.set(id, call.token);

        const params = { ...message.params, _meta: { ...(message.params?._meta as object), progressToken: call.token } };

        return await send.call(transport, { ...message, params }, options);
    };

    // The client set `onmessage` in its constructor; a transport reads it at call time, so replacing it takes effect.
    const original = transport.onmessage;

    const route = (message: Message): void => {
        if (message.method === "notifications/progress") {
            const token = message.params?.progressToken;
            const progress = typeof token === "string" ? readProgressParams(message.params) : undefined;

            if (progress) {
                calls.get(token as string)?.onProgress(progress);
            }

            return;
        }

        if (message.method === undefined && message.id !== undefined) {
            const token = tokenOfRequest.get(message.id);

            if (token !== undefined) {
                tokenOfRequest.delete(message.id);
                calls.delete(token);
            }
        }

        original?.(message);
    };

    transport.onmessage = route;
};
