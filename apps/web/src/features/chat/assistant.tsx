/**
 * Assistant - Main chat entry point using ChatProvider
 */

import { useLingui } from "@lingui/react/macro";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@neore/ui/components/resizable";
import { SidebarInset } from "@neore/ui/components/sidebar";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import type { CSSProperties, FC } from "react";
import { lazy, Suspense, useCallback, useState } from "react";

import { ChatProvider } from "@/features/chat/core/context/chat-context";
import type { ModelId } from "@/features/chat/core/stores/model-store";
import AppSidebar from "@/features/layout/components/app-sidebar";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import usePromptLoader from "@/features/prompts/hooks/use-prompt-loader";

import ChatSiteHeader from "./header/chat-header";
import ThreadSidebar from "./sidebar/thread-sidebar";
import { useSplitLayoutStore } from "./split/split-layout-store";
import Thread from "./thread/thread";
import ThreadList from "./thread-list/thread-list";
import ThreadListHeader from "./thread-list/thread-list-header";
import useCanvasPanel from "./use-canvas-panel";

// Loaded only for people who turned the split view on.
const ChatSplitView = lazy(() => import("./split/chat-split-view"));

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
    const { t } = useLingui();

    // Load prompt if promptId is provided (must be inside ChatProvider)
    usePromptLoader(promptId);
    const { isPanelOpen, label: panelLabel, panel } = useCanvasPanel(threadId);
    const rightSidebarWidth = useUIStateStore((s) => s.rightSidebarWidth);

    return (
        <div className="animate-in fade-in flex h-dvh w-full duration-150">
            <AppSidebar content={<ThreadList />} header={<ThreadListHeader />} name="assistant" />
            <SidebarInset className="dark:bg-brand-obsidian md:peer-data-[variant=inset]:m-1" data-focus-area="thread">
                <ChatSiteHeader threadId={threadId} />
                {/* The thread keeps its place in the group whether or not the side panel is open: moving it would remount it,
                    which scrolls it to the bottom and reloads every attachment preview in it. */}
                <ResizablePanelGroup className="h-[calc(100%-40px)]">
                    <ResizablePanel defaultSize={isPanelOpen ? "50%" : "100%"} id="thread" minSize={isPanelOpen ? "30%" : undefined}>
                        <Thread className="h-full" initialMessage={initialMessage} />
                    </ResizablePanel>
                    {isPanelOpen && <ResizableHandle withHandle />}
                    {isPanelOpen && (
                        <ResizablePanel aria-label={panelLabel} data-focus-area="canvas" defaultSize="50%" id="canvas" minSize="25%" role="region">
                            {panel}
                        </ResizablePanel>
                    )}
                </ResizablePanelGroup>
            </SidebarInset>
            <div
                aria-label={t`Thread details`}
                data-sidebar-right-wrapper=""
                role="complementary"
                style={{ "--sidebar-width": `${rightSidebarWidth}px` } as CSSProperties}
            >
                <ThreadSidebar threadId={threadId} />
            </div>
        </div>
    );
};

/**
 * The page with the split view on: several chats side by side in place of the single thread and the canvas group. The URL names
 * one chat; the header and the right-hand panel follow whichever pane has focus. The panes carry their own gates and providers,
 * and the focused one renders the panel into the wrapper below, so it runs under its own chat's provider.
 */
const SplitAssistantContent: FC<{
    initialMessage?: string;
    initialThread?: ThreadData | null;
    jwtToken: string;
    threadId: string;
}> = ({ initialMessage, initialThread, jwtToken, threadId }) => {
    const { t } = useLingui();
    const rightSidebarWidth = useUIStateStore((s) => s.rightSidebarWidth);
    const focusedThreadId = useSplitLayoutStore((s) => s.layout.panes[s.layout.focus]) ?? threadId;
    const [sidebarSlot, setSidebarSlot] = useState<HTMLDivElement | null>(null);
    const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
    // A PDF opened from a pane's thumbnail belongs to that pane's chat, and that pane takes focus so the panel shows.
    const resolveOpenThreadId = useCallback((opener: HTMLElement | undefined): string | undefined => {
        const paneThreadId = opener?.closest<HTMLElement>("[data-pane-thread-id]")?.dataset.paneThreadId;

        if (paneThreadId !== undefined) {
            useSplitLayoutStore.getState().dispatch({ threadId: paneThreadId, type: "open" });
        }

        return paneThreadId;
    }, []);
    const { isPanelOpen, label: panelLabel, panel } = useCanvasPanel(focusedThreadId, { resolveOpenThreadId });

    return (
        <div className="animate-in fade-in flex h-dvh w-full duration-150">
            <AppSidebar content={<ThreadList />} header={<ThreadListHeader />} name="assistant" />
            <SidebarInset className="dark:bg-brand-obsidian md:peer-data-[variant=inset]:m-1" data-focus-area="thread">
                {/* The focused pane renders its chat's header here, under its own gate and provider. */}
                <div className="contents" ref={setHeaderSlot} />
                <ResizablePanelGroup className="h-[calc(100%-40px)]">
                    <ResizablePanel defaultSize={isPanelOpen ? "60%" : "100%"} id="thread" minSize={isPanelOpen ? "30%" : undefined}>
                        <Suspense fallback={null}>
                            <ChatSplitView
                                headerSlot={headerSlot}
                                initialMessage={initialMessage}
                                initialThread={initialThread}
                                jwtToken={jwtToken}
                                routeThreadId={threadId}
                                sidebarSlot={sidebarSlot}
                            />
                        </Suspense>
                    </ResizablePanel>
                    {isPanelOpen && <ResizableHandle withHandle />}
                    {isPanelOpen && (
                        <ResizablePanel aria-label={panelLabel} data-focus-area="canvas" defaultSize="40%" id="canvas" minSize="25%" role="region">
                            {panel}
                        </ResizablePanel>
                    )}
                </ResizablePanelGroup>
            </SidebarInset>
            <div
                aria-label={t`Thread details`}
                data-sidebar-right-wrapper=""
                ref={setSidebarSlot}
                role="complementary"
                style={{ "--sidebar-width": `${rightSidebarWidth}px` } as CSSProperties}
            />
        </div>
    );
};

const Assistant: FC<AssistantProperties> = ({ initialMessage, initialThread, jwtToken, model, promptId, threadId }) => {
    // Read after hydration: the preference lives in this browser, and the server render is always the single thread.
    const isHydrated = useIsHydrated();
    const isSplitView = useUIStateStore((s) => s.preferences.splitViewEnabled === true);

    if (isHydrated && isSplitView && threadId) {
        return <SplitAssistantContent initialMessage={initialMessage} initialThread={initialThread} jwtToken={jwtToken} threadId={threadId} />;
    }

    return (
        <ChatProvider initialThread={initialThread} jwtToken={jwtToken} model={model} threadId={threadId}>
            <AssistantContent initialMessage={initialMessage} promptId={promptId} threadId={threadId} />
        </ChatProvider>
    );
};

export default Assistant;
