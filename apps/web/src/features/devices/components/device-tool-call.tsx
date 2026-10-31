"use client";

/**
 * The chat row of a tool call that runs on the user's own computer through the
 * desktop shell: the device, the tool, and a
 * live status line — "Waiting for approval on …", "Running on …", "Denied on …".
 *
 * The approval happens in the shell's own window, not here, so while the call
 * is in flight the row subscribes to its `deviceCalls` row (by tool call id).
 * Only then: a finished call reads its outcome from the tool output, so an old
 * thread opens no subscription at all.
 */

import { useLingui } from "@lingui/react/macro";
import type { ToolPart } from "@neore/chat-ui/types";
import { resolveDeviceToolName } from "@neore/chat-ui/utils/device-tool-name";
import cn from "@neore/ui/utils/cn";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, Monitor } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import type { DeviceCallDisplay } from "../lib/device-call-status";
import { deviceCallDisplay, isDeviceCallInFlight, isDeviceCallWaiting } from "../lib/device-call-status";
import { DEVICE_OUTPUT_CAP_LABEL, isFsTool, isShellTool, readFs, readShell } from "../lib/device-output";

const FAILED: ReadonlySet<DeviceCallDisplay> = new Set(["denied", "expired", "failed", "not_approved"]);

const formatJson = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

const PRE_CLASS =
    "mt-1 max-h-64 overflow-auto rounded border border-gray-200 bg-white/60 p-2 font-mono whitespace-pre-wrap dark:border-gray-700 dark:bg-black/20";

const SectionLabel: FC<{ children: string; id: string }> = ({ children, id }) => (
    <span className="font-semibold uppercase opacity-60" id={id}>
        {children}
    </span>
);

const RawJson: FC<{ input: unknown; output: unknown }> = ({ input, output }) => {
    const { t } = useLingui();
    const [isShown, setIsShown] = useState(false);

    return (
        <div className="mb-2">
            <button
                aria-expanded={isShown}
                className="font-semibold uppercase underline opacity-60 hover:opacity-100"
                onClick={() => setIsShown(!isShown)}
                type="button"
            >
                {isShown ? t`Hide raw` : t`Show raw`}
            </button>
            {isShown && (
                <>
                    {input !== undefined && <pre className={PRE_CLASS}>{formatJson(input)}</pre>}
                    {output !== undefined && <pre className={PRE_CLASS}>{formatJson(output)}</pre>}
                </>
            )}
        </div>
    );
};

const ShellResult: FC<{ input: unknown; output: unknown; uid: string }> = ({ input, output, uid }) => {
    const { t } = useLingui();
    const view = readShell(input, output);
    const exitLabel = view.exitCode === undefined ? undefined : t`Exit ${view.exitCode}`;
    const exitFailed = view.exitCode !== undefined && view.exitCode !== 0;

    return (
        <>
            {view.command !== undefined && (
                <div className="mb-2">
                    <SectionLabel id={`${uid}-cmd`}>{t`Command`}</SectionLabel>
                    <pre aria-labelledby={`${uid}-cmd`} className={PRE_CLASS} role="region">
                        {view.command}
                    </pre>
                    {view.cwd !== undefined && <div className="text-muted-foreground mt-1 font-mono">{view.cwd}</div>}
                </div>
            )}
            {exitLabel !== undefined && (
                <div className="mb-2">
                    <span
                        className={cn(
                            "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium",
                            exitFailed
                                ? "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200"
                                : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
                        )}
                    >
                        {exitLabel}
                    </span>
                </div>
            )}
            {view.error !== undefined && <p className="mb-2 text-red-600 dark:text-red-400">{view.error}</p>}
            {view.output !== "" && (
                <div className="mb-2">
                    <SectionLabel id={`${uid}-out`}>{t`Output (stdout and stderr)`}</SectionLabel>
                    <pre aria-labelledby={`${uid}-out`} className={PRE_CLASS} role="region">
                        {view.output}
                    </pre>
                </div>
            )}
            {view.truncated && <p className="mb-2 font-medium text-amber-700 dark:text-amber-300">{t`Output cut at ${DEVICE_OUTPUT_CAP_LABEL}`}</p>}
        </>
    );
};

