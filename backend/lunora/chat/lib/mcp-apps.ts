import type { JSONValue } from "@ai-sdk/provider";
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../../_generated/internal";
import { getCurrentUserInternal } from "../../auth/lib/helper";
import { findUserMcpServer } from "../../connectors/lib/user-mcp-servers";
import { checkRateLimit } from "../../lib/rate-limiter";
import { isSafeUrl } from "../tools/utilities";
import { renewBearer, retryOnUnauthorized } from "./mcp-auth-retry";
import type { MCPServerConfig } from "./mcp-tools";
import { headersToRecord } from "./mcp-tools";
import type { ToolAnnotationHints, ToolDescriptor, ToolPermissionMode, ToolPermissionOverrides } from "./tool-permissions";
import { isToolPermissionMode, resolveToolPermission, toolPermissionKey } from "./tool-permissions";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * The CALLER's server by name: their own saved servers (with the token of a
 * sign-in) and their connected connectors. The grant's token is attached here,
 * server-side, and never leaves this worker — the iframe only ever names a
 * server.
 */
const findServerConfig = async (context: HttpActionCtx, userId: string, serverName: string): Promise<MCPServerConfig | null> =>
    await findUserMcpServer(context, userId, serverName);

type SDKClient = Awaited<ReturnType<typeof createSDKClient>>;

/**
 * Run `operation` on a connected client; an OAuth-backed server answering 401
 * gets ONE refreshed token (`retryOnUnauthorized`). Without one, the error
 * names the way out.
 */
const withServerClient = async <T>(config: MCPServerConfig, operation: (client: SDKClient) => Promise<T>): Promise<T> => {
    const run = async (target: MCPServerConfig): Promise<T> => {
        const client = await createSDKClient(target);

        try {
            return await operation(client);
        } finally {
            await client.close().catch(() => {});
        }
    };

    return config.oauth ? await retryOnUnauthorized(config.oauth, config, run, renewBearer(config.oauth)) : await run(config);
};

/** Pages of `tools/list` read while looking for one tool's annotations. */
const MAX_TOOL_LIST_PAGES = 10;

/** The annotations the server declares for `toolName`, or undefined when it does not list the tool. */
const readToolAnnotations = async (client: SDKClient, toolName: string): Promise<ToolAnnotationHints | undefined> => {
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
        const listed = await withOperationTimeout(client.listTools(cursor ? { cursor } : undefined), OPERATION_TIMEOUT_MS, "MCP listTools");
        const tool = listed.tools.find((candidate) => candidate.name === toolName);

        if (tool) {
            return tool.annotations ?? {};
        }

        cursor = listed.nextCursor;

        if (!cursor) {
            return undefined;
        }
    }

    return undefined;
};

/**
 * An MCP App iframe's call runs under the same mode the model would get
 * (`resolveToolPermission`), so the proxy is no way around it. The user's
 * override decides when there is one — before anything connects. Otherwise the
 * server's annotations do, which needs a `tools/list` on the call's own
 * connection; a tool the server does not list resolves as unannotated, `ask`.
 */
const descriptorFor = (config: MCPServerConfig, toolName: string): ToolDescriptor =>
    config.connectorSlug
        ? { key: toolPermissionKey("connector", toolName, config.connectorSlug), source: "connector" }
        : { key: toolPermissionKey("mcp", toolName, config.name), source: "mcp" };

const annotatedToolMode = async (client: SDKClient, descriptor: ToolDescriptor, toolName: string): Promise<ToolPermissionMode> => {
    const annotations = await readToolAnnotations(client, toolName);

    return resolveToolPermission({ ...descriptor, ...(annotations && { annotations }) }, undefined);
};

/**
 * Why a proxied call was refused, or null to let it run. `ask` is refused too:
 * approval is a pause in the model's run (`needsApproval`), and an iframe's call
 * has no run to pause and no one to ask — running it would be auto-approval.
 */
const refusalFor = (mode: ToolPermissionMode, toolName: string): string | null => {
    if (mode === "off") {
        return `Tool "${toolName}" is turned off in your tool permissions`;
    }

    if (mode === "ask") {
        return `Tool "${toolName}" needs your approval before each call, which an MCP App cannot ask for. Ask for it in the chat, or set it to "Allow" in your tool permissions`;
    }

    return null;
};

const CONNECT_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 25_000;

/** Create a connected `@modelcontextprotocol/sdk` Client for the given server. */
const createSDKClient = async (config: MCPServerConfig) => {
    // Defense-in-depth SSRF check — even if a user saves a config with a
    // private/loopback/CGNAT/multicast URL (or one that resolves to such
    // ranges via a hostname literal that escaped write-time validation),
    // refuse to connect at use-time. The Worker runtime cannot do forward
    // DNS resolution so a malicious DNS record pointing example.com →
    // 10.0.0.1 still slips through here. Egress controls and platform
    // allowlists are the second layer.
    if (!isSafeUrl(config.url)) {
        throw new Error("MCP server URL rejected: only public http(s) URLs are allowed");
    }

    const headers = headersToRecord(config.headers);
    const url = new URL(config.url);

    // Dynamic imports keep bundle size down and isolate Node-specific code
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    let transport;

    if (config.protocol === "sse") {
        const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");

        transport = new SSEClientTransport(url, headers ? { requestInit: { headers } } : undefined);
    } else {
        const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

        transport = new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined);
    }

    const client = new Client({ name: "anole-chat-mcp-proxy", version: "1.0.0" });

    const connectTimeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("MCP server connection timed out")), CONNECT_TIMEOUT_MS);
    });

    try {
        await Promise.race([client.connect(transport), connectTimeout]);
    } catch (error) {
        // Ensure transport resources are released even if connect fails
        await client.close().catch(() => {});
        throw error;
    }

    return client;
};

