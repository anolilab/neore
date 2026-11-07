"use client";

import { Trans, useLingui } from "@lingui/react/macro";

import type { BoardTask } from "../lib/task-board";

type RunNotice = NonNullable<BoardTask["lastRunNotice"]>;

/** Why the last run did not go where the task says: filed in no project, or started a new chat. */
const TaskRunNotice = ({ notice }: { notice: RunNotice }) => {
    const { i18n, t } = useLingui();
    const reasons: Record<RunNotice["reason"], string> = {
        project_unwritable: t`filed in no project: you can no longer add chats to the task's project`,
        thread_busy: t`started a new chat: a reply was running in the one it continues`,
        thread_locked: t`started a new chat: the one it continues is locked`,
        thread_shared: t`started a new chat: the one it continues is shared by public link`,
        thread_unavailable: t`started a new chat: the one it continues was moved, deleted or changed`,
    };
    const date = i18n.date(new Date(notice.at), { dateStyle: "medium", timeStyle: "short" });
    const why = reasons[notice.reason];

    return (
        <div>
            <dt className="text-xs font-medium">{t`Last run`}</dt>
            <dd className="text-muted-foreground">
                {/* One message, so a locale can reorder the time and the reason. */}
                <Trans>
                    <time dateTime={new Date(notice.at).toISOString()}>{date}</time> · {why}
                </Trans>
            </dd>
        </div>
    );
};

export default TaskRunNotice;
