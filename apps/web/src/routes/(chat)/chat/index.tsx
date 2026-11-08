import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery } from "@tanstack/react-query";
import { createFileRoute, useLocation, useNavigate, useRouteContext, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import Assistant from "@/features/chat/assistant";
import { usePromptLinkDraft } from "@/features/chat/core/hooks/use-prompt-link-draft";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { readPromptLinkSearch } from "@/features/chat/core/utils/prompt-link";
import { BOOTED_ON_CHAT_INDEX } from "@/features/chat/core/utils/resume-boot";
import { LANDING_MESSAGE_KEY } from "@/features/marketing/stores/landing-store";
import { useFeatureFlaggedModelsSettled } from "@/hooks/use-feature-flagged-models";
import { useCRPC } from "@/lib/lunora/crpc";

/** Whether a landing page left a message for this chat; storage can be unavailable (private mode, the server). */
const hasLandingMessage = (): boolean => {
    try {
        return globalThis.sessionStorage?.getItem(LANDING_MESSAGE_KEY) != null;
    } catch {
        return false;
    }
};

// Module scope, so it outlives this component's mounts: a page load resumes once.
// Effects never run during SSR, so it is never shared between requests.
// `firstKey` is the navigation that first showed the chat index on this page load. Only
// that visit may resume: a later New chat (a new navigation) must open a blank chat.
const resumeState: { consumed: boolean; firstKey: string | undefined } = { consumed: false, firstKey: undefined };

const ChatPage = () => {
    const route = "/(chat)/chat/";
    const context = useRouteContext({ from: route });
    const promptId = Route.useSearch({ select: ({ promptId: selected }) => selected });
    const redirectReason = Route.useSearch({ select: ({ redirectReason: selected }) => selected });
    const hasInitialMessage = Route.useSearch({ select: ({ initialMessage }) => initialMessage });
    const location = useLocation();
    // Read from the address as written (the history's own query), not the router's search: its parser reads a value as JSON and
    // `searchStr` is built back from that, which would change a prompt like `{"task":"summarise"}`, `"quoted"` or `1.50`.
    // Decoded as a query string is, so `+` is a space (`?prompt=Explain+this` is how links write one); a literal plus is `%2B`.
    const router = useRouter();
    const rawSearch = new URLSearchParams(router.history.location.search);
    const { model: linkModel, prompt: linkPrompt } = readPromptLinkSearch({
        model: rawSearch.get("model") ?? undefined,
        prompt: rawSearch.get("prompt") ?? undefined,
    });
    // TanStack keys each history entry; a new navigation gets a new key.
    const navigationKey = location.state.__TSR_key;
    const { t } = useLingui();
    const shownNotificationRef = useRef<string | undefined>(undefined);
    const initialMessageReadRef = useRef(false);
    const navigate = useNavigate();
    const crpc = useCRPC();
    const { data: userSettings } = useUserSettings();
    const { hooks } = useAuth();
    const { data: activeOrganization, isPending: isOrgPending } = hooks.useActiveOrganization();
    const { data: sessionData, isPending: isSessionPending } = hooks.useSession();
    const activeTeamId = (sessionData?.session as { activeTeamId?: string | null } | undefined)?.activeTeamId ?? undefined;
    const resumeScopeReady = !isOrgPending && !isSessionPending;
    const resumeLastChat =
        BOOTED_ON_CHAT_INDEX && userSettings?.resumeLastChat === true && !promptId && !redirectReason && !hasInitialMessage && resumeScopeReady;

    // A landing message competes with the link only when it is really there: a stale `initialMessage` flag with nothing stored
    // would otherwise turn the link away for a draft that never comes. Read before the effect below consumes it.
    const [landingMessageStored] = useState(() => hasInitialMessage === true && hasLandingMessage());

    // A saved prompt in the same address: the link waits until it has loaded. One that applies fills the composer first (its loader
    // runs in a child, so its effect comes before this one), and the link then finds a draft; one that is missing or refused does
    // not, and the link applies. The same query as the loader's, so it is read once.
    const savedPrompt = useQuery(crpc.prompts.functions.getPrompt.queryOptions(promptId ? { promptId: promptId as Id<"prompts"> } : skipToken));
    // The loader checks the prompt's model against the picker's list before it fills the composer, so it decides only once that
    // list has settled too.
    const modelsSettled = useFeatureFlaggedModelsSettled();
    const savedPromptSettled = !promptId || ((savedPrompt.isSuccess || savedPrompt.isError) && modelsSettled);

    const { data: latestThreadId, isSuccess: latestResolved } = useQuery(
        // Not live, and skipped once decided: later visits to /chat must not re-run the scan.
        crpc.chat.resume.latestResumableThread.queryOptions(
            resumeLastChat && !resumeState.consumed ? { organizationId: activeOrganization?.id ?? null, teamId: activeTeamId } : skipToken,
            { live: false },
        ),
    );

    const [initialMessage, setInitialMessage] = useState<string | undefined>(undefined);

    usePromptLinkDraft({
        // Waiting only until the handoff is read: once it is, the message is the composer's draft (or was cleared), and a link
        // opened later is judged against that, not against a handoff already used.
        otherDraftSource: landingMessageStored && hasInitialMessage === true && initialMessage === undefined,
        model: linkModel,
        prompt: linkPrompt,
        ready: savedPromptSettled,
    });

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
        resumeState.firstKey ??= navigationKey;
    }, [navigationKey]);

    useEffect(() => {
        if (!resumeLastChat || !latestResolved || resumeState.consumed) {
            return;
        }

        resumeState.consumed = true;

        if (navigationKey !== resumeState.firstKey) {
            return;
        }

        // The composer's stored draft (text or attachments) survives a blur, so it is read from the store, not focus. Focus
        // alone is not typing: the composer autofocuses on a blank chat.
        const { composerAttachments, composerText } = useChatUIStore.getState();
        const focused = document.activeElement;
        const hasDraft =
            composerText.trim() !== "" ||
            composerAttachments.length > 0 ||
            ((focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement) && focused.value.trim() !== "") ||
            (focused instanceof HTMLElement && focused.isContentEditable && (focused.textContent ?? "").trim() !== "");

        if (hasDraft) {
            return;
        }

        if (latestThreadId) {
            void navigate({ params: { threadId: latestThreadId }, replace: true, search: { initialMessage: undefined }, to: "/chat/$threadId" });
        }
    }, [latestResolved, latestThreadId, navigationKey, navigate, resumeLastChat]);

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
        const supportedParams = new Set(["initialMessage", "model", "prompt", "promptId", "redirectReason", "settings", "settingsTab"]);
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
        // A prompt link (`core/utils/prompt-link.ts`): applied as a draft once, never sent (`core/hooks/use-prompt-link-draft.ts`).
        // The page reads its text from the raw query; here the two keys are only passed on as the router parsed them, so a
        // navigation that keeps the search writes them back unchanged, and clearing them is typed.
        return {
            model: search.model as unknown,
            prompt: search.prompt as unknown,
            promptId: search.promptId as string | undefined,
            redirectReason: search.redirectReason as string | undefined,
            // `|| undefined`, not `false`: a default written into the search is put into the URL, and the
            // router then redirects a bare `/chat` to `/chat?initialMessage=false` before it renders.
            initialMessage: search.initialMessage === true || search.initialMessage === "true" || undefined,
        };
    },
    component: ChatPage,
    // Disable pending component - the chat UI handles its own states
    pendingComponent: () => null,
});
