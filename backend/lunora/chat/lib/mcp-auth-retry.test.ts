/**
 * 401 handling for OAuth-backed MCP servers: one refresh-and-retry, then a clear
 * "reconnect" error with the grant marked expired — and, mid-run, one renewal
 * shared by every tool of the server.
 */
import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

import { createAuthRetrySession, isUnauthorizedError, renewBearer, retryOnUnauthorized, withBearer } from "./mcp-auth-retry";
import type { MCPServerConfig, MCPServerOAuth } from "./mcp-tools";

const HINT = "Reconnect Notion in Settings → Connectors";

const unauthorized = () => Object.assign(new Error("MCP HTTP Transport Error: POSTing to endpoint (HTTP 401): invalid_token"), { statusCode: 401 });

const hooks = (token: string | null): MCPServerOAuth & { markExpired: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> } => {
    return { markExpired: vi.fn(async () => {}), reconnectHint: HINT, refresh: vi.fn(async () => token) };
};

const server = (oauth?: MCPServerOAuth): MCPServerConfig => {
    return {
        enabled: true,
        headers: [{ key: "authorization", value: "Bearer old" }],
        name: "Notion",
        ...(oauth && { oauth }),
        protocol: "http",
        url: "https://mcp.notion.com/mcp",
    };
};

const tool = (execute: (input: unknown) => Promise<unknown>) => ({ description: "t", execute, inputSchema: {} }) as unknown as ToolSet[string];

const call = async (wrapped: ToolSet[string], input?: unknown) =>
    await (wrapped.execute as (input: unknown, options: unknown) => Promise<unknown>)(input, { messages: [], toolCallId: "c1" });

describe("isUnauthorizedError", () => {
    it.each([
        ["an MCPClientError with statusCode 401", Object.assign(new Error("x"), { statusCode: 401 })],
        ["@ai-sdk/mcp's UnauthorizedError", { message: "Unauthorized", name: "UnauthorizedError" }],
        ["an invalid_token message", new Error('Bearer error="invalid_token"')],
        ["a 401 wrapped as the cause", new Error("tool failed", { cause: Object.assign(new Error("x"), { status: 401 }) })],
    ])("recognises %s", (_label, error) => {
        expect(isUnauthorizedError(error)).toBe(true);
    });

    it.each([
        ["a 500", Object.assign(new Error("boom"), { statusCode: 500 })],
        ["a timeout", new Error("timed out")],
        ["nothing", undefined],
    ])("ignores %s", (_label, error) => {
        expect(isUnauthorizedError(error)).toBe(false);
    });
});

describe("withBearer", () => {
    it("replaces any Authorization header, whatever its case", () => {
        expect(withBearer(server(), "new").headers).toStrictEqual([{ key: "Authorization", value: "Bearer new" }]);
    });
});

