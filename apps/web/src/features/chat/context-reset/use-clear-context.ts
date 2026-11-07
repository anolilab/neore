"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { getValidThreadId } from "@/features/chat/core/utils/thread-id";
import { useLunoraActionOptions } from "@/lib/lunora/crpc";

import { clearRefusalOf } from "./context-reset-logic";

/**
 * Threads with a clear out in this tab. A second Enter, or the menu, while one is out sends nothing: each call has its own
 * id, so the server could not tell the two apart and would write two dividers. The first removes the command when it lands.
 */
const clearing = new Set<string>();

/**
 * Starts a fresh model context in the thread (`/clear`): the transcript stays, and nothing before the new divider is sent.
 * One implementation for `/clear` in the composer and in the slash menu.
 */
/** Resolves to whether the context was cleared, so a caller keeps the typed command when it was not. */
const useClearContext = (threadId: string | undefined): { clear: () => Promise<boolean>; isClearing: boolean } => {
    const { t } = useLingui();
    // Offline, the default network mode would pause the call and run it on reconnect, long after the chat moved on.
    const { isPending, mutateAsync, variables } = useMutation({
        ...useLunoraActionOptions(api.chat.context_reset.clearContext),
        networkMode: "always",
        retry: 0,
    });

    const clear = useCallback(async () => {
        const validThreadId = getValidThreadId(threadId);

        if (!validThreadId) {
            toast.info(t`Send a message first. There is no context to clear yet.`);

            return false;
        }

        if (clearing.has(validThreadId)) {
            return false;
        }

        clearing.add(validThreadId);

        try {
            // One id per click: a coding agent's session is keyed on it, so a repeated delivery cannot start a second one.
            await mutateAsync({ clientId: crypto.randomUUID(), threadId: validThreadId as Id<"threads"> });
            clearing.delete(validThreadId);

            return true;
        } catch (error) {
            clearing.delete(validThreadId);

            const refusal = clearRefusalOf(error);

            // This click's clear was made already, by an earlier delivery of the same request.
            if (refusal === "already_made") {
                return true;
            }

            // The server refuses on purpose for these: retrying would not help, so the toast says why.
            const messages = {
                agent_starting: t`Wait for the agent to be ready, then try again.`,
                busy: t`Wait for the reply to finish, then try again.`,
                failed: t`Could not start a new context. Try again.`,
                not_owner: t`Only the owner of a chat can start a new context.`,
                rate_limited: t`Too many new contexts in a short while. Try again in a minute.`,
                summarising: t`The conversation is being condensed. Try again in a moment.`,
                unavailable: t`This chat cannot start a new context.`,
            };

            toast.error(messages[refusal]);

            return false;
        }
    }, [mutateAsync, t, threadId]);

    return { clear, isClearing: isPending && variables?.threadId === threadId };
};

export default useClearContext;
