"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@neore/ui/components/popover";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import cn from "@neore/ui/utils/cn";
import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";

import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { notifyNative } from "@/lib/native/bridge";

import useNotificationInbox from "../hooks/use-notification-inbox";
import { findNewArrivals } from "../lib/new-arrivals";
import useNotificationHeadline from "../lib/notification-labels";
import NotificationList from "./notification-list";

/** Items the popover lists; the full history is on the home page. */
const POPOVER_ITEMS = 15;

/**
 * The bell in the app sidebar: unread badge, a popover inbox, and the
 * announcements for new arrivals — a polite live region for screen readers,
 * plus a system notification from the native shell (a no-op in the browser).
 *
 * The inbox query is live, so it costs a subscription; it waits until after
 * first paint, like the sidebar's admin link.
 */
const NotificationBell: FC<{ className?: string }> = ({ className }) => {
    const { t } = useLingui();
    const headline = useNotificationHeadline();
    const afterFirstPaint = useAfterFirstPaint();
    const { items, loaded, markAllRead, markAllReadPending, markRead, unreadCount } = useNotificationInbox({ enabled: afterFirstPaint });
    const [open, setOpen] = useState(false);
    const [announcement, setAnnouncement] = useState("");
    const seen = useRef<Set<string> | undefined>(undefined);

    useEffect(() => {
        if (!loaded) {
            return;
        }

        const arrivals = findNewArrivals(seen.current, items);

        seen.current = new Set(items.map((item) => item._id));

        const [latest] = arrivals;

        if (!latest) {
            return;
        }

        const text = arrivals.length === 1 ? `${headline(latest)}: ${latest.title}` : t`${arrivals.length} new notifications`;

        setAnnouncement(text);
        void notifyNative({ body: latest.title, title: headline(latest) });
    }, [headline, items, loaded, t]);

    const badge = unreadCount > 99 ? "99+" : String(unreadCount);
    const label = unreadCount > 0 ? t`Notifications, ${badge} unread` : t`Notifications`;

    return (
        <>
            <Popover onOpenChange={setOpen} open={open}>
                <PopoverTrigger
                    render={
                        <button
                            aria-label={label}
                            className={cn(
                                "group text-brand-black dark:text-brand-white hover:bg-sidebar-accent/50 relative flex size-10 items-center justify-center rounded-md transition-colors duration-150",
                                open && "bg-sidebar-accent text-sidebar-accent-foreground",
                                className,
                            )}
                            type="button"
                        />
                    }
                >
                    <Bell aria-hidden="true" className="size-5" strokeWidth={1.5} />
                    {unreadCount > 0 && (
                        <span
                            aria-hidden="true"
                            className="bg-destructive text-destructive-foreground absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums"
                        >
                            {badge}
                        </span>
                    )}
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[22rem] p-0" side="right" sideOffset={8}>
                    <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                        <PopoverTitle className="text-sm font-semibold">{t`Notifications`}</PopoverTitle>
                        <Button
                            disabled={unreadCount === 0 || markAllReadPending}
                            onClick={() => {
                                // A failed batch leaves the rest unread, which the live inbox shows.
                                markAllRead().catch(() => {});
                            }}
                            size="sm"
                            variant="ghost"
                        >
                            {t`Mark all read`}
                        </Button>
                    </div>
                    <ScrollArea className="max-h-[26rem]">
                        <NotificationList
                            items={items.slice(0, POPOVER_ITEMS)}
                            onOpen={(item) => {
                                if (!item.read) {
                                    markRead(item._id);
                                }

                                setOpen(false);
                            }}
                        />
                    </ScrollArea>
                    <div className="border-t px-3 py-2 text-right">
                        <Link className="text-primary text-xs font-medium hover:underline" onClick={() => setOpen(false)} to="/dashboard">
                            {t`Open home`}
                        </Link>
                    </div>
                </PopoverContent>
            </Popover>
            <span aria-live="polite" className="sr-only" role="status">
                {announcement}
            </span>
        </>
    );
};

export default NotificationBell;
