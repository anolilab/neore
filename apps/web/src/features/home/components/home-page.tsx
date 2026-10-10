"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUp, Bot, ListChecks, MessageSquare, ShieldQuestion, Sparkles, Workflow } from "lucide-react";
import type { FC, FormEvent, ReactNode } from "react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { LANDING_MESSAGE_KEY } from "@/features/marketing/stores/landing-store";
import NotificationList from "@/features/notifications/components/notification-list";
import useNotificationInbox from "@/features/notifications/hooks/use-notification-inbox";
import { formatRelativeTime } from "@/features/notifications/lib/relative-time";
import { useCRPC } from "@/lib/lunora/crpc";

const Section: FC<{ action?: ReactNode; children: ReactNode; count?: number; icon: ReactNode; title: string }> = ({ action, children, count, icon, title }) => {
    const headingId = useId();

    return (
        <section aria-labelledby={headingId} className="bg-card text-card-foreground ring-foreground/10 flex flex-col gap-2 rounded-lg py-4 ring-1">
            <div className="flex items-center justify-between gap-2 px-4">
                <h2 className="flex items-center gap-2 text-base font-medium" id={headingId}>
                    {icon}
                    {title}
                    {count !== undefined && count > 0 && (
                        <Badge className="tabular-nums" variant="secondary">
                            {count}
                        </Badge>
                    )}
                </h2>
                {action}
            </div>
            <div>{children}</div>
        </section>
    );
};

const Row: FC<{ children: ReactNode; meta?: ReactNode; to: string }> = ({ children, meta, to }) => (
    <li>
        <Link className="hover:bg-accent focus-visible:bg-accent flex items-center justify-between gap-3 px-4 py-2 text-sm outline-none" to={to as never}>
            <span className="min-w-0 flex-1 truncate">{children}</span>
            {meta && <span className="text-muted-foreground shrink-0 text-xs">{meta}</span>}
        </Link>
    </li>
);

const Empty: FC<{ children: ReactNode }> = ({ children }) => <p className="text-muted-foreground px-4 py-2 text-sm">{children}</p>;

/** Starts a chat through the same hand-off the landing page and onboarding use (`LANDING_MESSAGE_KEY`). */
const HomeComposer: FC = () => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const inputId = useId();
    const [prompt, setPrompt] = useState("");

    const submit = (event?: FormEvent) => {
        event?.preventDefault();

        const text = prompt.trim();

        if (!text) {
            return;
        }

        try {
            sessionStorage.setItem(LANDING_MESSAGE_KEY, text);
        } catch {
            // No sessionStorage: the chat opens empty rather than failing.
        }

        void navigate({ search: { initialMessage: true }, to: "/chat" });
    };

    return (
        <form className="bg-card relative rounded-xl border p-2 shadow-sm" onSubmit={submit}>
            <label className="sr-only" htmlFor={inputId}>
                {t`Start a new chat`}
            </label>
            <Textarea
                className="max-h-48 min-h-20 resize-none border-0 pr-12 shadow-none focus-visible:ring-0"
                id={inputId}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        submit(event);
                    }
                }}
                placeholder={t`Ask anything to start a new chat…`}
                value={prompt}
            />
            <Button aria-label={t`Start chat`} className="absolute right-3 bottom-3" disabled={!prompt.trim()} size="icon-sm" type="submit">
                <ArrowUp aria-hidden="true" className="size-4" />
            </Button>
        </form>
    );
};

/**
 * `/dashboard`: the signed-in home. One live query (`home_overview.getHomeOverview`)
 * drives every section, plus the shared notification inbox for read state.
 */
