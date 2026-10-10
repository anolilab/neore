/**
 * BrowserPanel — Live browser task panel for the chat UI.
 *
 * Shows the current browser session status, latest screenshot, action log,
 * and provides controls to terminate the session.
 */
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { AlertCircle, CheckCircle2, Clock, ExternalLink, Globe, Loader2, MousePointer2, ScrollText, Square, Type, X } from "lucide-react";
import type { FC } from "react";
import { memo, useState } from "react";

import cn from "../utils/cn";

// ── Types ───────────────────────────────────────────────────────────────

export interface BrowserSession {
    _id: string;
    currentUrl?: string;
    errorMessage?: string;
    lastActivityAt: number;
    startedAt: number;
    status: string;
    threadId: string;
}

export interface BrowserAction {
    _id: string;
    action: string;
    durationMs?: number;
    errorMessage?: string;
    success: boolean;
    target?: string;
    timestamp: number;
    value?: string;
}

interface BrowserPanelProps {
    actions: BrowserAction[];
    className?: string;
    latestScreenshot?: string;
    onTerminate?: () => void;
    session: BrowserSession;
}

// ── Action icon map ─────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, FC<{ className?: string }>> = {
    click: MousePointer2,
    evaluate: ScrollText,
    extract: ScrollText,
    navigate: Globe,
    screenshot: Globe,
    scroll: ScrollText,
    type: Type,
};

const STATUS_COLORS: Record<string, string> = {
    active: "text-green-600 dark:text-green-400",
    failed: "text-red-600 dark:text-red-400",
};

const STATUS_LABELS: Record<string, MessageDescriptor> = {
    active: msg`active`,
    completed: msg`completed`,
    failed: msg`failed`,
};

const getActionIcon = (action: string): FC<{ className?: string }> => ACTION_ICONS[action] ?? Globe;

const truncateUrl = (url: string): string => {
    try {
        const u = new URL(url);
        const path = u.pathname.length > 30 ? `${u.pathname.slice(0, 30)}…` : u.pathname;

        return u.hostname + path;
    } catch {
        return url.length > 40 ? `${url.slice(0, 40)}…` : url;
    }
};

const truncateSelector = (selector: string): string => (selector.length > 30 ? `${selector.slice(0, 30)}…` : selector);

const formatAction = (i18n: I18n, action: string, target?: string): string => {
    switch (action) {
        case "click": {
            if (!target) {
                return i18n._(msg`Click`);
            }

            const selector = truncateSelector(target);

            return i18n._(msg`Click "${selector}"`);
        }
        case "evaluate": {
            return i18n._(msg`Evaluate JS`);
        }
        case "extract": {
            if (!target) {
                return i18n._(msg`Extract page`);
            }

            const selector = truncateSelector(target);

            return i18n._(msg`Extract "${selector}"`);
        }
        case "navigate": {
            if (!target) {
                return i18n._(msg`Navigate`);
            }

            const url = truncateUrl(target);

            return i18n._(msg`Navigate → ${url}`);
        }
        case "screenshot": {
            return i18n._(msg`Screenshot`);
        }
        case "scroll": {
            return i18n._(msg`Scroll`);
        }
        case "type": {
            if (!target) {
                return i18n._(msg`Type`);
            }

            const selector = truncateSelector(target);

            return i18n._(msg`Type into "${selector}"`);
        }
        default: {
            return action;
        }
    }
};

const formatDuration = (ms?: number): string => {
    if (ms == null) {
        return "";
    }

    if (ms < 1000) {
        return `${ms}ms`;
    }

    return `${(ms / 1000).toFixed(1)}s`;
};

const formatRelativeTime = (i18n: I18n, timestamp: number): string => {
    const diff = Date.now() - timestamp;

    if (diff < 5000) {
        return i18n._(msg`just now`);
    }

    const format = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto", style: "narrow" });

    if (diff < 60_000) {
        return format.format(-Math.floor(diff / 1000), "second");
    }

    if (diff < 3_600_000) {
        return format.format(-Math.floor(diff / 60_000), "minute");
    }

    return format.format(-Math.floor(diff / 3_600_000), "hour");
};

// ── Main component ──────────────────────────────────────────────────────

