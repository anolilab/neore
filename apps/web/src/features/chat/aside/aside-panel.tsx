"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { Button } from "@neore/ui/components/button";
import { chatMarkdownComponents } from "@neore/ui/components/chat-markdown-components";
import { Textarea } from "@neore/ui/components/textarea";
import useStreamdownPlugins from "@neore/ui/hooks/use-streamdown-plugins";
import { useMutation } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, MessageSquarePlusIcon, XIcon } from "lucide-react";
import type { FC, FormEvent, KeyboardEvent } from "react";
import { useId, useState } from "react";
import { Streamdown } from "streamdown";

import { useChatIsRunning } from "@/features/chat/core/context/chat-context";
import { useAction, useCRPC } from "@/lib/lunora/crpc";

import type { AsideEntry } from "./aside-store";
import { useAsideStore } from "./aside-store";
import { ASIDE_INPUT_ID } from "./open-aside";

const errorCodeOf = (error: unknown): string | undefined => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };
    const value = data?.code ?? code;

    return typeof value === "string" ? value : undefined;
};

type AsideErrorKind = "added" | "busy" | "credits" | "forbidden" | "locked" | "other" | "quota" | "slow" | "unavailable";

/** What a failed question or add says, from the server's code (`chat/aside.ts`). */
const asideErrorKind = (error: unknown): AsideErrorKind => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };
    const codes = new Set([code, data?.code]);

    if (codes.has("ASIDE_ALREADY_ADDED")) {
        return "added";
    }

    if (codes.has("DAILY_MESSAGE_LIMIT_REACHED")) {
        return "quota";
    }

    if (codes.has("INSUFFICIENT_CREDITS")) {
        return "credits";
    }

    // The per-minute budget or a busy model: not the day's allowance.
    if (codes.has("TOO_MANY_REQUESTS") || codes.has("UPSTREAM_RATE_LIMITED")) {
        return "slow";
    }

    if (codes.has("THREAD_LOCKED")) {
        return "locked";
    }

    if (codes.has("CONFLICT")) {
        return "busy";
    }

    if (codes.has("FORBIDDEN")) {
        return "forbidden";
    }

    return codes.has("BAD_REQUEST") ? "unavailable" : "other";
};

const AnswerText: FC<{ text: string }> = ({ text }) => {
    const plugins = useStreamdownPlugins(text);

    return (
        <Streamdown components={chatMarkdownComponents} plugins={plugins}>
            {text}
        </Streamdown>
    );
};

interface AsideItemProps {
    entry: AsideEntry;
    isRunning: boolean;
    onAdd: (entry: AsideEntry) => void;
    onDismiss: (id: string) => void;
}

