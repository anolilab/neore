"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { Link } from "@tanstack/react-router";
import {
    AlertCircle,
    Bell,
    Bot,
    CheckCircle2,
    FileDown,
    FlaskConical,
    HelpCircle,
    Import,
    ListChecks,
    ShieldQuestion,
    Sparkles,
    Workflow,
    Zap,
} from "lucide-react";
import type { ComponentType, FC, ReactNode } from "react";

import type { NotificationType } from "../lib/notification-labels";
import useNotificationHeadline from "../lib/notification-labels";
import { formatRelativeTime } from "../lib/relative-time";

export interface NotificationItem {
    _id: string;
    body?: string;
    createdAt: number;
    link?: string;
    outcome?: "failure" | "success";
    read: boolean;
    title: string;
    type: NotificationType;
}

const TYPE_ICONS: Record<NotificationType, ComponentType<{ className?: string }>> = {
    ask_user: HelpCircle,
    chat_import: Import,
    coding_agent: Bot,
    daily_brief: Sparkles,
    data_export: FileDown,
    eval: FlaskConical,
    sub_agent: Workflow,
    task: ListChecks,
    tool_approval: ShieldQuestion,
    trigger: Zap,
};

const OUTCOME_ICONS: Record<"failure" | "success", ComponentType<{ className?: string }>> = {
    failure: AlertCircle,
    success: CheckCircle2,
};

interface NotificationListProps {
    emptyLabel?: ReactNode;
    items: ReadonlyArray<NotificationItem>;
    /** Called when an item is opened (its link followed, or clicked with no link). */
    onOpen: (item: NotificationItem) => void;
}

/**
 * Notifications as a list of links. Each row is ONE interactive element (the
 * link, or a button when there is nowhere to go), so keyboard and screen-reader
 * users get one stop per notification, named by its headline and subject.
 */
const NotificationList: FC<NotificationListProps> = ({ emptyLabel, items, onOpen }) => {
    const { i18n, t } = useLingui();
    const headline = useNotificationHeadline();

    if (items.length === 0) {
        return (
            <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-8 text-center text-sm">
                <Bell aria-hidden="true" className="size-6 opacity-60" />
                <p>{emptyLabel ?? t`You're all caught up.`}</p>
            </div>
        );
    }

    return (
        <ul className="divide-border divide-y">
            {items.map((item) => {
                const Icon = TYPE_ICONS[item.type] ?? Bell;
                const OutcomeIcon = item.outcome === undefined ? undefined : OUTCOME_ICONS[item.outcome];
                const time = formatRelativeTime(item.createdAt, i18n.locale);
                const content = (
                    <>
                        <span className="relative mt-0.5 shrink-0">
                            <Icon aria-hidden="true" className="text-muted-foreground size-4" />
                            {OutcomeIcon && (
                                <OutcomeIcon
                                    aria-hidden="true"
                                    className={cn(
                                        "bg-background absolute -right-1.5 -bottom-1.5 size-3 rounded-full",
                                        item.outcome === "failure" ? "text-destructive" : "text-emerald-600 dark:text-emerald-400",
                                    )}
                                />
                            )}
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className={cn("block text-sm", item.read ? "text-muted-foreground" : "text-foreground font-medium")}>{headline(item)}</span>
                            <span className="text-muted-foreground block truncate text-xs">{item.title}</span>
                            {item.body && <span className="text-muted-foreground mt-0.5 line-clamp-3 block text-xs whitespace-pre-line">{item.body}</span>}
                            <span className="text-muted-foreground/80 mt-0.5 block text-[11px]">
                                <time dateTime={new Date(item.createdAt).toISOString()}>{time}</time>
                                {!item.read && <span className="sr-only">{t`, unread`}</span>}
                            </span>
                        </span>
                        {!item.read && <span aria-hidden="true" className="bg-primary mt-1.5 size-2 shrink-0 rounded-full" />}
                    </>
                );
                const rowClass = "hover:bg-accent focus-visible:bg-accent flex w-full items-start gap-3 px-3 py-2.5 text-left outline-none transition-colors";

                return (
                    <li key={item._id}>
                        {item.link ? (
                            <Link className={rowClass} onClick={() => onOpen(item)} to={item.link as never}>
                                {content}
                            </Link>
                        ) : (
                            <button className={rowClass} onClick={() => onOpen(item)} type="button">
                                {content}
                            </button>
                        )}
                    </li>
                );
            })}
        </ul>
    );
};

export default NotificationList;
