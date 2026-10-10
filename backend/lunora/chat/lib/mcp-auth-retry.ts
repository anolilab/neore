/**
 * One refresh-and-retry for OAuth-backed MCP servers that answer 401.
 *
 * A token can die between tool discovery and a call: revoked at the provider,
 * or expired early. Rather than surface a transport error, the operation
 * refreshes the grant ONCE, reconnects with the new token and retries. If there
 * is no token to be had, or the fresh one is refused too, the grant is marked
 * expired and the operation fails with the grant's `reconnectHint` — a message
 * the model can relay ("Reconnect Notion in Settings → Connectors") instead of a
 * stack trace.
 *
 * {@link retryOnUnauthorized} is that policy, once. Connecting (`mcp-tools.ts`),
 * the MCP Apps proxy (`mcp-apps.ts`) and tool calls mid-run
 * ({@link createAuthRetrySession}) all go through it.
 */
import type { ToolSet } from "ai";

import type { MCPServerConfig, MCPServerOAuth } from "./mcp-tools";

type Tool = ToolSet[string];

const UNAUTHORIZED_TEXT = /\b401\b|invalid_token|unauthori[sz]ed/iu;
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether `error` means "the server refused our token": an HTTP 401
 * (`MCPClientError.statusCode`, a `status` field), `@ai-sdk/mcp`'s
 * `UnauthorizedError`, or an `invalid_token` / 401 in the message — looked for
 * down the `cause` chain, since transports wrap what they catch.
 */
export const isUnauthorizedError = (error: unknown): boolean => {
    let current: unknown = error;

    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
        if (typeof current !== "object") {
            return typeof current === "string" && UNAUTHORIZED_TEXT.test(current);
        }

        const candidate = current as { cause?: unknown; message?: unknown; name?: unknown; status?: unknown; statusCode?: unknown };

        if (candidate.statusCode === 401 || candidate.status === 401 || candidate.name === "UnauthorizedError") {
            return true;
        }

        if (typeof candidate.message === "string" && UNAUTHORIZED_TEXT.test(candidate.message)) {
            return true;
        }

        current = candidate.cause;
    }

    return false;
};

/** `config` with its `Authorization` header replaced by `Bearer <token>`. */
export const withBearer = (config: MCPServerConfig, token: string): MCPServerConfig => {
    return {
        ...config,
        headers: [
            ...(config.headers ?? []).filter((header) => header.key.toLowerCase() !== "authorization"),
            { key: "Authorization", value: `Bearer ${token}` },
        ],
    };
};

/**
 * Run `attempt` on `target`. When it fails with a 401 and the server's token
 * came from an OAuth grant, `renew` produces a target with fresh credentials
 * (or `null`: the grant cannot be revived) and `attempt` runs ONCE more. A
 * second 401 marks the grant expired. Either dead end throws the grant's
 * `reconnectHint`; any other error passes through untouched.
 */
export const retryOnUnauthorized = async <Target, Result>(
    oauth: MCPServerOAuth | undefined,
    target: Target,
    attempt: (target: Target) => Promise<Result>,
    renew: (failed: Target) => Promise<Target | null>,
): Promise<Result> => {
    try {
        return await attempt(target);
    } catch (error) {
        if (!oauth || !isUnauthorizedError(error)) {
            throw error;
        }

        const renewed = await renew(target);

        if (renewed === null) {
            throw new Error(oauth.reconnectHint, { cause: error });
        }

        try {
            return await attempt(renewed);
        } catch (retryError) {
            if (isUnauthorizedError(retryError)) {
                await oauth.markExpired();

                throw new Error(oauth.reconnectHint, { cause: retryError });
            }

            throw retryError;
        }
    }
};

/** The `renew` for an attempt that takes a config: the same server with a freshly refreshed bearer token. */
export const renewBearer =
    (oauth: MCPServerOAuth) =>
    async (config: MCPServerConfig): Promise<MCPServerConfig | null> => {
        const token = await oauth.refresh();

        return token ? withBearer(config, token) : null;
    };

type Execute = NonNullable<Tool["execute"]>;

/**
 * One server's live tool set for a run, shared by all of its tools.
 *
 * A 401 on any tool refreshes the grant and reconnects ONCE for the whole
 * server: calls that failed on the same connection wait for that one renewal,
 * and a call that failed on a connection someone else already replaced simply
 * retries on the replacement. Without this, every tool of a server whose token
 * lapsed would refresh (burning rotating refresh tokens) and open its own client.
 *
 * `reconnect` connects with the given config; the caller owns closing what it
 * opens.
 */
export const createAuthRetrySession = (
    config: MCPServerConfig,
    tools: ToolSet,
    reconnect: (config: MCPServerConfig) => Promise<{ tools: ToolSet }>,
): { wrap: (toolName: string, tool: Tool) => Tool } => {
    const { oauth } = config;
    let current = tools;
    let renewal: { from: ToolSet; result: Promise<ToolSet | null> } | undefined;

    const renew = async (failed: ToolSet): Promise<ToolSet | null> => {
        if (failed !== current) {
            return current;
        }

        if (renewal?.from !== failed && oauth) {
            const result = (async () => {
                const token = await oauth.refresh();

                if (!token) {
                    return null;
                }

                const reconnected = await reconnect(withBearer(config, token));

                current = reconnected.tools;

                return current;
            })();

            renewal = { from: failed, result };
            // A failed reconnect is not final: the next 401 may try again.
            result.catch(() => {
                if (renewal?.result === result) {
                    renewal = undefined;
                }
            });
        }

        return (await renewal?.result) ?? null;
    };

    return {
        wrap: (toolName, tool) => {
            if (!oauth || !tool.execute) {
                return tool;
            }

            const execute: Execute = async (input, options) =>
                await retryOnUnauthorized(
                    oauth,
                    current,
                    async (set) => {
                        const run = set[toolName]?.execute;

                        if (!run) {
                            throw new Error(oauth.reconnectHint);
                        }

                        return await run(input, options);
                    },
                    renew,
                );

            return { ...tool, execute } as Tool;
        },
    };
};
