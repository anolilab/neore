"use client";

/**
 * SharedThreadPage — the anonymous, read-only view behind `/thread/$token`.
 *
 * Deliberately outside the `(chat)` layout: that layout mints a guest session
 * for unauthenticated visitors and mounts the composer, sidebar and chat
 * context, none of which a read-only viewer should get. Messages are drawn by
 * the context-free chat-ui renderer, with no action callbacks, so nothing on the
 * page can write.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import MessageItem from "@neore/chat-ui/chat/message-item";
import { Badge } from "@neore/ui/components/badge";
import { buttonVariants } from "@neore/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@neore/ui/components/empty";
import cn from "@neore/ui/utils/cn";
import { Link } from "@tanstack/react-router";
import { Eye, LinkIcon, MessageSquarePlus, Paperclip, Wrench } from "lucide-react";
import type { FC } from "react";
import { useMemo } from "react";

import { SpeakerChip } from "@/features/chat/group/speaker-label";
import env from "@/lib/env";

import type { PublicThread } from "./public-thread-message";
import { formatToolName, toPublicThreadRenderable } from "./public-thread-message";

export type SharedThreadStatus = "error" | "ok" | "unavailable";

interface SharedThreadPageProps {
    status: SharedThreadStatus;
    thread: PublicThread | null;
}

const StartChatLink: FC<{ className?: string }> = ({ className }) => (
    <Link className={cn(buttonVariants({ size: "sm" }), className)} to="/chat">
        <MessageSquarePlus aria-hidden="true" className="size-4" />
        <Trans>Start your own chat</Trans>
    </Link>
);

const Header: FC = () => {
    const appTitle = env.VITE_APP_TITLE ?? "Neore Chat";

    return (
        <header className="bg-background/90 sticky top-0 z-10 border-b backdrop-blur">
            <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
                <Link className="text-sm font-semibold" to="/">
                    {appTitle}
                </Link>
                <StartChatLink />
            </div>
        </header>
    );
};

const Unavailable: FC<{ status: Exclude<SharedThreadStatus, "ok"> }> = ({ status }) => (
    <Empty className="py-24">
        <EmptyHeader>
            <EmptyMedia variant="icon">
                <LinkIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
                <h1>{status === "error" ? <Trans>This conversation could not be loaded</Trans> : <Trans>This conversation is not available</Trans>}</h1>
            </EmptyTitle>
            <EmptyDescription>
                {status === "error" ? (
                    <Trans>Something went wrong on our side. Please try again in a moment.</Trans>
                ) : (
                    <Trans>The link may be wrong, or its owner has made the conversation private or deleted it.</Trans>
                )}
            </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
            <StartChatLink />
        </EmptyContent>
    </Empty>
);

const PlaceholderChips: FC<{ attachments: (string | undefined)[]; tools: string[] }> = ({ attachments, tools }) => {
    const { t } = useLingui();

    if (attachments.length === 0 && tools.length === 0) {
        return null;
    }

    return (
        <ul className="flex flex-wrap gap-1.5">
            {tools.map((tool, index) => (
                <li key={`tool-${String(index)}`}>
                    <Badge variant="outline">
                        <Wrench aria-hidden="true" />
                        {t`Used ${formatToolName(tool)}`}
                    </Badge>
                </li>
            ))}
            {attachments.map((mediaType, index) => (
                <li key={`attachment-${String(index)}`}>
                    <Badge variant="outline">
                        <Paperclip aria-hidden="true" />
                        {mediaType?.startsWith("image/") ? t`Image attachment (hidden)` : t`Attachment (hidden)`}
                    </Badge>
                </li>
            ))}
        </ul>
    );
};

const SharedThread: FC<{ thread: PublicThread }> = ({ thread }) => {
    const { i18n, t } = useLingui();
    const renderables = useMemo(() => thread.messages.map((message) => toPublicThreadRenderable(message)), [thread.messages]);
    const createdAt = new Date(thread.createdAt);

    return (
        <>
            <div className="flex flex-col gap-3 border-b pb-6">
                <Badge className="w-fit" variant="secondary">
                    <Eye aria-hidden="true" />
                    <Trans>Read-only shared conversation</Trans>
                </Badge>
                <h1 className="text-2xl font-semibold tracking-tight text-balance">{thread.title ?? t`Shared conversation`}</h1>
                <p className="text-muted-foreground text-sm">
                    <Trans>
                        Started{" "}
                        <time dateTime={createdAt.toISOString()} suppressHydrationWarning>
                            {createdAt.toLocaleDateString(i18n.locale, { dateStyle: "medium" })}
                        </time>
                        . Tool details and attachments are hidden on shared conversations.
                    </Trans>
                </p>
            </div>

            {thread.truncated && (
                <p className="text-muted-foreground bg-muted rounded-md px-3 py-2 text-sm">
                    <Trans>This conversation is long, so only its most recent messages are shown.</Trans>
                </p>
            )}

            {renderables.length === 0 ? (
                <p className="text-muted-foreground py-12 text-center text-sm">
                    <Trans>This conversation has no messages yet.</Trans>
                </p>
            ) : (
                <ol aria-label={t`Messages`} className="flex flex-col gap-6">
                    {renderables.map(({ attachments, message, speakerName, tools }) => (
                        <li className={cn("flex flex-col gap-2", message.role === "user" ? "items-end" : "items-start")} key={message.id}>
                            <span className="sr-only">{message.role === "user" ? t`User said:` : t`Assistant replied:`}</span>
                            {speakerName && <SpeakerChip name={speakerName} />}
                            <PlaceholderChips attachments={attachments} tools={tools} />
                            {message.parts.length > 0 && (
                                <div className="w-full">
                                    <MessageItem message={message} />
                                </div>
                            )}
                        </li>
                    ))}
                </ol>
            )}

            <aside aria-labelledby="shared-thread-cta" className="bg-muted/50 flex flex-col items-center gap-3 rounded-lg border px-6 py-8 text-center">
                <h2 className="text-base font-semibold" id="shared-thread-cta">
                    <Trans>Want to continue from here?</Trans>
                </h2>
                <p className="text-muted-foreground max-w-md text-sm">
                    <Trans>Start a conversation of your own with the latest AI models.</Trans>
                </p>
                <StartChatLink />
            </aside>
        </>
    );
};

const SharedThreadPage: FC<SharedThreadPageProps> = ({ status, thread }) => (
    <div className="bg-background text-foreground min-h-screen">
        <Header />
        <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8">
            {status === "ok" && thread ? <SharedThread thread={thread} /> : <Unavailable status={status === "error" ? "error" : "unavailable"} />}
        </main>
    </div>
);

export default SharedThreadPage;