/** Standard 401 response for unauthenticated requests. */
const unauthorized = (): Response => Response.json({ error: "Not authenticated" }, { headers: { "Content-Type": "application/json" }, status: 401 });

/** Per-user proxy rate limit; returns a 429 Response on exhaust, null on pass. */
const enforceProxyRateLimit = async (context: HttpActionCtx, userId: string, plan?: string): Promise<Response | null> => {
    const tier = plan === "premium" || plan === "ultra" ? "premium" : "free";
    const result = await checkRateLimit(context, `mcp/proxy:${tier}`, {
        key: userId,
        throws: false,
    });

    if (result.ok) return null;

    return Response.json({ error: "MCP proxy rate limit exceeded" }, { status: 429 });
};

/** Race a promise against a hard timeout, ensuring no operation outlives the limit. */
const withOperationTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });

    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

/** Authenticate the incoming request and return the user, or null. */
const authenticate = async (context: HttpActionCtx): Promise<{ _id: string } | null> => {
    try {
        return (await getCurrentUserInternal(context)) as { _id: string } | null;
    } catch (error: unknown) {
        const message = (error as Error)?.message ?? "";

        if (message.includes("OIDC token") || message.includes("token claim")) {
            return null;
        }

        throw error;
    }
};

// ---------------------------------------------------------------------------
// HTTP Action: Fetch a ui:// resource from an MCP server
// ---------------------------------------------------------------------------

/**
 * POST /mcp/resource
 * Body: { serverName: string; uri: string }
 *
 * Fetches a ui:// (or any other) resource URI from the named MCP server and
 * returns the ReadResourceResult JSON.  Used by McpAppView on the frontend to
 * load the HTML for the sandboxed iframe without exposing auth headers.
 */
export const readMCPResourceHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    const user = await authenticate(context);

    if (!user) {
        return unauthorized();
    }

    const rateLimited = await enforceProxyRateLimit(context, user._id);

    if (rateLimited) return rateLimited;

    let body: { serverName?: string; uri?: string };

    try {
        body = (await request.json()) as typeof body;
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { serverName, uri } = body;

    if (!serverName || !uri) {
        return Response.json({ error: "Missing serverName or uri" }, { status: 400 });
    }

    const serverConfig = await findServerConfig(context, user._id, serverName);

    if (!serverConfig) {
        return Response.json({ error: `MCP server "${serverName}" not found` }, { status: 404 });
    }

    try {
        const result = await withServerClient(
            serverConfig,
            async (client) => await withOperationTimeout(client.readResource({ uri }), OPERATION_TIMEOUT_MS, "MCP readResource"),
        );

        return Response.json(result, { headers: { "Content-Type": "application/json" } });
    } catch (error: unknown) {
        return Response.json({ error: (error as Error)?.message ?? "Failed to read resource" }, { status: 502 });
    }
};

// ---------------------------------------------------------------------------
// HTTP Action: Proxy a tool call from an MCP App iframe
// ---------------------------------------------------------------------------

/**
 * POST /mcp/tool
 * Body: { serverName: string; toolName: string; arguments: Record<string, unknown> }
 *
 * Proxies a tools/call request from an MCP App iframe back to the actual MCP
 * server.  The AppRenderer's onCallTool callback uses this endpoint so that
 * auth credentials never leave the server.
 */
export const callMCPToolFromAppHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    const user = await authenticate(context);

    if (!user) {
        return unauthorized();
    }

    const rateLimited = await enforceProxyRateLimit(context, user._id);

    if (rateLimited) return rateLimited;

    let body: { arguments?: Record<string, JSONValue>; serverName?: string; toolName?: string };

    try {
        body = (await request.json()) as typeof body;
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { arguments: toolArgs = {}, serverName, toolName } = body;

    if (!serverName || !toolName) {
        return Response.json({ error: "Missing serverName or toolName" }, { status: 400 });
    }

    const serverConfig = await findServerConfig(context, user._id, serverName);

    if (!serverConfig) {
        return Response.json({ error: `MCP server "${serverName}" not found` }, { status: 404 });
    }

    const overrides = (await context.runQuery(internal.chat.tool_permissions.getToolPermissionsQuery, { userId: user._id })) as ToolPermissionOverrides;
    const descriptor = descriptorFor(serverConfig, toolName);
    const chosen = isToolPermissionMode(overrides[descriptor.key]) ? resolveToolPermission(descriptor, overrides) : undefined;
    const refusedUpFront = chosen && refusalFor(chosen, toolName);

    if (refusedUpFront) {
        return Response.json({ error: refusedUpFront }, { status: 403 });
    }

    try {
        const outcome = await withServerClient(serverConfig, async (client) => {
            const refused = chosen ? null : refusalFor(await annotatedToolMode(client, descriptor, toolName), toolName);

            if (refused) {
                return { refused };
            }

            return {
                result: await withOperationTimeout(client.callTool({ arguments: toolArgs, name: toolName }), OPERATION_TIMEOUT_MS, "MCP callTool"),
            };
        });

        if ("refused" in outcome) {
            return Response.json({ error: outcome.refused }, { status: 403 });
        }

        return Response.json(outcome.result, { headers: { "Content-Type": "application/json" } });
    } catch (error: unknown) {
        return Response.json({ error: (error as Error)?.message ?? "Failed to call tool" }, { status: 502 });
    }
};