const FsResult: FC<{ input: unknown; output: unknown; toolName: string }> = ({ input, output, toolName }) => {
    const { t } = useLingui();
    const view = readFs(toolName, input, output);

    if (!view) {
        return null;
    }

    const labels = { bytes: t`Bytes`, entries: t`Entries`, path: t`Path`, size: t`Size`, type: t`Type` };

    return (
        <div className="mb-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                {view.rows.map((row) => (
                    <div className="contents" key={row.label}>
                        <dt className="font-semibold uppercase opacity-60">{labels[row.label]}</dt>
                        <dd className="font-mono break-all">{row.label === "type" && row.value === "binary" ? t`Binary` : row.value}</dd>
                    </div>
                ))}
            </dl>
            {view.body !== undefined && view.body !== "" && (
                <pre aria-label={t`Content`} className={PRE_CLASS} role="region">
                    {view.body}
                </pre>
            )}
            {view.truncated && <p className="mt-1 font-medium text-amber-700 dark:text-amber-300">{t`Output cut at ${DEVICE_OUTPUT_CAP_LABEL}`}</p>}
        </div>
    );
};

const ExpandedBody: FC<{ part: ToolPart; toolName: string }> = ({ part, toolName }) => {
    const { t } = useLingui();
    const uid = useId();
    const hasOutput = part.output !== undefined;

    if (hasOutput && isShellTool(toolName)) {
        return (
            <>
                <ShellResult input={part.input} output={part.output} uid={uid} />
                <RawJson input={part.input} output={part.output} />
            </>
        );
    }

    if (hasOutput && isFsTool(toolName) && readFs(toolName, part.input, part.output)) {
        return (
            <>
                <FsResult input={part.input} output={part.output} toolName={toolName} />
                <RawJson input={part.input} output={part.output} />
            </>
        );
    }

    return (
        <>
            {part.input !== undefined && (
                <div className="mb-2">
                    <span className="font-semibold uppercase opacity-60">{t`Input`}</span>
                    <pre className="mt-1 overflow-x-auto font-mono whitespace-pre-wrap">{formatJson(part.input)}</pre>
                </div>
            )}
            {hasOutput && (
                <div className="mb-2">
                    <span className="font-semibold uppercase opacity-60">{t`Output`}</span>
                    <pre className="mt-1 overflow-x-auto font-mono whitespace-pre-wrap">{formatJson(part.output)}</pre>
                </div>
            )}
        </>
    );
};

const DeviceToolCall: FC<{ part: ToolPart }> = ({ part }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const [isExpanded, setIsExpanded] = useState(false);
    const inFlight = isDeviceCallInFlight(part);
    const { data: live } = useQuery(crpc.devices.functions.getDeviceCallByToolCall.queryOptions(inFlight ? { toolCallId: part.toolCallId } : skipToken));
    const names = resolveDeviceToolName(part);
    const toolName = names?.toolName ?? part.type.replace("tool-", "");
    const device = names?.deviceName ?? live?.deviceName ?? t`your computer`;
    const display = deviceCallDisplay(part, live);
    const isWaiting = isDeviceCallWaiting(display);
    const isFailed = FAILED.has(display);

    const statusText: Record<DeviceCallDisplay, string> = {
        awaiting_approval: t`Waiting for approval on ${device}`,
        claimed: t`Sent to ${device}…`,
        denied: t`Denied on ${device}`,
        done: t`Done on ${device}`,
        expired: t`Expired — ${device} didn't answer`,
        failed: t`Failed on ${device}`,
        not_approved: t`Not approved`,
        queued: t`Waiting for ${device} to pick this up…`,
        running: t`Running on ${device}…`,
    };

    return (
        <div
            className={cn(
                "mb-4 rounded-lg border",
                isFailed
                    ? "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/50"
                    : "border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50",
            )}
        >
            <button
                aria-expanded={isExpanded}
                className="flex w-full items-center gap-2 p-3 text-left text-sm"
                onClick={() => setIsExpanded(!isExpanded)}
                type="button"
            >
                {isExpanded ? <ChevronDown aria-hidden="true" className="size-4 shrink-0" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0" />}
                <Monitor aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                <span className="font-mono font-medium">{toolName}</span>
                <span className="truncate rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:bg-sky-900/50 dark:text-sky-200">
                    {device}
                </span>
            </button>
            <div className={cn("flex items-center gap-2 px-3 pb-3 text-xs", isFailed ? "text-red-700 dark:text-red-300" : "text-muted-foreground")}>
                {isWaiting && <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />}
                <span aria-live="polite" role="status">
                    {statusText[display]}
                </span>
            </div>
            {isExpanded && (
                <div className="border-t border-gray-200 p-3 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-300">
                    <ExpandedBody part={part} toolName={toolName} />
                    {part.errorText !== undefined && <pre className="font-mono whitespace-pre-wrap text-red-600 dark:text-red-400">{part.errorText}</pre>}
                </div>
            )}
        </div>
    );
};

export default DeviceToolCall;