const HomePage: FC = () => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const { data: overview, isError, isFetching, isLoading, refetch } = useQuery(crpc.home.overview.getHomeOverview.queryOptions({}));
    const { markRead } = useNotificationInbox({ enabled: false });
    const enableBrief = useMutation(crpc.notifications.daily_brief.setDailyBriefEnabled.mutationOptions());
    const ago = (timestamp: number) => formatRelativeTime(timestamp, i18n.locale);

    const needsYouCount = (overview?.approvals.length ?? 0) + (overview?.reviews.length ?? 0);
    const runningCount = (overview?.runningTasks.length ?? 0) + (overview?.codingAgents.length ?? 0) + (overview?.subAgents.length ?? 0);

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 pb-10">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold">{t`Home`}</h1>
                <p className="text-muted-foreground text-sm">{t`What needs you, what's running, and where you left off.`}</p>
            </header>

            <HomeComposer />

            {isLoading && (
                <p className="text-muted-foreground text-sm" role="status">
                    {t`Loading your overview…`}
                </p>
            )}

            {isError && !overview && (
                <div className="border-destructive/40 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4" role="alert">
                    <p className="text-sm">{t`Your overview could not be loaded.`}</p>
                    <Button
                        disabled={isFetching}
                        onClick={() => {
                            // The query's own `isError` reports a failed retry.
                            refetch().catch(() => undefined);
                        }}
                        size="sm"
                        variant="outline"
                    >
                        {isFetching ? t`Retrying…` : t`Try again`}
                    </Button>
                </div>
            )}

            {overview && (
                <div className="grid gap-4 md:grid-cols-2">
                    <Section count={needsYouCount} icon={<ShieldQuestion aria-hidden="true" className="size-4" />} title={t`Needs you`}>
                        {needsYouCount === 0 ? (
                            <Empty>{t`Nothing is waiting on you.`}</Empty>
                        ) : (
                            <ul>
                                {overview.approvals.map((approval) => (
                                    <Row key={approval.approvalId} meta={ago(approval.createdAt)} to={`/chat/${approval.threadId}`}>
                                        {approval.threadTitle ? t`Waiting for your answer in ${approval.threadTitle}` : t`A chat is waiting for your answer`}
                                    </Row>
                                ))}
                                {overview.reviews.map((task) => (
                                    <Row key={task._id} meta={ago(task.updatedAt)} to="/tasks">
                                        {t`Review task: ${task.title}`}
                                    </Row>
                                ))}
                            </ul>
                        )}
                    </Section>

                    <Section count={runningCount} icon={<Bot aria-hidden="true" className="size-4" />} title={t`Running`}>
                        {runningCount === 0 ? (
                            <Empty>{t`Nothing is running right now.`}</Empty>
                        ) : (
                            <ul>
                                {overview.runningTasks.map((task) => (
                                    <Row key={task._id} meta={task.status === "queued" ? t`Queued` : t`Running`} to="/tasks">
                                        <ListChecks aria-hidden="true" className="mr-2 inline size-3.5" />
                                        {task.title}
                                    </Row>
                                ))}
                                {overview.codingAgents.map((run) => (
                                    <Row
                                        key={run._id}
                                        meta={run.status === "queued" ? t`Queued` : t`Running`}
                                        to={run.threadId ? `/chat/${run.threadId}` : "/tasks"}
                                    >
                                        <Bot aria-hidden="true" className="mr-2 inline size-3.5" />
                                        {`${run.repo} · ${run.prompt}`}
                                    </Row>
                                ))}
                                {overview.subAgents.map((run) => (
                                    <Row key={run._id} meta={run.status === "queued" ? t`Queued` : t`Running`} to={`/chat/${run.parentThreadId}`}>
                                        <Workflow aria-hidden="true" className="mr-2 inline size-3.5" />
                                        {run.task}
                                    </Row>
                                ))}
                            </ul>
                        )}
                    </Section>

                    <Section
                        action={
                            overview.unreadCount > 0 ? (
                                <span className="text-muted-foreground text-xs tabular-nums">{t`${overview.unreadCount} unread`}</span>
                            ) : undefined
                        }
                        icon={<Sparkles aria-hidden="true" className="size-4" />}
                        title={t`Notifications`}
                    >
                        <NotificationList
                            emptyLabel={t`No unread notifications.`}
                            items={overview.notifications}
                            onOpen={(item) => {
                                if (!item.read) {
                                    markRead(item._id);
                                }
                            }}
                        />
                        {!overview.dailyBriefEnabled && (
                            <div className="flex items-center justify-between gap-3 border-t px-4 pt-3 text-sm">
                                <span className="text-muted-foreground">{t`Get a short summary here every morning.`}</span>
                                <Button
                                    disabled={enableBrief.isPending}
                                    onClick={() =>
                                        enableBrief.mutate(
                                            { enabled: true },
                                            {
                                                onError: () => toast.error(t`Could not turn on the Daily Brief.`),
                                                onSuccess: () => toast.success(t`Daily Brief turned on`),
                                            },
                                        )
                                    }
                                    size="sm"
                                    variant="outline"
                                >
                                    {t`Turn on Daily Brief`}
                                </Button>
                            </div>
                        )}
                    </Section>

                    <Section
                        action={
                            <Link className="text-primary text-xs font-medium hover:underline" to="/chat">
                                {t`All chats`}
                            </Link>
                        }
                        icon={<MessageSquare aria-hidden="true" className="size-4" />}
                        title={t`Recent chats`}
                    >
                        {overview.recentThreads.length === 0 ? (
                            <Empty>{t`No chats yet. Start one above.`}</Empty>
                        ) : (
                            <ul>
                                {overview.recentThreads.map((thread) => (
                                    <Row key={thread._id} meta={ago(thread.updatedAt)} to={`/chat/${thread._id}`}>
                                        {thread.title ?? t`Untitled chat`}
                                    </Row>
                                ))}
                            </ul>
                        )}
                    </Section>
                </div>
            )}
        </div>
    );
};

export default HomePage;
