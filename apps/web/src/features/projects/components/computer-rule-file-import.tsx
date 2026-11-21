"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { isDeviceOnline } from "@/features/devices/lib/device-relay";
import { useCRPC } from "@/lib/lunora/crpc";

type FileId = "claude" | "codex" | "gemini" | "windsurf";

type FileEntry = {
    id: FileId;
    name: string;
    path: string;
    reason?: string;
    size?: number;
    status: "found" | "left_out" | "missing" | "read" | "refused" | "too_large";
    text?: string;
};

type Failure = "busy" | "denied" | "expired" | "failed" | "offline" | "outdated" | "unknown";

const REFUSALS: Readonly<Record<string, Failure>> = { DEVICE_BUSY: "busy", DEVICE_OFFLINE: "offline", DEVICE_OUTDATED: "outdated" };

const failureOf = (error: unknown): Failure => {
    const code = typeof error === "object" && error !== null ? (error as { data?: { code?: unknown } }).data?.code : undefined;

    return (typeof code === "string" && REFUSALS[code]) || "unknown";
};

const ComputerImportPanel: FC<{ disabled: boolean; onClose: () => void; onImport: (files: File[]) => void }> = ({ disabled, onClose, onImport }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const { data: devices } = useQuery(crpc.devices.functions.listDevices.queryOptions({}));
    const start = useMutation(crpc.devices.global_instructions.startGlobalInstructionsCall.mutationOptions());
    const [chosenId, setChosenId] = useState<string | undefined>(undefined);
    const [listCallId, setListCallId] = useState<string | undefined>(undefined);
    const [readCallId, setReadCallId] = useState<string | undefined>(undefined);
    const [picked, setPicked] = useState<ReadonlySet<FileId>>(new Set());
    const [startFailure, setStartFailure] = useState<Failure | undefined>(undefined);
    // When the panel opened: whether a computer is online is read against it (the backend checks again on send).
    const [now] = useState(Date.now);
    const activeCallId = readCallId ?? listCallId;
    const { data: call } = useQuery(
        crpc.devices.global_instructions.getGlobalInstructionsCall.queryOptions(activeCallId ? { callId: activeCallId as Id<"deviceCalls"> } : skipToken),
    );
    const { data: listed } = useQuery(
        crpc.devices.global_instructions.getGlobalInstructionsCall.queryOptions(listCallId ? { callId: listCallId as Id<"deviceCalls"> } : skipToken),
    );
    // A read is handed on once, however often its row is pushed again.
    const imported = useRef<string | undefined>(undefined);

    useEffect(() => {
        document.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`)?.focus();
    }, [headingId]);

    const found: FileEntry[] | undefined = listed?.status === "completed" ? listed.files : undefined;

    useEffect(() => {
        if (found) {
            setPicked(new Set(found.filter((file) => file.status === "found").map((file) => file.id)));
        }
    }, [found]);

    const readFiles: FileEntry[] | undefined = readCallId && call?.status === "completed" ? call.files : undefined;
    const notRead = readFiles?.filter((file) => file.status !== "read") ?? [];

    useEffect(() => {
        if (!readCallId || !readFiles || imported.current === readCallId) {
            return;
        }

        imported.current = readCallId;

        const files = readFiles.flatMap((file) => (file.status === "read" && file.text !== undefined ? [new File([file.text], file.name)] : []));

        if (files.length > 0) {
            onImport(files);
            // Unticked once imported, so trying again for the rest does not add them twice.
            const came = new Set(readFiles.flatMap((file) => (file.status === "read" ? [file.id] : [])));

            setPicked((current) => new Set([...current].filter((id) => !came.has(id))));
        }

        // Every ticked file came: the panel's work is done. Otherwise it stays to say which did not.
        if (readFiles.every((file) => file.status === "read")) {
            onClose();
        }
    }, [onClose, onImport, readCallId, readFiles]);

    const desktops = (devices ?? []).filter((device) => device.viaDeviceId === undefined && device.transport === undefined);
    const chosen = desktops.find((device) => device._id === chosenId) ?? desktops.find((device) => isDeviceOnline(device.lastSeenAt, now)) ?? desktops[0];
    const online = chosen !== undefined && isDeviceOnline(chosen.lastSeenAt, now);
    const name = chosen?.name ?? "";
    const callFailure: Failure | undefined =
        call && call.status !== "completed" && call.status !== "pending" && call.status !== "claimed" ? call.status : undefined;
    const failure = startFailure ?? callFailure;
    // A call just started has no answer yet (`call` is still undefined for its new key): it waits too, so a second click starts nothing.
    const waiting = start.isPending || (activeCallId !== undefined && call === undefined) || call?.status === "pending" || call?.status === "claimed";

    const failureText: Record<Failure, string> = {
        busy: t`${name} is busy with other requests. Try again in a moment.`,
        denied: t`The request was denied on ${name}.`,
        expired: t`${name} did not answer in time. Open the desktop app on it and try again.`,
        failed: t`${name} could not read the files.`,
        offline: t`${name} is offline. Open the desktop app on it and try again.`,
        outdated: t`Update the desktop app on ${name} first.`,
        unknown: t`The request could not be sent.`,
    };

    const send = (files?: FileId[]) => {
        if (!chosen) {
            return;
        }

        setStartFailure(undefined);
        start
            .mutateAsync({ deviceId: chosen._id as Id<"devices">, ...(files && { files }) })
            .then(({ callId }) => (files ? setReadCallId(callId) : setListCallId(callId)))
            .catch((error: unknown) => setStartFailure(failureOf(error)));
    };

    const look = () => {
        setListCallId(undefined);
        setReadCallId(undefined);
        send();
    };

    const sizeOf = (bytes: number): string => t`${formatNumber(Math.max(1, Math.ceil(bytes / 1024)), i18n.locale)} KB`;

    const statusText: Record<FileEntry["status"], string> = {
        found: "",
        left_out: t`(did not fit in one read: import it on its own)`,
        missing: t`(not on this computer)`,
        read: "",
        refused: t`(refused: it links outside your home folder or is not a text file)`,
        too_large: t`(too large)`,
    };

    const progress = (() => {
        if (!waiting) {
            return "";
        }

        return call?.status === "claimed" && call.phase === "prompting" ? t`Approve the request in the desktop app on ${name}.` : t`Waiting for ${name}…`;
    })();

    return (
        <section aria-labelledby={headingId} className="w-full space-y-3 rounded-md border p-3" data-testid="computer-rule-file-import">
            <h4 className="text-sm font-medium" id={headingId} tabIndex={-1}>
                {t`Import from this computer`}
            </h4>
            {devices && desktops.length === 0 && <p className="text-sm">{t`Pair the desktop app in Settings → Devices to import from a computer.`}</p>}
            {desktops.length > 1 && (
                <RadioGroup
                    aria-label={t`Computer`}
                    disabled={waiting}
                    onValueChange={(value) => {
                        setChosenId(String(value));
                        setListCallId(undefined);
                        setReadCallId(undefined);
                        setStartFailure(undefined);
                    }}
                    value={chosen?._id}
                >
                    {desktops.map((device) => (
                        <Label className="flex items-center gap-2 text-sm font-normal" key={device._id}>
                            <RadioGroupItem value={device._id} />
                            {device.name}
                            {!isDeviceOnline(device.lastSeenAt, now) && <span className="text-muted-foreground text-xs">{t`(offline)`}</span>}
                        </Label>
                    ))}
                </RadioGroup>
            )}
            {chosen && (
                <p className="text-muted-foreground text-xs">
                    {t`Looks for the global CLAUDE.md, AGENTS.md, GEMINI.md and global_rules.md in your home folder on ${name}, and nothing else. You approve each request in the desktop app.`}
                </p>
            )}
            {/* Kept mounted, so a screen reader hears where the request is and what it found. */}
            <p className={progress ? "text-sm" : "sr-only"} role="status">
                {progress}
                {!progress && found && t`Found ${plural(found.filter((file) => file.status === "found").length, { one: "# file", other: "# files" })}.`}
            </p>
            {found && (
                <ul aria-label={t`Instruction files`} className="space-y-2">
                    {found.map((file) => (
                        <li key={file.id}>
                            <Label className="flex flex-wrap items-center gap-2 text-sm font-normal">
                                <Checkbox
                                    checked={picked.has(file.id)}
                                    disabled={file.status !== "found" || waiting}
                                    onCheckedChange={(checked) => {
                                        const next = new Set(picked);

                                        if (checked) {
                                            next.add(file.id);
                                        } else {
                                            next.delete(file.id);
                                        }

                                        setPicked(next);
                                    }}
                                />
                                <span className="font-mono text-xs">{file.path}</span>
                                {file.size !== undefined && file.status === "found" && (
                                    <span className="text-muted-foreground text-xs">{sizeOf(file.size)}</span>
                                )}
                                {statusText[file.status] && <span className="text-muted-foreground text-xs">{statusText[file.status]}</span>}
                            </Label>
                        </li>
                    ))}
                </ul>
            )}
            {notRead.length > 0 && (
                <ul aria-label={t`Files not imported`} className="space-y-1 text-sm">
                    {notRead.map((file) => (
                        <li key={file.id}>
                            <span className="font-mono text-xs">{file.path}</span>{" "}
                            <span className="text-muted-foreground text-xs">{statusText[file.status]}</span>
                        </li>
                    ))}
                </ul>
            )}
            {failure && (
                <p className="text-destructive text-sm" role="alert">
                    {failureText[failure]}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                {found && found.some((file) => file.status === "found") ? (
                    <Button
                        disabled={disabled || waiting || picked.size === 0}
                        onClick={() => send(found.flatMap((file) => (picked.has(file.id) ? [file.id] : [])))}
                        size="sm"
                        type="button"
                    >
                        {t`Import selected`}
                    </Button>
                ) : (
                    chosen && (
                        <Button disabled={waiting || !online} onClick={look} size="sm" type="button">
                            {t`Find files`}
                        </Button>
                    )
                )}
                <Button onClick={onClose} size="sm" type="button" variant="ghost">
                    {t`Cancel`}
                </Button>
            </div>
        </section>
    );
};

/**
 * The global instruction files AI tools keep on the person's own paired computer (`devices/global-instructions.ts`): a
 * click asks the desktop which exist (names and sizes), the person ticks some, a second click reads them, and
 * `onImport` takes them as uploaded files, so the upload's parser, mapping, limit and notes apply. Each call is
 * approved in the desktop app. Nothing is asked of the computer, not even the list of devices, before the first click.
 */
const ComputerRuleFileImport: FC<{ disabled: boolean; onImport: (files: File[]) => void }> = ({ disabled, onImport }) => {
    const { t } = useLingui();
    const [open, setOpen] = useState(false);
    const triggerId = useId();
    const [focusRequest, setFocusRequest] = useState(0);

    useEffect(() => {
        if (focusRequest > 0 && !open) {
            document.querySelector<HTMLElement>(`#${CSS.escape(triggerId)}`)?.focus();
        }
    }, [focusRequest, open, triggerId]);

    if (!open) {
        return (
            <Button disabled={disabled} focusableWhenDisabled id={triggerId} onClick={() => setOpen(true)} size="sm" type="button" variant="outline">
                <Laptop aria-hidden="true" className="size-4" />
                {t`Import from this computer`}
            </Button>
        );
    }

    return (
        <ComputerImportPanel
            disabled={disabled}
            onClose={() => {
                setOpen(false);
                setFocusRequest((count) => count + 1);
            }}
            onImport={onImport}
        />
    );
};

export default ComputerRuleFileImport;
