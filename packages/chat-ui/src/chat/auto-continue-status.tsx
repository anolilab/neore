import { useLingui } from "@lingui/react/macro";
import { CheckCircle2, Loader2, X, Zap } from "lucide-react";
import type { ReactElement } from "react";
import { memo } from "react";

import cn from "../utils/cn";

export interface AutoContinueToolCall {
    status: "complete" | "error" | "running";
    toolName: string;
}

export interface AutoContinueState {
    active: boolean;
    iteration: number;
    maxIterations: number;
    status: "compressing" | "executing_tools" | "finalizing" | "idle" | "thinking";
    toolCalls: AutoContinueToolCall[];
}

interface AutoContinueStatusProps {
    className?: string;
    onCancel?: () => void;
    state: AutoContinueState;
}

/** Convert tool_name or mcp_server__tool_name to a readable label. */
const formatToolName = (name: string): string => {
    // Strip MCP prefix (mcp_servername__toolname → toolname)
    const stripped = name.includes("__") ? name.split("__").pop()! : name;

    // Convert snake_case to Title Case
    return stripped.replaceAll("_", " ").replaceAll(/\b\w/g, (c) => c.toUpperCase());
};

const TOOL_STATUS_ICONS: Record<AutoContinueToolCall["status"], ReactElement> = {
    complete: <CheckCircle2 aria-hidden="true" className="size-3 text-green-500" />,
    error: <X aria-hidden="true" className="size-3 text-red-500" />,
    running: <Loader2 aria-hidden="true" className="size-3 animate-spin" />,
};

const AutoContinueStatus = memo(({ className, onCancel, state }: AutoContinueStatusProps) => {
    const { t } = useLingui();

    if (!state.active) {
        return null;
    }

    const STATUS_LABELS: Record<AutoContinueState["status"], string> = {
        compressing: t`Compressing context...`,
        executing_tools: t`Executing tools...`,
        finalizing: t`Finalizing...`,
        idle: t`Idle`,
        thinking: t`Thinking...`,
    };

    const completedTools = state.toolCalls.filter((tc) => tc.status === "complete").length;
    const totalTools = state.toolCalls.length;

    // Key on the absolute position in `toolCalls`, not the position in the
    // window: the window slides as calls arrive, the absolute one does not.
    const windowStart = Math.max(0, totalTools - 3);
    const recentToolCalls = state.toolCalls.slice(-3).map((tool, offset) => {
        return { ...tool, key: (windowStart + offset).toString() };
    });

    return (
        <div
            aria-live="polite"
            className={cn("border-t border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-800/50 dark:bg-amber-950/30", className)}
            role="status"
        >
            {/* Header row */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Zap aria-hidden="true" className="size-3.5 fill-amber-500 text-amber-500" />
                    <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{STATUS_LABELS[state.status]}</span>
                    <span className="text-[11px] text-amber-600/70 dark:text-amber-400/60">
                        {t`Iteration`} {state.iteration}/{state.maxIterations}
                        {totalTools > 0 && ` \u{B7} ${completedTools}/${totalTools} tools`}
                    </span>
                </div>

                {onCancel && (
                    <button
                        aria-label={t`Cancel deep work`}
                        className={cn(
                            "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium",
                            "text-amber-600 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/40",
                            "focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none",
                            "transition-colors",
                        )}
                        onClick={onCancel}
                        type="button"
                    >
                        <X aria-hidden="true" className="size-3" />
                        {t`Cancel`}
                    </button>
                )}
            </div>

            {/* Tool call list (show last 3) */}
            {state.toolCalls.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                    {recentToolCalls.map((tool) => (
                        <li className="flex items-center gap-1.5 text-[11px] text-amber-600/80 dark:text-amber-400/70" key={tool.key}>
                            {TOOL_STATUS_ICONS[tool.status]}
                            <span className="truncate">{formatToolName(tool.toolName)}</span>
                        </li>
                    ))}
                </ul>
            )}

            {/* Progress bar */}
            <div
                aria-label={t`Deep work progress`}
                aria-valuemax={state.maxIterations}
                aria-valuemin={0}
                aria-valuenow={state.iteration}
                className="mt-2 h-1 overflow-hidden rounded-full bg-amber-200/50 dark:bg-amber-800/30"
                role="progressbar"
            >
                <div
                    className="h-full rounded-full bg-amber-500 transition-all duration-300 dark:bg-amber-400"
                    style={{ width: `${(state.iteration / state.maxIterations) * 100}%` }}
                />
            </div>
        </div>
    );
});

export default AutoContinueStatus;
