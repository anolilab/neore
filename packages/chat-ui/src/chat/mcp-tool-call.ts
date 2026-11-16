/** The body of an MCP app's tool call to the backend proxy. `threadId` is the host page's own thread, never anything the app sent. */
export const mcpToolCallBody = (call: { arguments?: unknown; serverName: string; threadId?: string; toolName: string }): string =>
    JSON.stringify({
        arguments: call.arguments ?? {},
        serverName: call.serverName,
        ...(call.threadId !== undefined && { threadId: call.threadId }),
        toolName: call.toolName,
    });
