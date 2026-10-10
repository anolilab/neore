"use client";

/**
 * McpAppView — renders an MCP App (interactive iframe) for a tool result.
 *
 * Uses the `@mcp-ui/client` AppRenderer, which handles the full lifecycle:
 * - Fetches the ui:// resource HTML via the Lunora proxy (auth stays server-side)
 * - Renders it inside a double-sandboxed iframe (proxy.mcpui.dev outer sandbox)
 * - Provides bidirectional JSON-RPC communication over postMessage
 *
 * The `lunoraSiteUrl` prop is required — pass VITE_LUNORA_URL from your app's env.
 *
 * Spec: https://modelcontextprotocol.io/extensions/apps/overview
 */

import { useLingui } from "@lingui/react/macro";
import type { AppRendererProps } from "@mcp-ui/client";
import { AppRenderer } from "@mcp-ui/client";
import { AlertCircle } from "lucide-react";
import { memo, useCallback } from "react";

import type { ToolPart } from "../types/message";
import cn from "../utils/cn";

type OnReadResource = NonNullable<AppRendererProps["onReadResource"]>;
type OnCallTool = NonNullable<AppRendererProps["onCallTool"]>;
type OnOpenLink = NonNullable<AppRendererProps["onOpenLink"]>;

export interface McpAppViewProps {
    /** Base URL of the Lunora HTTP actions site (VITE_LUNORA_URL). */
    lunoraSiteUrl: string;
    part: ToolPart;
    resourceUri: string;
    serverName: string;
    toolName: string;
}

const SANDBOX_URL = new URL("https://proxy.mcpui.dev");

const McpAppView = memo<McpAppViewProps>(({ lunoraSiteUrl, part, resourceUri, serverName, toolName }) => {
    const { t } = useLingui();
    const isError = part.state === "output-error";

    const onReadResource = useCallback<OnReadResource>(
        async (params) => {
            const response = await fetch(`${lunoraSiteUrl}/mcp/resource`, {
                body: JSON.stringify({ serverName, uri: params.uri }),
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });

            if (!response.ok) {
                const { error } = (await response.json().catch(() => {
                    return {};
                })) as { error?: string };

                throw new Error(error ?? `Resource fetch failed (${response.status})`);
            }

            return response.json() as ReturnType<OnReadResource>;
        },
        [lunoraSiteUrl, serverName],
    );

    const onCallTool = useCallback<OnCallTool>(
        async (params) => {
            const response = await fetch(`${lunoraSiteUrl}/mcp/tool`, {
                body: JSON.stringify({
                    arguments: params.arguments ?? {},
                    serverName,
                    toolName: params.name,
                }),
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });

            if (!response.ok) {
                const { error } = (await response.json().catch(() => {
                    return {};
                })) as { error?: string };

                throw new Error(error ?? `Tool call failed (${response.status})`);
            }

            return response.json() as ReturnType<OnCallTool>;
        },
        [lunoraSiteUrl, serverName],
    );

    const onOpenLink = useCallback<OnOpenLink>(({ url }) => {
        window.open(url, "_blank", "noopener,noreferrer");

        return Promise.resolve({}) as ReturnType<OnOpenLink>;
    }, []);

    if (isError) {
        return (
            <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
                <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
                <span>{part.errorText ?? t`Tool call failed`}</span>
            </div>
        );
    }

    return (
        <div className={cn("mt-2 overflow-hidden rounded-md border border-gray-200 dark:border-gray-700", "min-h-[200px]")}>
            <AppRenderer
                onCallTool={onCallTool}
                onOpenLink={onOpenLink}
                onReadResource={onReadResource}
                sandbox={{ url: SANDBOX_URL }}
                toolInput={part.input as AppRendererProps["toolInput"]}
                toolName={toolName}
                toolResourceUri={resourceUri}
                toolResult={part.output as AppRendererProps["toolResult"]}
            />
        </div>
    );
});

McpAppView.displayName = "McpAppView";

export default McpAppView;
