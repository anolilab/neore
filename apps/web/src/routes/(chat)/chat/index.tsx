import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, useLocation, useRouteContext } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import Assistant from "@/features/chat/assistant";
import { LANDING_MESSAGE_KEY } from "@/features/marketing/stores/landing-store";

const ChatPage = () => {
    const route = "/(chat)/chat/";
    const context = useRouteContext({ from: route });
    const promptId = Route.useSearch({ select: ({ promptId: selected }) => selected });
    const redirectReason = Route.useSearch({ select: ({ redirectReason: selected }) => selected });
    const hasInitialMessage = Route.useSearch({ select: ({ initialMessage }) => initialMessage });
    const location = useLocation();
    const { t } = useLingui();
    const shownNotificationRef = useRef<string | undefined>(undefined);
    const initialMessageReadRef = useRef(false);

    const [initialMessage, setInitialMessage] = useState<string | undefined>(undefined);

    // Read the initial message from sessionStorage (only once). This consumes the
    // handoff — the entry is deleted — so it cannot run during render: React may
    // replay or discard a render, and the message would be swallowed by one that
    // never commits (StrictMode's double render did exactly that).
    useEffect(() => {
        if (!hasInitialMessage || initialMessageReadRef.current) {
            return;
        }

        const message = sessionStorage.getItem(LANDING_MESSAGE_KEY);

        if (!message) {
            return;
        }

        sessionStorage.removeItem(LANDING_MESSAGE_KEY);
        initialMessageReadRef.current = true;
        setInitialMessage(message);
    }, [hasInitialMessage]);

    useEffect(() => {
        if (!redirectReason || shownNotificationRef.current === redirectReason) {
            return;
        }

        switch (redirectReason) {
            case "invalid-thread-id": {
                toast.error(t`Invalid thread ID`);

                break;
            }
            case "thread-deleted": {
                toast.error(t`This thread has been deleted`);

                break;
            }
            case "thread-not-found": {
                toast.error(t`Thread not found or you don't have access to it`);

                break;
            }
            default: {
                break;
            }
        }

        shownNotificationRef.current = redirectReason;
    }, [redirectReason, t]);

    useEffect(() => {
        // Include initialMessage as allowed (though unused) to prevent warnings during navigation
        // TanStack Router may briefly carry over search params when navigating between routes
        const supportedParams = new Set(["initialMessage", "promptId", "redirectReason", "settings", "settingsTab"]);
        const searchParams = new URLSearchParams(location.search);
        const unsupportedParams: string[] = [];

        for (const [key] of searchParams) {
            if (!supportedParams.has(key)) {
                unsupportedParams.push(key);
            }
        }

        if (unsupportedParams.length > 0) {
            toast.warning(
                t`${plural(unsupportedParams.length, { one: "Unsupported query parameter", other: "Unsupported query parameters" })}: ${unsupportedParams.join(", ")}`,
            );
        }
    }, [location.search, t]);

    return (
        <RouteErrorBoundary routeName={route}>
            <Assistant initialMessage={initialMessage} jwtToken={context.token as string} key="default" promptId={promptId} />
        </RouteErrorBoundary>
    );
};

export const Route = createFileRoute("/(chat)/chat/")({
    validateSearch: (search: Record<string, unknown>) => {
        return {
            promptId: search.promptId as string | undefined,
            redirectReason: search.redirectReason as string | undefined,
            initialMessage: search.initialMessage === true || search.initialMessage === "true",
        };
    },
    component: ChatPage,
    // Disable pending component - the chat UI handles its own states
    pendingComponent: () => null,
});