const AsideItem: FC<AsideItemProps> = ({ entry, isRunning, onAdd, onDismiss }) => {
    const { t } = useLingui();
    const errors = {
        added: t`This is already in the thread.`,
        busy: t`The reply is still running. Try again when it finishes.`,
        credits: t`There are no credits left to answer this. Add credits and try again.`,
        forbidden: t`You cannot ask a side question in this chat.`,
        locked: t`Unlock this chat to ask a side question.`,
        other: t`Could not answer the question. Try again.`,
        quota: t`You have used today's messages. Try again later.`,
        slow: t`Too many requests right now. Try again in a moment.`,
        unavailable: t`Side questions are not available for this chat, or the question is too long.`,
    };
    const addErrors = {
        added: t`This is already in the thread.`,
        busy: t`The reply is still running. Add it when the reply finishes.`,
        credits: t`This cannot be added to this chat.`,
        forbidden: t`Only the owner of a chat can add to it from here.`,
        locked: t`Unlock this chat to add this to the thread.`,
        other: t`Could not add this to the thread. Try again.`,
        quota: t`You have used today's messages. Try again later.`,
        slow: t`Too many requests right now. Try again in a moment.`,
        unavailable: t`This cannot be added to this chat.`,
    };
    const errorKind = asideErrorKind({ code: entry.errorCode });
    const addErrorKind = asideErrorKind({ code: entry.addErrorCode });

    return (
        <li className="border-sidebar-border bg-sidebar-accent/30 space-y-2 rounded-md border p-3 text-sm">
            <div className="flex items-start gap-2">
                <p className="text-foreground grow font-medium break-words whitespace-pre-line">{entry.question}</p>
                <Button
                    aria-label={
                        entry.status === "pending"
                            ? t`Hide this side question. It is already being answered and still counts as a message.`
                            : t`Dismiss this side question`
                    }
                    className="size-6 shrink-0"
                    onClick={() => onDismiss(entry.id)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                >
                    <XIcon aria-hidden="true" className="size-3.5" />
                </Button>
            </div>
            {entry.status === "pending" && (
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
                    {t`Thinking…`}
                </p>
            )}
            {entry.status === "failed" && (
                <p className="text-destructive text-xs" role="alert">
                    {errors[errorKind]}
                </p>
            )}
            {(entry.status === "answered" || entry.status === "added") && entry.answer !== undefined && (
                <>
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                        <AnswerText text={entry.answer} />
                    </div>
                    {entry.withThread === false && (
                        <p className="text-muted-foreground text-xs">{t`Answered without the conversation: this chat runs on your computer.`}</p>
                    )}
                    {entry.status === "added" ? (
                        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                            <CheckIcon aria-hidden="true" className="size-3.5" />
                            {t`Added to the thread`}
                        </p>
                    ) : (
                        <div className="flex items-center gap-2">
                            <Button
                                className="h-7 gap-1.5 px-2 text-xs"
                                disabled={isRunning || entry.adding === true}
                                onClick={() => onAdd(entry)}
                                size="sm"
                                type="button"
                                variant="outline"
                            >
                                <MessageSquarePlusIcon aria-hidden="true" className="size-3.5" />
                                {entry.adding === true ? t`Adding…` : t`Add to thread`}
                            </Button>
                            {isRunning && <span className="text-muted-foreground text-xs">{t`Available when the reply finishes`}</span>}
                        </div>
                    )}
                    {entry.addErrorCode !== undefined && (
                        <p className="text-destructive text-xs" role="alert">
                            {addErrors[addErrorKind]}
                        </p>
                    )}
                </>
            )}
        </li>
    );
};

/**
 * The side-question panel (right sidebar). The question and the answer live in
 * `useAsideStore` for the session; "Add to thread" is the only thing that
 * writes to the chat, and only once no reply is running.
 */
const AsidePanel: FC<{ threadId?: string }> = ({ threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const askAside = useAction(api.chat.aside.askAside);
    const { mutateAsync: addAside } = useMutation(crpc.chat.aside.addAsideToThread.mutationOptions());
    const unlockProof = useUnlockProof(threadId);
    const isRunning = useChatIsRunning();
    const entries = useAsideStore((state) => (threadId ? state.byThread[threadId] : undefined)) ?? [];
    const add = useAsideStore((state) => state.add);
    const update = useAsideStore((state) => state.update);
    const remove = useAsideStore((state) => state.remove);
    const [question, setQuestion] = useState("");
    // What a screen reader hears: the newest state only, in its own small region, rather than the whole list again.
    const [announcement, setAnnouncement] = useState("");

    if (!threadId || threadId === "default") {
        return (
            <section aria-labelledby={headingId} className="space-y-3 py-4 pr-2 pl-1">
                <h2 className="text-foreground text-base font-semibold" id={headingId}>{t`Side question`}</h2>
                <p className="text-muted-foreground text-sm">{t`Start a conversation to ask a side question.`}</p>
            </section>
        );
    }

    const submit = () => {
        const text = question.trim();

        if (!text) {
            return;
        }

        const id = crypto.randomUUID();

        add(threadId, { id, question: text, status: "pending" });
        setQuestion("");
        setAnnouncement(t`Thinking…`);
        askAside({ entryId: id, question: text, threadId: threadId as Id<"threads">, unlockProof })
            .then(({ answer, token, withThread }) => {
                update(threadId, id, { answer, status: "answered", token, withThread });

                // The answer is one call, not a stream, and stays readable in the list: the region only says it arrived.
                // A question hidden meanwhile is not announced.
                if (useAsideStore.getState().byThread[threadId]?.some((candidate) => candidate.id === id)) {
                    setAnnouncement(t`Answer ready`);
                }

                return undefined;
            })
            .catch((error: unknown) => {
                update(threadId, id, { errorCode: errorCodeOf(error), status: "failed" });
            });
    };

    const handleSubmit = (event: FormEvent) => {
        event.preventDefault();
        submit();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }

        event.preventDefault();
        submit();
    };

    const handleAdd = (entry: AsideEntry) => {
        const current = useAsideStore.getState().byThread[threadId]?.find((candidate) => candidate.id === entry.id);

        if (entry.answer === undefined || entry.token === undefined || current?.adding === true) {
            return;
        }

        update(threadId, entry.id, { adding: true });
        addAside({
            answer: entry.answer,
            entryId: entry.id,
            question: entry.question,
            threadId: threadId as Id<"threads">,
            token: entry.token,
            unlockProof,
        })
            .then(() => {
                update(threadId, entry.id, { addErrorCode: undefined, adding: false, status: "added" });
                setAnnouncement(t`Added to the thread`);

                return undefined;
            })
            .catch((error: unknown) => {
                // A second add of the same question is the first one having landed: it is in the thread.
                if (asideErrorKind(error) === "added") {
                    update(threadId, entry.id, { addErrorCode: undefined, adding: false, status: "added" });

                    return;
                }

                update(threadId, entry.id, { addErrorCode: errorCodeOf(error) ?? "UNKNOWN", adding: false });
            });
    };

    return (
        <section aria-labelledby={headingId} className="space-y-3 py-4 pr-2 pl-1">
            <h2 className="text-foreground text-base font-semibold" id={headingId}>{t`Side question`}</h2>
            <p className="text-muted-foreground text-xs">{t`Ask something without interrupting the reply. The question and the answer stay here unless you add them to the thread.`}</p>
            <form className="space-y-2" onSubmit={handleSubmit}>
                <label className="sr-only" htmlFor={ASIDE_INPUT_ID}>{t`Your side question`}</label>
                <Textarea
                    id={ASIDE_INPUT_ID}
                    maxLength={4000}
                    onChange={(event) => setQuestion(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t`Ask a quick question…`}
                    value={question}
                />
                <Button className="h-8 px-3 text-xs" disabled={!question.trim()} size="sm" type="submit">
                    {t`Ask`}
                </Button>
            </form>
            {/* Polite, so the answer is announced without cutting in. It holds only the newest state: a live role on the list would read the buttons and every earlier answer again on each change. */}
            <p aria-live="polite" className="sr-only" role="status">
                {announcement}
            </p>
            <ul className="space-y-3">
                {entries.map((entry) => (
                    <AsideItem entry={entry} isRunning={isRunning} key={entry.id} onAdd={handleAdd} onDismiss={(id) => remove(threadId, id)} />
                ))}
            </ul>
        </section>
    );
};

export default AsidePanel;
