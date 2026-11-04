"use client";

/**
 * McpAppView - Web app re-export that injects the Lunora site URL.
 */

import type { McpAppViewProps as BaseProps } from "@neore/chat-ui/chat/mcp-app-view";
import McpAppViewUI from "@neore/chat-ui/chat/mcp-app-view";
import type { FC } from "react";
import { use } from "react";

import { ChatThreadContext } from "@/features/chat/core/context/chat-context-hooks";
import env from "@/lib/env";

type McpAppViewProps = Omit<BaseProps, "lunoraSiteUrl" | "threadId">;

const McpAppView: FC<McpAppViewProps> = (props) => {
    // Read without the provider's guard: a view outside a chat has no thread, and its calls then carry none.
    const thread = use(ChatThreadContext);

    return <McpAppViewUI lunoraSiteUrl={env.VITE_LUNORA_URL} threadId={thread?.threadId} {...props} />;
};

McpAppView.displayName = "McpAppView";
export default McpAppView;