export const BrowserPanel = memo(({ actions, className, latestScreenshot, onTerminate, session }: BrowserPanelProps) => {
    const { i18n, t } = useLingui();
    const [isExpanded, setIsExpanded] = useState(true);
    const isActive = session.status === "active";
    const statusColor = STATUS_COLORS[session.status] ?? "text-gray-500 dark:text-gray-400";
    const startedAgo = formatRelativeTime(i18n, session.startedAt);
    const lastActivityAgo = formatRelativeTime(i18n, session.lastActivityAt);
    const statusLabel = STATUS_LABELS[session.status];

    return (
        <div
            className={cn(
                "overflow-hidden rounded-lg border",
                isActive
                    ? "border-blue-200 bg-blue-50/50 dark:border-blue-800/50 dark:bg-blue-950/20"
                    : "border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50",
                className,
            )}
        >
            {/* ── Header ─────────────────────────────────────────────── */}
            <div className="flex items-center justify-between px-3 py-2">
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setIsExpanded(!isExpanded)} type="button">
                    <Globe aria-hidden="true" className={cn("size-4 shrink-0", isActive ? "text-blue-500" : "text-gray-400")} />
                    <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{t`Browser Session`}</span>
                    <span className={cn("flex items-center gap-1 text-[11px]", statusColor)}>
                        {isActive && <span className="inline-block size-1.5 animate-pulse rounded-full bg-green-500" />}
                        {statusLabel ? i18n._(statusLabel) : session.status}
                    </span>
                </button>

                <div className="flex items-center gap-1">
                    {session.currentUrl && (
                        <a
                            aria-label={t`Open current URL`}
                            className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            href={session.currentUrl}
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            <ExternalLink aria-hidden="true" className="size-3.5" />
                        </a>
                    )}

                    {isActive && onTerminate && (
                        <button
                            aria-label={t`Terminate browser session`}
                            className={cn(
                                "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium",
                                "text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/40",
                                "focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none",
                                "transition-colors",
                            )}
                            onClick={onTerminate}
                            type="button"
                        >
                            <Square aria-hidden="true" className="size-3" />
                            {t`Stop`}
                        </button>
                    )}

                    <button
                        aria-label={isExpanded ? t`Collapse browser panel` : t`Expand browser panel`}
                        className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                        onClick={() => setIsExpanded(!isExpanded)}
                        type="button"
                    >
                        <X aria-hidden="true" className={cn("size-3.5 transition-transform", !isExpanded && "rotate-45")} />
                    </button>
                </div>
            </div>

            {isExpanded ? (
                <>
                    {/* ── Current URL ─────────────────────────────────── */}
                    {session.currentUrl && (
                        <div className="border-t border-gray-200/60 px-3 py-1.5 dark:border-gray-700/60">
                            <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                                <Globe aria-hidden="true" className="size-3 shrink-0" />
                                <span className="truncate">{session.currentUrl}</span>
                            </div>
                        </div>
                    )}

                    {/* ── Screenshot preview ──────────────────────────── */}
                    {latestScreenshot && (
                        <div className="border-t border-gray-200/60 p-2 dark:border-gray-700/60">
                            <img
                                alt={t`Browser screenshot`}
                                className="w-full rounded-md border border-gray-200 dark:border-gray-700"
                                src={`data:image/png;base64,${latestScreenshot}`}
                            />
                        </div>
                    )}

                    {/* ── Action log ───────────────────────────────────── */}
                    {actions.length > 0 && (
                        <div className="border-t border-gray-200/60 dark:border-gray-700/60">
                            <div className="px-3 py-1.5">
                                <span className="text-[10px] font-semibold text-gray-400 uppercase">
                                    {t`Action Log`} ({actions.length})
                                </span>
                            </div>
                            <ul className="max-h-48 overflow-y-auto px-3 pb-2">
                                {actions.slice(-10).map((action) => {
                                    const Icon = getActionIcon(action.action);

                                    return (
                                        <li className="flex items-start gap-1.5 py-0.5 text-[11px]" key={action._id}>
                                            {action.success ? (
                                                <CheckCircle2 aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-green-500" />
                                            ) : (
                                                <AlertCircle aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-red-500" />
                                            )}
                                            <Icon aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-gray-400" />
                                            <span
                                                className={cn(
                                                    "min-w-0 flex-1 truncate",
                                                    action.success ? "text-gray-600 dark:text-gray-300" : "text-red-600 dark:text-red-400",
                                                )}
                                                title={action.errorMessage ?? undefined}
                                            >
                                                {formatAction(i18n, action.action, action.target)}
                                                {action.errorMessage && ` — ${action.errorMessage}`}
                                            </span>
                                            <span className="shrink-0 text-gray-400">{formatDuration(action.durationMs)}</span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}

                    {/* ── Session timing ───────────────────────────────── */}
                    <div className="flex items-center gap-3 border-t border-gray-200/60 px-3 py-1.5 text-[10px] text-gray-400 dark:border-gray-700/60">
                        <span className="flex items-center gap-1">
                            <Clock aria-hidden="true" className="size-3" />
                            {t`Started ${startedAgo}`}
                        </span>
                        {session.lastActivityAt !== session.startedAt && <span>{t`Last activity ${lastActivityAgo}`}</span>}
                        {session.errorMessage && <span className="text-red-500">{session.errorMessage}</span>}
                    </div>
                </>
            ) : null}
        </div>
    );
});

// ── Loading state ───────────────────────────────────────────────────────

/**
 * Compact inline browser status shown inside tool call results
 * when the browser tool is actively running.
 */
export const BrowserToolStatus = memo(({ action, className, url }: { action: string; className?: string; url?: string }) => {
    const { i18n } = useLingui();

    return (
        <div
            className={cn(
                "flex items-center gap-2.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-800/50 dark:bg-blue-950/30",
                className,
            )}
        >
            <Loader2 aria-hidden="true" className="size-4 animate-spin text-blue-500" />
            <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-blue-700 dark:text-blue-300">{formatAction(i18n, action, url)}</span>
                {url && action === "navigate" && <p className="truncate text-[11px] text-blue-500/80 dark:text-blue-400/60">{url}</p>}
            </div>
        </div>
    );
});
