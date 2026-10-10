import { Authenticated, AuthLoading, Unauthenticated } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import GlobalCommandPalette from "@/components/command-palette";
import { ModelPickerPopup } from "@/components/model-picker";
import ProgrammableSidebarProvider from "@/components/programmable-sidebar-provider";
import AutoGuestSignIn from "@/features/auth/components/auto-guest-signin";
import { DEFAULT_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import ChatLoadingSkeleton from "@/features/chat/loading/chat-loading-skeleton";
import { KeyboardShortcutsManager } from "@/features/keyboard/components/keyboard-shortcuts-manager";
import useKeyboardShortcutHandler from "@/features/keyboard/hooks/use-keyboard-shortcut-handler";
import { PresentationViewerRoot } from "@/features/slides";
import { createLunoraQueryOptions } from "@/lib/lunora/crpc";
import { LUNORA_ID_SOURCE } from "@/lib/lunora/ids";
import { isAuthError } from "@/lib/utilities";

const CHAT_THREAD_PATH_RE = new RegExp(`^/chat/(${LUNORA_ID_SOURCE})$`);

const OnboardingDialog = lazy(() => import("@/features/onboarding/components/onboarding-dialog"));

const defaultOpen = ["left"];
const sidebarNames = ["left", "right"];
const sidebarStyle = {
    "--header-height": "calc(var(--spacing) * 10)",
    "--sidebar-width": "calc(var(--spacing) * 66)",
} as React.CSSProperties;

const RouteComponent = () => {
    const handleShortcut = useKeyboardShortcutHandler();

    return (
        <>
            <AuthLoading>
                <ChatLoadingSkeleton />
            </AuthLoading>
            <Unauthenticated>
                <AutoGuestSignIn />
            </Unauthenticated>
            <Authenticated>
                <GlobalCommandPalette />
                <ModelPickerPopup />
                <PresentationViewerRoot />
                <Suspense fallback={null}>
                    <OnboardingDialog />
                </Suspense>
                <KeyboardShortcutsManager onShortcut={handleShortcut}>
                    <ProgrammableSidebarProvider defaultOpen={defaultOpen} sidebarNames={sidebarNames} style={sidebarStyle}>
                        <Outlet />
                    </ProgrammableSidebarProvider>
                </KeyboardShortcutsManager>
            </Authenticated>
        </>
    );
};

export const Route = createFileRoute("/(chat)")({
    component: RouteComponent,
    // Preload thread list data when entering any chat route
    // This makes the thread sidebar load instantly
    staleTime: 30_000, // 30 seconds - thread list changes relatively infrequently
    preloadStaleTime: 30_000, // Keep preloaded data fresh for 30 seconds
    gcTime: 10 * 60 * 1000, // 10 minutes - keep thread list data in memory for fast back-navigation
    loader: async ({ context, location }) => {
        if (!context.isAuthenticated) {
            return;
        }

        try {
            const { pathname } = location;
            const threadRouteMatch = pathname.match(CHAT_THREAD_PATH_RE);
            const threadId = threadRouteMatch ? (threadRouteMatch[1] as Id<"threads">) : null;

            void context.queryClient.prefetchQuery(
                createLunoraQueryOptions(context.lunoraClient, api.chat.composite.getThreadListData, {
                    paginationOpts: { cursor: null, numItems: 100 },
                }),
            );

            void context.queryClient.prefetchQuery(
                createLunoraQueryOptions(context.lunoraClient, api.projects.functions.listProjects, {
                    paginationOpts: { cursor: null, endCursor: undefined, id: undefined, numItems: 100 },
                }),
            );

            void context.queryClient.prefetchQuery(createLunoraQueryOptions(context.lunoraClient, api.auth.functions.getUserSettings, {}));

            if (threadId) {
                const routerState = location.state as { isNewThread?: boolean } | undefined;
                const isNewThread = routerState?.isNewThread === true;

                if (!isNewThread) {
                    const seedThreadCaches = async () => {
                        const compositeData = (await context.queryClient.fetchQuery(
                            createLunoraQueryOptions(context.lunoraClient, api.chat.composite.getThreadWithData, {
                                threadId,
                                messageOpts: { cursor: null, numItems: 20 },
                            }),
                        )) as { messages?: unknown; thread?: unknown } | undefined;

                        if (!compositeData) {
                            return;
                        }

                        context.queryClient.setQueryData(
                            createLunoraQueryOptions(context.lunoraClient, api.chat.functions.getThread, { threadId }).queryKey,
                            compositeData.thread,
                        );
                        context.queryClient.setQueryData(
                            createLunoraQueryOptions(context.lunoraClient, api.chat.functions.getThreadUIMessages, {
                                threadId,
                                paginationOpts: DEFAULT_PAGINATION_OPTS,
                            }).queryKey,
                            compositeData.messages,
                        );
                    };

                    void seedThreadCaches();
                }
            }
        } catch (error) {
            if (!isAuthError(error)) {
                console.warn("[ChatRoute] Failed to prefetch:", error);
            }
        }
    },
});
