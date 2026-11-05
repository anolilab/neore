"use client";

import { useLocation } from "@tanstack/react-router";
import type { FC } from "react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useLoginPromptStore } from "@/features/auth/stores/login-prompt-store";
import { clearPendingSend } from "@/features/chat/core/utils/pending-send";

const LoginModal = lazy(() => import("./login-modal"));

const QUERY_OR_HASH = /[?#]/;

/** The path part of a URL the store recorded. */
const pathOf = (url: string | undefined): string | undefined => url?.split(QUERY_OR_HASH, 1)[0];

/**
 * Renders the sign-in prompt that sending opens while the visitor may not chat
 * (`openLoginPrompt`). Closing it without signing in drops the pending message
 * (`pending-send.ts`) so it is not sent by surprise on a later sign-in; the
 * draft itself stays in the composer. A successful sign-in closes it too, and
 * then the pending message is kept for the composer to send.
 *
 * Following one of its links to another page (forgot password, magic link,
 * email code) closes it without dropping the pending message: those flows come
 * back to the chat it was opened on (`openedFrom`), which then sends it.
 */
const LoginPromptHost: FC = () => {
    const isOpen = useLoginPromptStore((state) => state.isOpen);
    const openedFrom = useLoginPromptStore((state) => state.openedFrom);
    const setOpen = useLoginPromptStore((state) => state.setOpen);
    const pathname = useLocation({ select: (location) => location.pathname });

    useEffect(() => {
        if (isOpen && openedFrom !== undefined && pathname !== pathOf(openedFrom)) {
            // Left for another page: not a dismissal, so the pending message stays.
            setOpen(false);
        }
    }, [isOpen, openedFrom, pathname, setOpen]);
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
            <LoginModal onOpenChange={handleOpenChange} open={isOpen} redirectTo={openedFrom} />
        </Suspense>
    );
};

export default LoginPromptHost;
