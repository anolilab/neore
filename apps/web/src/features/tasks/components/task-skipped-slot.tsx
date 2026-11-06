"use client";

import { Trans, useLingui } from "@lingui/react/macro";

import type { BoardTask } from "../lib/task-board";

type SkipReason = NonNullable<BoardTask["lastSkipReason"]>;

/** The last recurrence slot the scheduler let pass without a run, and why. */
const TaskSkippedSlot = ({ at, reason }: { at: number; reason: SkipReason }) => {
    const { i18n, t } = useLingui();
    const reasons: Record<SkipReason, string> = {
        awaiting_review: t`skipped: waiting for your review`,
        blocked: t`skipped: waiting on its dependencies`,
        still_running: t`skipped: still running`,
    };

    const date = i18n.date(new Date(at), { dateStyle: "medium", timeStyle: "short" });
    const why = reasons[reason];

    return (
        <div>
            <dt className="text-xs font-medium">{t`Last skipped run`}</dt>
            <dd className="text-muted-foreground">
                {/* One message, so a locale can reorder the time and the reason. */}
                <Trans>
                    <time dateTime={new Date(at).toISOString()}>{date}</time> · {why}
                </Trans>
            </dd>
        </div>
    );
};

export default TaskSkippedSlot;
