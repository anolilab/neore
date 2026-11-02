/**
 * MCP Tools Integration
 *
 * Connects to user-configured MCP servers and retrieves their tools
 * for injection into the chat agent's tool set.
 *
 * Uses `@ai-sdk/mcp` for lightweight MCP client connections.
 */
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

import { toolsLogger } from "../../lib/logger";
import { validateDomain } from "../tools/utilities";
import { createAuthRetrySession, renewBearer, retryOnUnauthorized } from "./mcp-auth-retry";
import { createProgressCall, runWithProgressCall } from "./mcp-progress";
import type { ToolProgressSink } from "./mcp-progress";
import { attachProgressTokens } from "./mcp-progress-transport";
import type { ToolAnnotationHints } from "./tool-permissions";
import { readMcpAnnotations } from "./tool-permissions";

/**
 * MCP server configuration from user preferences
 */
export interface MCPServerConfig {
    /** Set when the server is a connected connector (`connectors/lib/grant-runtime.ts`); its tools are keyed `connector:<slug>:<tool>`. */
    connectorSlug?: string;
    enabled: boolean;
    headers?: { key: string; value: string }[];
    icon?: string;
    name: string;
    /**
     * Set when the bearer token came from an OAuth grant (a connector, or a
     * user's server they signed in to). A 401 then gets ONE refresh-and-retry
     * (`mcp-auth-retry.ts`) before the grant is declared expired. Runtime-only:
     * never persisted.
     */
    oauth?: MCPServerOAuth;
    protocol: "sse" | "http";
    url: string;
}

export interface MCPServerOAuth {
    /** Declare the grant dead (a fresh token was refused too). */
    markExpired: () => Promise<void>;
    /** The user-facing way out, e.g. "Reconnect Notion in Settings → Connectors". */
    reconnectHint: string;
    /** Force a token refresh. The new access token, or `null` when the grant cannot be revived (already marked). */
    refresh: () => Promise<string | null>;
}

/** Where an MCP runtime tool came from. The runtime name alone cannot say. */
export interface MCPToolDescriptor {
    /** Untrusted hints the server declared (`metadata.annotations`). */
    annotations?: ToolAnnotationHints;
    /** The connector this tool came through, if any. */
    connectorSlug?: string;
    serverName: string;
    toolName: string;
    /** The saved server's address, for a server that is not a connector: two servers can share a name, so trust is keyed on the pair. */
    url?: string;
}

/**
 * Result of connecting to MCP servers
 */
interface MCPToolsResult {
    /** MCP clients that need to be closed after streaming */
    clients: MCPClient[];
    /** Runtime tool name -> the server and tool it stands for. One entry per key of `tools`. */
    descriptors: Map<string, MCPToolDescriptor>;
    /** Errors from servers that failed to connect */
    errors: { error: string; serverName: string }[];
    /** Combined tool set from all connected MCP servers */
    tools: ToolSet;
}

/**
 * Runtime name the agent sees for an MCP tool: `mcp_<sanitised server>__<tool>`.
 *
 * Sanitising is lossy ("my server" and "my_server" both become `my_server`), so
 * a name already taken gets `_2`, `_3`, … in encounter order — deterministic for
 * the same servers in the same order, which is what a resumed run rebuilds.
 */
export const mcpRuntimeToolName = (serverName: string, toolName: string, taken: { has: (name: string) => boolean } = new Set()): string => {
    const base = `mcp_${serverName.replaceAll(/[^a-z0-9]/gi, "_")}__${toolName}`;
    let name = base;
    let suffix = 1;

    while (taken.has(name)) {
        suffix += 1;
        name = `${base}_${suffix}`;
    }

    return name;
};

/**
 * Convert user-configured headers array to a Record.
 */
export const headersToRecord = (headers?: { key: string; value: string }[]): Record<string, string> | undefined => {
    if (!headers || headers.length === 0) {
        return undefined;
    }

    const record: Record<string, string> = {};

    for (const { key, value } of headers) {
        record[key] = value;
    }

    return record;
};

export interface MCPConnection {
    client: MCPClient;
    tools: ToolSet;
}

