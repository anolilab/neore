import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import type { BoardTask, TaskStatus } from "../lib/task-board";
import { findAnnounceableTransitions } from "../lib/task-board";

/**
 * Toasts when a task finishes or lands in review while the Tasks page is open.
 *
 * The board query is live, so a transition arrives as a new snapshot; this
 * diffs it against the previous one. Sonner's toaster is already a polite live
 * region, so screen readers hear these too. `onOpen` jumps to the task — for a
 * review, that is where the decision is made.
 */
const useTaskNotifications = (tasks: ReadonlyArray<BoardTask> | undefined, onOpen: (taskId: BoardTask["_id"]) => void): void => {
    const { t } = useLingui();
    const previous = useRef<Map<string, TaskStatus> | undefined>(undefined);
    const openRef = useRef(onOpen);

    openRef.current = onOpen;

    useEffect(() => {
        if (!tasks) {
            return;
        }

        for (const transition of findAnnounceableTransitions(previous.current, tasks)) {
            const { taskId, title } = transition;
            const action = { label: t`Open`, onClick: () => openRef.current(taskId) };

            if (transition.status === "done") {
                toast.success(t`Task done: ${title}`, { action, id: `task-${taskId}` });
            } else {
                toast.warning(t`Task needs your review: ${title}`, { action, duration: 10_000, id: `task-${taskId}` });
            }
        }

        previous.current = new Map(tasks.map((task) => [task._id as string, task.status]));
    }, [tasks, t]);
};

export default useTaskNotifications;
