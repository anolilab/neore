/**
 * Task List Tool
 *
 * Conversation-scoped task tracking. Tasks live ONLY in the model's context
 * window (the conversation history) — there is no persistent store. The
 * model maintains state by re-reading its own prior tool calls.
 *
 * Because there is no backing store, lookup-style actions (list,
 * clear_completed) cannot return real persisted data. Update/complete/cancel
 * echo back the change the model is making so the conversation history
 * carries the new state forward without fabricating placeholders that would
 * overwrite the original task title/description in subsequent reads.
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";

type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface Task {
    completedAt?: string;
    createdAt: string;
    description?: string;
    id: string;
    priority: TaskPriority;
    status: TaskStatus;
    subtasks?: {
        completed: boolean;
        id: string;
        title: string;
    }[];
    title: string;
    updatedAt: string;
}

type TaskAction = "create" | "update" | "complete" | "cancel" | "list" | "clear_completed";

const taskListTool = createTool<
    {
        action: TaskAction;
        description?: string;
        priority?: TaskPriority;
        taskId?: string;
        tasks?: {
            description?: string;
            priority?: TaskPriority;
            subtasks?: string[];
            title: string;
        }[];
        title?: string;
        updates?: {
            description?: string;
            priority?: TaskPriority;
            status?: TaskStatus;
            title?: string;
        };
    },
    {
        error?: string;
        message: string;
        tasks: Task[];
    },
    ToolContext
>({
    description: `Track tasks within a single conversation. Tasks live in the conversation history only — there is no persistent task database.

Actions:
- create: Create new tasks (provide tasks array). The created tasks are returned and become part of the conversation history.
- update: Echo an update for an existing task. Provide taskId AND the full new title (and any other fields) so the updated record is complete in history. Do NOT call update with only a status change — also re-state the title.
- complete: Mark a task complete. Provide taskId AND the original title so the completed record is self-describing.
- cancel: Cancel a task. Provide taskId AND the original title.
- list / clear_completed: Reminders for the model to scan its own prior tool calls — they return no data because nothing is persisted.

To know what tasks exist, scan earlier task_list tool calls in this conversation. Do not rely on this tool to fetch task state.`,
    execute: async (context, input) => {
        if (!context.userId) {
            return { error: "Authentication required", message: "Authentication required", tasks: [] };
        }

        const { action, description, priority, taskId, tasks: newTasks, title, updates } = input;
        const now = new Date().toISOString();

        toolsLogger.debug(`[TASK_LIST] Action: ${action}`);

        switch (action) {
            case "cancel": {
                if (!taskId) {
                    return {
                        error: "Please provide a taskId",
                        message: "Task ID required to cancel",
                        tasks: [],
                    };
                }

                if (!title) {
                    return {
                        error: "title is required — pass the original task title",
                        message: "Re-state the task title so the cancelled record is self-describing",
                        tasks: [],
                    };
                }

                return {
                    message: `Cancelled task ${taskId}`,
                    tasks: [
                        {
                            createdAt: now,
                            description,
                            id: taskId,
                            priority: priority || "medium",
                            status: "cancelled",
                            title,
                            updatedAt: now,
                        },
                    ],
                };
            }

            case "clear_completed": {
                return {
                    message: "No persistent store — completed tasks are not stored. Skip emitting them in your next summary to effectively clear them.",
                    tasks: [],
                };
            }

            case "complete": {
                if (!taskId) {
                    return {
                        error: "Please provide a taskId",
                        message: "Task ID required to complete",
                        tasks: [],
                    };
                }

                if (!title) {
                    return {
                        error: "title is required — pass the original task title",
                        message: "Re-state the task title so the completed record is self-describing",
                        tasks: [],
                    };
                }

                const completedTask: Task = {
                    completedAt: now,
                    createdAt: now,
                    description,
                    id: taskId,
                    priority: priority || "medium",
                    status: "completed",
                    title,
                    updatedAt: now,
                };

                return {
                    message: `Completed task ${taskId}`,
                    tasks: [completedTask],
                };
            }

            case "create": {
                if (!newTasks || newTasks.length === 0) {
                    return {
                        error: "Please provide tasks to create",
                        message: "No tasks provided to create",
                        tasks: [],
                    };
                }

                const created: Task[] = newTasks.map((t, index) => {
                    return {
                        createdAt: now,
                        description: t.description,
                        id: `task_${Date.now()}_${index}`,
                        priority: t.priority || "medium",
                        status: "pending" as TaskStatus,
                        subtasks: t.subtasks?.map((st, si) => {
                            return {
                                completed: false,
                                id: `subtask_${Date.now()}_${index}_${si}`,
                                title: st,
                            };
                        }),
                        title: t.title,
                        updatedAt: now,
                    };
                });

                return {
                    message: `Created ${created.length} task(s)`,
                    tasks: created,
                };
            }

            case "list": {
                return {
                    message: "No persistent store — scan earlier task_list tool calls in this conversation to reconstruct the current task state.",
                    tasks: [],
                };
            }

            case "update": {
                if (!taskId) {
                    return {
                        error: "Please provide a taskId",
                        message: "Task ID required for update",
                        tasks: [],
                    };
                }

                if (!updates || Object.keys(updates).length === 0) {
                    return {
                        error: "Provide at least one field in updates",
                        message: "No updates provided",
                        tasks: [],
                    };
                }

                if (!updates.title) {
                    return {
                        error: "updates.title is required — re-state the original or new title",
                        message: "Re-state the task title in updates so the echoed record is complete",
                        tasks: [],
                    };
                }

                const updatedTask: Task = {
                    createdAt: now,
                    description: updates.description,
                    id: taskId,
                    priority: updates.priority || "medium",
                    status: updates.status || "in_progress",
                    title: updates.title,
                    updatedAt: now,
                };

                return {
                    message: `Updated task ${taskId}`,
                    tasks: [updatedTask],
                };
            }

            default: {
                return {
                    error: `Unknown action: ${action}`,
                    message: `Unknown action: ${action}`,
                    tasks: [],
                };
            }
        }
    },
    inputSchema: z
        .object({
            action: z.enum(["create", "update", "complete", "cancel", "list", "clear_completed"]).meta({ description: "The action to perform" }),
            description: z.string().max(500).optional().meta({ description: "Original task description (optional, for complete/cancel)" }),
            priority: z.enum(["low", "medium", "high", "urgent"]).optional().meta({ description: "Original task priority (optional, for complete/cancel)" }),
            taskId: z.string().optional().meta({ description: "Task ID (for update/complete/cancel actions)" }),
            tasks: z
                .array(
                    z.object({
                        description: z.string().max(500).optional().meta({ description: "Task description" }),
                        priority: z.enum(["low", "medium", "high", "urgent"]).optional().default("medium").meta({ description: "Task priority" }),
                        subtasks: z.array(z.string().min(1).max(200)).optional().meta({ description: "List of subtask titles" }),
                        title: z.string().min(1).max(200).meta({ description: "Task title" }),
                    }),
                )
                .optional()
                .meta({ description: "Tasks to create (for 'create' action)" }),
            title: z
                .string()
                .min(1)
                .max(200)
                .optional()
                .meta({ description: "Original task title — required for complete/cancel so the echoed record is self-describing" }),
            updates: z
                .object({
                    description: z.string().max(500).optional(),
                    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
                    status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(),
                    title: z.string().min(1).max(200).optional(),
                })
                .optional()
                .meta({ description: "Updates to apply (for 'update' action). Re-state the title to keep the echoed record complete." }),
        })
        .strict(),
    title: "Task List",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default taskListTool;
