/**
 * Assistant - Main chat entry point using ChatProvider
 */

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@neore/ui/components/resizable";
import { SidebarInset } from "@neore/ui/components/sidebar";
import type { CSSProperties, FC } from "react";

import CanvasPanel from "@/features/canvas/canvas-panel";
import { ChatProvider } from "@/features/chat/core/context/chat-context";
import { useCanvasState } from "@/features/chat/core/stores/chat-ui-store";
import type { ModelId } from "@/features/chat/core/stores/model-store";
import AppSidebar from "@/features/layout/components/app-sidebar";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import usePromptLoader from "@/features/prompts/hooks/use-prompt-loader";

import ChatSiteHeader from "./header/chat-header";
import ThreadSidebar from "./sidebar/thread-sidebar";
import Thread from "./thread/thread";
import ThreadList from "./thread-list/thread-list";
import ThreadListHeader from "./thread-list/thread-list-header";

interface ThreadData {
    _id: string;
    branchName?: string;
    branchPoint?: number;
    customSystemPrompt?: string;
    enabledFeatures?: string[];
    language?: string;
    mode?: "text" | "image" | "video";
    model: string;
    parentThreadId?: string;
    reasoningEffort?: number;
    statelessMode?: boolean;
    status?: string;
    title?: string;
}

interface AssistantProperties {
    initialMessage?: string;
    initialThread?: ThreadData | null;
    jwtToken: string;
    model?: ModelId;
    promptId?: string;
    threadId?: string;
}

const AssistantContent: FC<{
    initialMessage?: string;
    promptId?: string;
    threadId?: string;
}> = ({ initialMessage, promptId, threadId }) => {
    // Load prompt if promptId is provided (must be inside ChatProvider)
    usePromptLoader(promptId);
    const { isCanvasOpen } = useCanvasState();
    const rightSidebarWidth = useUIStateStore((s) => s.rightSidebarWidth);

    return (
        <div className="animate-in fade-in flex h-dvh w-full duration-150">
            <AppSidebar content={<ThreadList />} header={<ThreadListHeader />} name="assistant" />
            <SidebarInset className="dark:bg-brand-obsidian md:peer-data-[variant=inset]:m-1">
                <ChatSiteHeader threadId={threadId} />
                {isCanvasOpen ? (
                    <ResizablePanelGroup className="h-[calc(100%-40px)]">
                        <ResizablePanel defaultSize={50} minSize={30}>
                            <Thread className="h-full" initialMessage={initialMessage} />
                        </ResizablePanel>
                        <ResizableHandle withHandle />
                        <ResizablePanel defaultSize={50} minSize={25}>
                            <CanvasPanel />
                        </ResizablePanel>
                    </ResizablePanelGroup>
                ) : (
                    <Thread initialMessage={initialMessage} />
                )}
            </SidebarInset>
            <div data-sidebar-right-wrapper="" style={{ "--sidebar-width": `${rightSidebarWidth}px` } as CSSProperties}>
                <ThreadSidebar threadId={threadId} />
            </div>
        </div>
    );
};

const Assistant: FC<AssistantProperties> = ({ initialMessage, initialThread, jwtToken, model, promptId, threadId }) => (
    <ChatProvider initialThread={initialThread} jwtToken={jwtToken} model={model} threadId={threadId}>
        <AssistantContent initialMessage={initialMessage} promptId={promptId} threadId={threadId} />
    </ChatProvider>
);

export default Assistant;