describe("retryOnUnauthorized", () => {
    const attemptWith = (outcomes: (() => unknown)[]) => {
        let attempts = 0;

        return vi.fn(async (_config: MCPServerConfig) => {
            const outcome = outcomes[attempts] ?? outcomes.at(-1);

            attempts += 1;

            return outcome?.();
        });
    };

    it("runs once without OAuth, rethrowing a 401 as it is", async () => {
        const attempt = attemptWith([
            () => {
                throw unauthorized();
            },
        ]);

        await expect(retryOnUnauthorized(undefined, server(), attempt, vi.fn())).rejects.toThrow("HTTP 401");
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it("renews once on 401 and retries on the renewed target", async () => {
        const oauth = hooks("new");
        const attempt = attemptWith([
            () => {
                throw unauthorized();
            },
            () => "ok",
        ]);

        await expect(retryOnUnauthorized(oauth, server(oauth), attempt, renewBearer(oauth))).resolves.toBe("ok");
        expect(attempt.mock.calls[1]?.[0].headers).toStrictEqual([{ key: "Authorization", value: "Bearer new" }]);
        expect(oauth.refresh).toHaveBeenCalledTimes(1);
    });

    it("fails with the reconnect hint when nothing can be renewed", async () => {
        const oauth = hooks(null);
        const attempt = attemptWith([
            () => {
                throw unauthorized();
            },
        ]);

        await expect(retryOnUnauthorized(oauth, server(oauth), attempt, renewBearer(oauth))).rejects.toThrow(HINT);
        expect(attempt).toHaveBeenCalledTimes(1);
        expect(oauth.markExpired).not.toHaveBeenCalled();
    });

    it("marks the grant expired when the renewed target is refused too", async () => {
        const oauth = hooks("new");
        const attempt = attemptWith([
            () => {
                throw unauthorized();
            },
        ]);

        await expect(retryOnUnauthorized(oauth, server(oauth), attempt, renewBearer(oauth))).rejects.toThrow(HINT);
        expect(oauth.markExpired).toHaveBeenCalledTimes(1);
    });

    it("rethrows anything that is not a 401, without renewing", async () => {
        const oauth = hooks("new");
        const renew = vi.fn();

        await expect(
            retryOnUnauthorized(
                oauth,
                server(oauth),
                attemptWith([
                    () => {
                        throw new Error("rate limited");
                    },
                ]),
                renew,
            ),
        ).rejects.toThrow("rate limited");
        expect(renew).not.toHaveBeenCalled();
    });
});

describe("createAuthRetrySession", () => {
    const failing = () =>
        tool(async () => {
            throw unauthorized();
        });

    it("leaves a tool without OAuth untouched", () => {
        const original = tool(async () => "ok");

        expect(createAuthRetrySession(server(), { search: original }, vi.fn()).wrap("search", original)).toBe(original);
    });

    it("passes a successful call straight through", async () => {
        const oauth = hooks("new");
        const original = tool(async () => "ok");
        const wrapped = createAuthRetrySession(server(oauth), { search: original }, vi.fn()).wrap("search", original);

        await expect(call(wrapped)).resolves.toBe("ok");
        expect(oauth.refresh).not.toHaveBeenCalled();
    });

    it("on 401 refreshes ONCE, reconnects with the new token and retries the same tool", async () => {
        const oauth = hooks("new");
        const retried = vi.fn(async (input: unknown) => {
            return { input, via: "retry" };
        });
        const reconnect = vi.fn(async (config: MCPServerConfig) => {
            expect(config.headers).toStrictEqual([{ key: "Authorization", value: "Bearer new" }]);

            return { tools: { search: tool(retried) } };
        });
        const original = failing();
        const wrapped = createAuthRetrySession(server(oauth), { search: original }, reconnect).wrap("search", original);

        await expect(call(wrapped, { q: 2 })).resolves.toStrictEqual({ input: { q: 2 }, via: "retry" });
        expect(oauth.refresh).toHaveBeenCalledTimes(1);
        expect(reconnect).toHaveBeenCalledTimes(1);
        expect(oauth.markExpired).not.toHaveBeenCalled();
    });

    it("shares one refresh and one reconnect among every tool of the server", async () => {
        const oauth = hooks("new");
        const reconnect = vi.fn(async () => {
            return { tools: { create: tool(async () => "created"), search: tool(async () => "found") } };
        });
        const search = failing();
        const create = failing();
        const session = createAuthRetrySession(server(oauth), { create, search }, reconnect);
        const wrappedSearch = session.wrap("search", search);
        const wrappedCreate = session.wrap("create", create);

        await expect(Promise.all([call(wrappedSearch), call(wrappedCreate)])).resolves.toStrictEqual(["found", "created"]);
        // A later call starts on the renewed connection and needs nothing more.
        await expect(call(wrappedSearch)).resolves.toBe("found");
        expect(oauth.refresh).toHaveBeenCalledTimes(1);
        expect(reconnect).toHaveBeenCalledTimes(1);
    });

    it("fails with the reconnect hint when no fresh token can be had, and does not ask again", async () => {
        const oauth = hooks(null);
        const reconnect = vi.fn();
        const original = failing();
        const wrapped = createAuthRetrySession(server(oauth), { search: original }, reconnect).wrap("search", original);

        await expect(call(wrapped)).rejects.toThrow(HINT);
        await expect(call(wrapped)).rejects.toThrow(HINT);
        expect(oauth.refresh).toHaveBeenCalledTimes(1);
        expect(reconnect).not.toHaveBeenCalled();
    });

    it("marks the grant expired when the refreshed token is refused too", async () => {
        const oauth = hooks("new");
        const original = failing();
        const wrapped = createAuthRetrySession(server(oauth), { search: original }, async () => {
            return { tools: { search: failing() } };
        }).wrap("search", original);

        await expect(call(wrapped)).rejects.toThrow(HINT);
        expect(oauth.markExpired).toHaveBeenCalledTimes(1);
    });

    it("rethrows anything that is not a 401, without refreshing", async () => {
        const oauth = hooks("new");
        const original = tool(async () => {
            throw new Error("rate limited");
        });
        const wrapped = createAuthRetrySession(server(oauth), { search: original }, vi.fn()).wrap("search", original);

        await expect(call(wrapped)).rejects.toThrow("rate limited");
        expect(oauth.refresh).not.toHaveBeenCalled();
    });
});
