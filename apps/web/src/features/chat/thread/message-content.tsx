"use client";

/**
 * MessageContent - Web app container.
 * Lifts MCP tool metadata and wires artifact components into the shared chat-ui renderer.
 */

import { useLingui } from "@lingui/react/macro";
import MessageContentUI from "@neore/chat-ui/chat/message-content";
import type { ChatMessage, SandboxOutputs, ToolPart } from "@neore/chat-ui/types";
import type { FC } from "react";
import { lazy, memo, Suspense, useCallback, useMemo } from "react";

import useMCPToolMeta from "@/features/chat/core/hooks/use-mcp-tool-meta";
import LinkPreviewSlot from "@/features/chat/link-preview/link-preview-slot";
import TOOL_WIDGETS from "@/features/chat/thread/widgets";
import KnowledgeSourceGroup from "@/features/knowledge/components/knowledge-source-group";
import type { UIMessage } from "@/lib/agent";

const LazyDocumentArtifact = lazy(() => import("@/features/canvas/document-artifact"));
const LazyMcpAppView = lazy(() => import("@/features/chat/thread/mcp-app-view"));
const LazyToolApproval = lazy(() => import("@/features/chat/thread/tool-approval"));
const LazyAskUserPrompt = lazy(() => import("@/features/chat/thread/ask-user-prompt"));
const LazySubAgentToolView = lazy(() => import("@/features/sub-agents/components/sub-agent-tool-view"));
const LazySandboxFiles = lazy(() => import("@/features/chat/thread/sandbox-files"));
const LazyCodingAgentToolView = lazy(() => import("@/features/coding-agents/components/coding-agent-tool-view"));
const LazyDeviceToolCall = lazy(() => import("@/features/devices/components/device-tool-call"));
const LazyPresentationArtifact = lazy(() =>
    import("@/features/slides").then((m) => {
        return { default: m.PresentationArtifact };
    }),
);

// Suspense-wrapped adapters so chat-ui's MessageContent doesn't need to know about lazy loading
const DocumentArtifact: FC<{ documentId: string; kind: string; title: string; version: number }> = ({ kind, ...props }) => (
    <Suspense fallback={null}>
        <LazyDocumentArtifact kind={kind as "code" | "design" | "image" | "sheet" | "text"} {...props} />
    </Suspense>
);

const McpApp: FC<{ part: any; resourceUri: string; serverName: string; toolName: string }> = (props) => (
    <Suspense fallback={null}>
        <LazyMcpAppView {...props} />
    </Suspense>
);

const AskUserPrompt: FC<{ part: ToolPart }> = (props) => (
    <Suspense fallback={null}>
        <LazyAskUserPrompt {...props} />
    </Suspense>
);

// An `askUser` call pauses as an approval request too, but is answered, not approved.
const ToolApproval: FC<{ part: ToolPart }> = ({ part }) =>
    part.type === "tool-askUser" ? (
        <AskUserPrompt part={part} />
    ) : (
        <Suspense fallback={null}>
            <LazyToolApproval part={part} />
        </Suspense>
    );

const PresentationArtifact: FC<{ presentationId: string; slideCount: number; styleName?: string; title: string }> = (props) => (
    <Suspense fallback={null}>
        <LazyPresentationArtifact {...props} />
    </Suspense>
);

const CodingAgentToolView: FC<{ part: ToolPart }> = (props) => (
    <Suspense fallback={null}>
        <LazyCodingAgentToolView {...props} />
    </Suspense>
);

// A tool that runs on the user's own computer: its status comes from the device, live.
const DeviceToolCall: FC<{ part: ToolPart }> = (props) => (
    <Suspense fallback={null}>
        <LazyDeviceToolCall {...props} />
    </Suspense>
);

const SandboxFiles: FC<SandboxOutputs> = (props) => (
    <Suspense fallback={null}>
        <LazySandboxFiles {...props} />
    </Suspense>
);

const SubAgentToolView: FC<{ part: ToolPart }> = (props) => (
    <Suspense fallback={null}>
        <LazySubAgentToolView {...props} />
    </Suspense>
);

/** Tools whose view follows state that lives outside the message (a background run), or needs the user. */
const TOOL_VIEWS: Record<string, FC<{ part: ToolPart }>> = {
    askUser: AskUserPrompt,
    delegateToCodingAgent: CodingAgentToolView,
    delegateToSubAgent: SubAgentToolView,
};

interface MessageContentProps {
    className?: string;
    isStreaming?: boolean;
    message: UIMessage;
}

// Memoized, with a `components` object that only changes with the MCP tool
// metadata: chat-ui's MessageContent is memoized too, and a fresh object per
// render would re-render every message's content for nothing.
const MessageContent: FC<MessageContentProps> = memo(({ className, isStreaming, message }) => {
    const { t } = useLingui();
    const toolMeta = useMCPToolMeta();
    // Stable per locale, so the memoized chat-ui renderer is not re-rendered for it.
    const citationLabel = useCallback((index: number) => t`Source ${index}`, [t]);
    const components = useMemo(() => {
        return {
            DeviceToolCall,
            DocumentArtifact,
            McpApp,
            PresentationArtifact,
            SandboxFiles,
            SourceGroup: KnowledgeSourceGroup,
            ToolApproval,
            toolMeta,
            toolViews: TOOL_VIEWS,
            toolWidgets: TOOL_WIDGETS,
        };
    }, [toolMeta]);

    return (
        <>
            <MessageContentUI
                citationLabel={citationLabel}
                className={className}
                components={components}
                isStreaming={isStreaming}
                message={message as unknown as ChatMessage}
            />
            <LinkPreviewSlot isStreaming={isStreaming} message={message} />
        </>
    );
});

MessageContent.displayName = "MessageContent";
export default MessageContent;