/**
 * The SSRF guard for every outbound MCP connection. The URL is user-supplied
 * (`aiUserPreferences.mcpServers`, or the test dialog), the connection runs from
 * the backend Worker, and its error text goes back to the caller — so a private,
 * loopback or metadata address must never be dialled. Same rule as the
 * browser/fetch tools (`validateDomain`).
 */
export const assertSafeMcpUrl = (url: string): void => {
    const blocked = validateDomain(url);

    if (blocked) {
        throw new Error(`MCP server URL is not allowed: ${blocked}`);
    }
};

/** Connect and list tools, once. Throws on failure, closing the half-open client. */
const connectOnce = async (config: MCPServerConfig, timeoutMs: number): Promise<MCPConnection> => {
    assertSafeMcpUrl(config.url);

    const headers = headersToRecord(config.headers);

    const client = await createMCPClient({
        transport: {
            type: config.protocol,
            url: config.url,
            ...(headers && { headers }),
        },
    });

    attachProgressTokens(client);

    try {
        // Get tools with a timeout to avoid hanging on unresponsive servers
        const toolsPromise = client.tools();
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`Tool discovery timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        return { client, tools: await Promise.race([toolsPromise, timeoutPromise]) };
    } catch (error) {
        await client.close().catch(() => {});
        throw error;
    }
};

/**
 * Connect to a single MCP server and retrieve its tools. An OAuth-backed server
 * answering 401 gets one refreshed token before the grant is declared expired.
 * Returns null if connection fails.
 */
const connectToMCPServer = async (config: MCPServerConfig, timeoutMs = 10_000): Promise<MCPConnection | null> => {
    try {
        const connection = config.oauth
            ? await retryOnUnauthorized(config.oauth, config, async (target) => await connectOnce(target, timeoutMs), renewBearer(config.oauth))
            : await connectOnce(config, timeoutMs);

        toolsLogger.debug(`[MCP] Connected to "${config.name}" - discovered ${Object.keys(connection.tools).length} tools`);

        return connection;
    } catch (error: any) {
        toolsLogger.error(`[MCP] Failed to connect to "${config.name}":`, error?.message || error);

        return null;
    }
};

type Tool = ToolSet[string];

/** How long a finished call waits for its progress rows to be written before it hands its result back anyway. */
export const PROGRESS_FINISH_DEADLINE_MS = 2000;

/** `promise`, or nothing once `ms` has passed: progress is display only, so a stalled write never holds a tool's result. */
const settleWithin = async (promise: Promise<void>, ms: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        await Promise.race([
            promise,
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * `tool` reporting the server's progress to `sink` while it runs. The call's id
 * is its `progressToken`; the reports stop, and the row's progress with them,
 * when the call returns or throws.
 */
const withProgress = (tool: Tool, label: { serverName: string; toolName: string }, sink: ToolProgressSink): Tool => {
    const run = tool.execute;

    if (!run) {
        return tool;
    }

    const execute: NonNullable<Tool["execute"]> = async (input, options) => {
        const toolCallId = options?.toolCallId;

        if (!toolCallId) {
            return await run(input, options);
        }

        const progress = sink({ ...label, toolCallId });
        const call = createProgressCall({ onProgress: progress.push, token: toolCallId });

        try {
            return await runWithProgressCall(call, async () => await run(input, options));
        } finally {
            call.release();
            await settleWithin(progress.finish(), PROGRESS_FINISH_DEADLINE_MS);
        }
    };

    return { ...tool, execute } as Tool;
};

export interface GetMCPToolsOptions {
    /** Where a running call's progress goes. Omit it (no stream to show it on) and tools run exactly as before. */
    progress?: ToolProgressSink;
}

/**
 * Connect to all enabled MCP servers and return their combined tools.
 *
 * IMPORTANT: The returned clients MUST be closed after streaming completes
 * by calling `closeMCPClients(result.clients)`.
 */
export const getMCPTools = async (servers: MCPServerConfig[], { progress }: GetMCPToolsOptions = {}): Promise<MCPToolsResult> => {
    const enabledServers = servers.filter((s) => s.enabled);

    if (enabledServers.length === 0) {
        return { clients: [], descriptors: new Map(), errors: [], tools: {} };
    }

    toolsLogger.debug(`[MCP] Connecting to ${enabledServers.length} MCP server(s)...`);

    const results = await Promise.allSettled(enabledServers.map((server) => connectToMCPServer(server)));

    const tools: ToolSet = {};
    const descriptors = new Map<string, MCPToolDescriptor>();
    const clients: MCPClient[] = [];
    const errors: { error: string; serverName: string }[] = [];

    for (const [i, result] of results.entries()) {
        const server = enabledServers[i];

        if (!server) {
            continue;
        }

        if (result?.status === "fulfilled" && result.value) {
            const { client, tools: serverTools } = result.value;

            clients.push(client);

            // Mid-run 401 → one refresh and one fresh client for the whole
            // server, which joins `clients` so the caller's `closeMCPClients`
            // closes it too.
            const session = createAuthRetrySession(server, serverTools, async (config) => {
                const retry = await connectOnce(config, 10_000);

                clients.push(retry.client);

                return retry;
            });

            for (const [toolName, tool] of Object.entries(serverTools)) {
                const runtimeName = mcpRuntimeToolName(server.name, toolName, descriptors);
                const annotations = readMcpAnnotations(tool);

                const wrapped = session.wrap(toolName, tool);

                tools[runtimeName] = progress ? withProgress(wrapped, { serverName: server.name, toolName }, progress) : wrapped;
                descriptors.set(runtimeName, {
                    ...(annotations && { annotations }),
                    ...(server.connectorSlug && { connectorSlug: server.connectorSlug }),
                    serverName: server.name,
                    toolName,
                    ...(!server.connectorSlug && { url: server.url }),
                });
            }
        } else {
            const errorMessage = result?.status === "rejected" ? result.reason?.message || String(result.reason) : "Connection returned null";

            errors.push({ error: errorMessage, serverName: server.name });
        }
    }

    toolsLogger.debug(`[MCP] Total MCP tools available: ${Object.keys(tools).length} from ${clients.length} server(s)`);

    if (errors.length > 0) {
        toolsLogger.warn(`[MCP] ${errors.length} server(s) failed to connect:`, errors);
    }

    return { clients, descriptors, errors, tools };
};

/**
 * Result of testing a single MCP server connection
 */
export interface MCPTestResult {
    /** Error message if connection failed */
    error?: string;
    /** Time in ms to connect and discover tools */
    latencyMs: number;
    /** Whether the connection was successful */
    ok: boolean;
    /** Tool names discovered on the server */
    tools: string[];
}

/**
 * Test a single MCP server connection and return discovered tool names.
 * Connects, discovers tools, then immediately disconnects.
 */
export const testMCPServer = async (config: MCPServerConfig): Promise<MCPTestResult> => {
    const start = Date.now();

    try {
        const result = await connectToMCPServer(config, 15_000);

        if (!result) {
            return { error: "Connection failed", latencyMs: Date.now() - start, ok: false, tools: [] };
        }

        const toolNames = Object.keys(result.tools);

        // Immediately close — this is just a health check
        try {
            await result.client.close();
        } catch {
            // Ignore close errors during health check
        }

        return { latencyMs: Date.now() - start, ok: true, tools: toolNames };
    } catch (error: any) {
        return { error: error?.message || String(error), latencyMs: Date.now() - start, ok: false, tools: [] };
    }
};

/**
 * Safely close all MCP clients.
 * Should be called after streaming completes.
 */
export const closeMCPClients = async (clients: MCPClient[]): Promise<void> => {
    if (clients.length === 0) {
        return;
    }

    const closeResults = await Promise.allSettled(clients.map((c) => c.close()));

    for (const result of closeResults) {
        if (result.status === "rejected") {
            toolsLogger.warn(`[MCP] Error closing client:`, result.reason?.message || result.reason);
        }
    }

    toolsLogger.debug(`[MCP] Closed ${clients.length} MCP client(s)`);
};
