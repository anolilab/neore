import { useLingui } from "@lingui/react/macro";
import { CircleAlert, MessageCircleQuestion, ShieldQuestion } from "lucide-react";
import type { FC } from "react";
import { useEffect, useState } from "react";

import { claimBlinkWindow } from "./lib/needs-you-blink";
import { useStatusBeat } from "./status-beat";

export type ThreadStatus = "approval" | "error" | "question" | "running";

const DOT_CLASSES = [
    'opacity-40 [[data-status-beat="0"]_&]:opacity-100 [[data-status-beat="1"]_&]:opacity-60 [[data-status-beat="2"]_&]:opacity-40',
    'opacity-40 [[data-status-beat="0"]_&]:opacity-40 [[data-status-beat="1"]_&]:opacity-100 [[data-status-beat="2"]_&]:opacity-60',
    'opacity-40 [[data-status-beat="0"]_&]:opacity-60 [[data-status-beat="1"]_&]:opacity-40 [[data-status-beat="2"]_&]:opacity-100',
] as const;

const DOT_CENTERS = [2.5, 8, 13.5] as const;

/** Approvals dim on odd ticks and questions on even ones, so a list holding both never flashes in unison. */
const NEEDS_YOU_BLINK = {
    approval: '[[data-status-tick="1"]_&]:opacity-45',
    question: '[[data-status-tick="0"]_&]:opacity-45',
} as const;

/** Amber that holds 3:1 (icon) and 4.5:1 (text) on the light and the dark sidebar surfaces. */
export const NEEDS_YOU_TEXT_CLASS = "text-amber-800 dark:text-amber-400";

const RunningDots: FC = () => {
    useStatusBeat(true);

    return (
        // With no beat attribute (reduced motion, clock stopped) the :not rule keeps every dot fully visible.
        <svg
            aria-hidden="true"
            className="text-ring dark:text-primary h-3 w-3 shrink-0 [:root:not([data-status-beat])_&_circle]:opacity-100"
            fill="currentColor"
            viewBox="0 0 16 16"
        >
            {DOT_CENTERS.map((cx, index) => (
                <circle className={DOT_CLASSES[index]} cx={cx} cy={8} key={cx} r={2} />
            ))}
        </svg>
    );
};

/** Blinks for a few seconds after the state first appears for the thread, then stays static: the class is dropped, not just the clock. */
const NeedsYouIcon: FC<{ kind: "approval" | "question"; threadId: string }> = ({ kind, threadId }) => {
    const [remainingMs] = useState(() => claimBlinkWindow(threadId, kind, Date.now()));
    const [blinking, setBlinking] = useState(remainingMs > 0);

    useStatusBeat(blinking);

    useEffect(() => {
        if (remainingMs <= 0) {
            return undefined;
        }

        const timer = setTimeout(setBlinking, remainingMs, false);

        return () => clearTimeout(timer);
    }, [remainingMs]);

    const Icon = kind === "approval" ? ShieldQuestion : MessageCircleQuestion;

    // The row prints the visible word next to the title, so the icon itself stays out of the accessibility tree.
    return <Icon aria-hidden="true" className={`${NEEDS_YOU_TEXT_CLASS} h-3.5 w-3.5 shrink-0 ${blinking ? NEEDS_YOU_BLINK[kind] : ""}`} />;
};

const ThreadStatusIcon: FC<{ status: ThreadStatus; threadId: string }> = ({ status, threadId }) => {
    const { t } = useLingui();

    if (status === "approval" || status === "question") {
        return <NeedsYouIcon key={`${threadId}:${status}`} kind={status} threadId={threadId} />;
    }

    if (status === "running") {
        return (
            <>
                <RunningDots />
                <span className="sr-only">{t`Streaming`}</span>
            </>
        );
    }

    return (
        <>
            <CircleAlert aria-hidden="true" className="text-destructive h-3 w-3 shrink-0" />
            <span className="sr-only">{t`Failed`}</span>
        </>
    );
};

export default ThreadStatusIcon;
