"use client";

import type { FC } from "react";
import { lazy, Suspense, useCallback, useState } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useLoginPromptStore } from "@/features/auth/stores/login-prompt-store";
import { clearPendingSend } from "@/features/chat/core/utils/pending-send";

const LoginModal = lazy(() => import("./login-modal"));

/** The current URL, so a sign-in that leaves the page (OAuth, magic link) comes back to the chat it started from. */
const currentUrl = (): string | undefined =>
    globalThis.location === undefined ? undefined : `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;

/**
 * Renders the sign-in prompt that sending opens while the visitor may not chat
 * (`openLoginPrompt`). Closing it without signing in drops the pending message
 * (`pending-send.ts`) so it is not sent by surprise on a later sign-in; the
 * draft itself stays in the composer. A successful sign-in closes it too, and
 * then the pending message is kept for the composer to send.
 */
const LoginPromptHost: FC = () => {
    const isOpen = useLoginPromptStore((state) => state.isOpen);
    const setOpen = useLoginPromptStore((state) => state.setOpen);
    const { isAnonymous, user } = useIsAnonymous();
    const isSignedIn = Boolean(user) && !isAnonymous;

    const handleOpenChange = useCallback(
        (open: boolean) => {
            if (!open && !isSignedIn) {
                clearPendingSend();
            }

            setOpen(open);
        },
        [isSignedIn, setOpen],
    );

    // Mounted from the first open on, so closing plays the dialog's exit instead of vanishing.
    const [hasOpened, setHasOpened] = useState(false);

    if (isOpen && !hasOpened) {
        setHasOpened(true);
    }

    if (!hasOpened) {
        return null;
    }

    return (
        <Suspense fallback={null}>
            <LoginModal onOpenChange={handleOpenChange} open={isOpen} redirectTo={currentUrl()} />
        </Suspense>
    );
};

export default LoginPromptHost;
