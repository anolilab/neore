"use client";

/**
 * McpAppView - Web app re-export that injects the Lunora site URL.
 */

import type { McpAppViewProps as BaseProps } from "@neore/chat-ui/chat/mcp-app-view";
import McpAppViewUI from "@neore/chat-ui/chat/mcp-app-view";
import type { FC } from "react";

import env from "@/lib/env";

type McpAppViewProps = Omit<BaseProps, "lunoraSiteUrl">;

const McpAppView: FC<McpAppViewProps> = (props) => <McpAppViewUI lunoraSiteUrl={env.VITE_LUNORA_URL} {...props} />;

McpAppView.displayName = "McpAppView";
export default McpAppView;
