"use client";

/**
 * The action bar of "Select" mode: how many messages are picked (announced
 * politely), "Forward", and "Cancel". Escape leaves select mode too.
 *
 * Renders nothing — and subscribes to no message list — outside select mode.
 */
import { Plural, useLingui } from "@lingui/react/macro";
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { Button } from "@neore/ui/components/button";
import { ForwardIcon, XIcon } from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense, useEffect, useState } from "react";

import { useChatMessages } from "@/features/chat/core/context/chat-context";

import type { ForwardableMessage } from "./build-forward-text";
import { MAX_FORWARD_MESSAGES, selectIsSelectMode, selectSelectedCount, useForwardSelectionStore } from "./forward-selection-store";

const LazyForwardDialog = lazy(() => import("./forward-dialog"));

const ActiveBar: FC = () => {
    const { t } = useLingui();
    const { messages } = useChatMessages();
    const count = useForwardSelectionStore(selectSelectedCount);
    const clear = useForwardSelectionStore((state) => state.clear);
    const [forwarded, setForwarded] = useState<ForwardableMessage[] | null>(null);

    useEffect(() => {
        if (forwarded) {
            // The dialog owns Escape while it is open.
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
                clear();
            }
        };

        document.addEventListener("keydown", onKeyDown);

        return () => document.removeEventListener("keydown", onKeyDown);
    }, [clear, forwarded]);

    const openForward = () => {
        const { selected } = useForwardSelectionStore.getState();
        // Thread order, not pick order: the new chat reads like the old one.
        const picked = messages
            .filter((message) => Object.hasOwn(selected, message.id))
            .map((message) => {
                return {
                    author: message.role === "user" ? t`You` : (message.agentName ?? t`Assistant`),
                    text: getVisibleUserText(message),
                };
            });

        setForwarded(picked);
    };

    return (
        <>
            <section
                aria-label={t`Message selection`}
                className="bg-background mb-3 flex w-full flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-sm shadow-sm"
            >
                <span aria-live="polite" className="min-w-0 flex-1" role="status">
                    <Plural one="# message selected" other="# messages selected" value={count} />
                    {count >= MAX_FORWARD_MESSAGES && <span className="text-muted-foreground"> {t`(maximum reached)`}</span>}
                </span>
                <Button disabled={count === 0} onClick={openForward} size="sm" type="button">
                    <ForwardIcon aria-hidden="true" className="size-4" />
                    {t`Forward`}
                </Button>
                <Button onClick={clear} size="sm" type="button" variant="ghost">
                    <XIcon aria-hidden="true" className="size-4" />
                    {t`Cancel`}
                </Button>
            </section>
            {forwarded && (
                <Suspense fallback={null}>
                    <LazyForwardDialog
                        messages={forwarded}
                        onDone={() => {
                            setForwarded(null);
                            clear();
                        }}
                        onOpenChange={(open) => {
                            if (!open) {
                                setForwarded(null);
                            }
                        }}
                    />
                </Suspense>
            )}
        </>
    );
};

const ForwardSelectionBar: FC<{ threadId: string | undefined }> = ({ threadId }) => {
    const isSelectMode = useForwardSelectionStore(selectIsSelectMode(threadId));

    // Leaving the thread ends select mode on it.
    useEffect(
        () => () => {
            const state = useForwardSelectionStore.getState();

            if (state.threadId === threadId) {
                state.clear();
            }
        },
        [threadId],
    );

    return isSelectMode ? <ActiveBar /> : null;
};

export default ForwardSelectionBar;
