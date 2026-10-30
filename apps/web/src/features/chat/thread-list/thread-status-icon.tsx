import { useLingui } from "@lingui/react/macro";
import { CircleAlert } from "lucide-react";
import type { FC } from "react";

import { useStatusBeat } from "./status-beat";

export type ThreadStatus = "error" | "running";

const DOT_CLASSES = [
    'opacity-40 [[data-status-beat="0"]_&]:opacity-100 [[data-status-beat="1"]_&]:opacity-60 [[data-status-beat="2"]_&]:opacity-40',
    'opacity-40 [[data-status-beat="0"]_&]:opacity-40 [[data-status-beat="1"]_&]:opacity-100 [[data-status-beat="2"]_&]:opacity-60',
    'opacity-40 [[data-status-beat="0"]_&]:opacity-60 [[data-status-beat="1"]_&]:opacity-40 [[data-status-beat="2"]_&]:opacity-100',
] as const;

const DOT_CENTERS = [2.5, 8, 13.5] as const;

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

const ThreadStatusIcon: FC<{ status: ThreadStatus }> = ({ status }) => {
    const { t } = useLingui();

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
