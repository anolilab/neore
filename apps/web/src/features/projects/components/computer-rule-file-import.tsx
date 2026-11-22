"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { MAX_RULE_FILES } from "@neore/backend/rule-file-limits";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { onlineManager, skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { isDeviceOnline } from "@/features/devices/lib/device-relay";
import { useCRPC } from "@/lib/lunora/crpc";

import { importRuleTexts } from "../lib/rule-file-import";
import type { RepoImportResult } from "./repo-rule-file-import";

type FileId = "claude" | "codex" | "gemini" | "windsurf";

type FileEntry = {
    id: FileId;
    name: string;
    path: string;
    reason?: string;
    // An earlier file this one is a link to: the same text, so one draft of the two.
    sameAs?: FileId;
    size?: number;
    // `unanswered`: asked for, but the answer did not carry it (or carried it without its text).
    status: "found" | "left_out" | "missing" | "read" | "refused" | "too_large" | "unanswered";
    text?: string;
};

type Failure = "busy" | "denied" | "disconnected" | "expired" | "failed" | "gone" | "limited" | "lost" | "offline" | "outdated" | "unknown" | "unreadable";

type RunImport = (
    read: (isCurrent: () => boolean, discarded: AbortSignal) => Promise<RepoImportResult | null>,
    onApplied?: (added: ReadonlyArray<string>) => void,
) => void;

/**
 * A call and the computer it went to, by the name it had then: what it found or read is that computer's, never
 * another's, even once it leaves the list. `asked` is what a read asked for.
 */
type CallOn = { asked?: FileId[]; callId: string; deviceId: string; name: string; startedAt: number };

/** How often whether a computer is online is read again, so one that stops checking in shows offline. */
const PRESENCE_CHECK_MS = 10_000;

/**
 * How often a call still waiting is read once, outside its live query: a subscription Lunora refused or lost after its
 * first push leaves that query on its last status, and its refetch answers from that push, never the server.
 */
const STATUS_CHECK_MS = 15_000;

/**
 * The backend's deadline for a call, approval and run (`DEVICE_CALL_DEADLINE_MS`, `devices/lib/constants.ts`), and a
 * margin for the clocks: past it the desktop refuses the call, so one still shown waiting is one this panel lost track
 * of. The backend's sweep may count it as open a while longer.
 */
const CALL_DEADLINE_MS = 5 * 60_000 + 30_000;

/** A refusal by its code (`devices/global-instructions.ts`): the backend's own (`data.code`) before the general one. */
const REFUSALS: Readonly<Record<string, Failure>> = {
    DEVICE_BUSY: "busy",
    DEVICE_OFFLINE: "offline",
    DEVICE_OUTDATED: "outdated",
    NOT_FOUND: "gone",
    // Lunora's online-only write, refused while the connection is down rather than queued for the reconnect.
    OFFLINE_NOT_QUEUED: "disconnected",
    TOO_MANY_REQUESTS: "limited",
};

/** The found file `file` is a link to, among `files`: listed, but not ticked, as its text would apply twice. */
const linkTarget = (file: FileEntry, files: ReadonlyArray<FileEntry>): FileEntry | undefined =>
    file.sameAs === undefined ? undefined : files.find((other) => other.id === file.sameAs && other.status === "found");

/**
 * The files of a read (in the device's order) as one per draft: a link to an earlier one (`sameAs`), or, from a desktop
 * that does not say so, a file with an earlier one's text, would apply the same text twice. `duplicateOf` names, for
 * each one left out, the file kept.
 */
const onePerText = (files: ReadonlyArray<FileEntry>): { duplicateOf: Map<FileId, FileEntry>; kept: FileEntry[] } => {
    const kept: FileEntry[] = [];
    const duplicateOf = new Map<FileId, FileEntry>();

    for (const file of files) {
        const keeper = kept.find((earlier) => earlier.id === file.sameAs) ?? kept.find((earlier) => earlier.text === file.text);

        if (keeper) {
            duplicateOf.set(file.id, keeper);
        } else {
            kept.push(file);
        }
    }

    return { duplicateOf, kept };
};

const failureOf = (error: unknown): Failure => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return [data?.code, code].map((value) => (typeof value === "string" ? REFUSALS[value] : undefined)).find(Boolean) ?? "unknown";
};

const ComputerImportPanel: FC<{ disabled: boolean; onClose: () => void; runImport: RunImport }> = ({ disabled, onClose, runImport }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const offlineId = useId();
    const deviceList = useQuery(crpc.devices.functions.listDevices.queryOptions({}));
    const devices = deviceList.data;
    // Each call prompts the desktop: refused offline, never queued, paused or retried, so none is sent after the person
    // left the panel.
    const start = useMutation(
        crpc.devices.global_instructions.startGlobalInstructionsCall.mutationOptions({ networkMode: "always", retry: 0 }, { onlineOnly: true }),
    );
    const [chosenId, setChosenId] = useState<string | undefined>(undefined);
    const [listing, setListing] = useState<CallOn | undefined>(undefined);
    const [reading, setReading] = useState<CallOn | undefined>(undefined);
    const [picked, setPicked] = useState<ReadonlySet<FileId>>(new Set());
    const [startFailure, setStartFailure] = useState<Failure | undefined>(undefined);
    // The start on its way, by a token of its own rather than the mutation's pending flag: a Discard drops the read's,
    // so the panel waits no more on a start whose answer is thrown away.
    const [starting, setStarting] = useState<symbol | undefined>(undefined);
    const startDone = (token: symbol) => setStarting((current) => (current === token ? undefined : current));
    // Whether a computer is online is read against it, again every few seconds (the backend checks again on send).
    const [now, setNow] = useState(Date.now);

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), PRESENCE_CHECK_MS);

        return () => clearInterval(timer);
    }, []);

    const desktops = (devices ?? []).filter((device) => device.viaDeviceId === undefined && device.transport === undefined);
    const chosen = desktops.find((device) => device._id === chosenId) ?? desktops.find((device) => isDeviceOnline(device.lastSeenAt, now)) ?? desktops[0];
    // What another computer found is not this one's: once the one listed is gone, the person lists again.
    const listCallId = listing?.deviceId === chosen?._id ? listing?.callId : undefined;
    const active = reading ?? (listCallId === undefined ? undefined : listing);
    const activeCallId = active?.callId;
    const { data: liveCall, isError: callUnreadable } = useQuery(
        crpc.devices.global_instructions.getGlobalInstructionsCall.queryOptions(activeCallId ? { callId: activeCallId as Id<"deviceCalls"> } : skipToken),
    );
    // Ends the status check read outside the live query, by call. Kept here, not written into the live query's cache:
    // that query's next refetch answers from its subscription's last push, and would put the call back to waiting.
    const [checkedEnds, setCheckedEnds] = useState<Readonly<Record<string, NonNullable<typeof liveCall>>>>({});
    const call = (activeCallId === undefined ? undefined : checkedEnds[activeCallId]) ?? liveCall;
    // Past its deadline and still not ended: the backend has given up on it, so this panel does too.
    const overdue =
        active !== undefined && now > active.startedAt + CALL_DEADLINE_MS && (call === undefined || call?.status === "pending" || call?.status === "claimed");
    const callLost = callUnreadable || overdue;
    const readCallId = reading?.callId;
    const { data: liveListed } = useQuery(
        crpc.devices.global_instructions.getGlobalInstructionsCall.queryOptions(listCallId ? { callId: listCallId as Id<"deviceCalls"> } : skipToken),
    );
    const listed = (listCallId === undefined ? undefined : checkedEnds[listCallId]) ?? liveListed;
    // The import waiting for the read's answer: handed it once, however often its row is pushed again, and `null` on close.
    const pendingRead = useRef<((files: FileEntry[] | null) => void) | undefined>(undefined);

    useEffect(() => {
        document.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`)?.focus();
    }, [headingId]);

    const found: FileEntry[] | undefined = listed?.status === "completed" ? listed.files : undefined;

    // The listing the ticks were set for. Ticked by default once per listing (a new call, or another computer's), not
    // each time the same listing's files come again, as from a status check ending late: the person's ticks stay.
    const [pickedFor, setPickedFor] = useState<string | undefined>(undefined);

    if (found && listCallId !== pickedFor) {
        setPickedFor(listCallId);
        setPicked(new Set(found.filter((file) => file.status === "found" && !linkTarget(file, found)).map((file) => file.id)));
    }

    const readFiles: FileEntry[] | undefined = readCallId && call?.status === "completed" ? call.files : undefined;
    const isRead = (file: FileEntry): boolean => file.status === "read" && file.text !== undefined;
    // What did not come: each file the answer says was not read, then each asked for that it read without text or left out.
    const notRead: FileEntry[] = readFiles
        ? (reading?.asked ?? readFiles.map((file) => file.id)).flatMap((id): FileEntry[] => {
              const answered = readFiles.find((file) => file.id === id);

              if (answered && isRead(answered)) {
                  return [];
              }

              if (answered && answered.status !== "read") {
                  return [answered];
              }

              const listedFile = found?.find((file) => file.id === id);

              return [{ id, name: listedFile?.name ?? id, path: listedFile?.path ?? id, status: "unanswered" }];
          })
        : [];

    // A call still waiting is read once now and then, outside its live query, so a subscription that went quiet does not
    // keep the panel waiting on its last push.
    const waitingCallId = active?.callId;
    const stillWaiting = waitingCallId !== undefined && !callLost && (call === undefined || call?.status === "pending" || call?.status === "claimed");

    useEffect(() => {
        if (!stillWaiting || waitingCallId === undefined) {
            return undefined;
        }

        const statusRead = crpc.devices.global_instructions.getGlobalInstructionsCall.queryOptions(
            { callId: waitingCallId as Id<"deviceCalls"> },
            { live: false },
        );
        const timer = setInterval(() => {
            if (typeof statusRead.queryFn !== "function") {
                return;
            }

            Promise.resolve(statusRead.queryFn({ queryKey: statusRead.queryKey } as never))
                .then((fresh) => {
                    // Only an end is taken: a waiting status says nothing the live query does not.
                    if (fresh && fresh.status !== "pending" && fresh.status !== "claimed") {
                        setCheckedEnds((current) => {
                            return { ...current, [waitingCallId]: fresh };
                        });
                    }

                    return undefined;
                })
                // Not read this time: the next try, or the deadline, settles it.
                .catch(() => undefined);
        }, STATUS_CHECK_MS);

        return () => clearInterval(timer);
    }, [crpc, stillWaiting, waitingCallId]);

    // Answered, or no longer to be heard of (its status could not be read): either way the import waits no more.
    const readEnded = readCallId !== undefined && (callLost || (call !== undefined && call?.status !== "pending" && call?.status !== "claimed"));

    useEffect(() => {
        if (!readEnded) {
            return;
        }

        const answer = pendingRead.current;

        pendingRead.current = undefined;
        answer?.(readFiles ?? null);
    }, [readEnded, readFiles]);

    // Closed while a read waits: the computer may still answer, but nothing it sends is imported.
    useEffect(
        () => () => {
            pendingRead.current?.(null);
            pendingRead.current = undefined;
        },
        [],
    );

    const online = chosen !== undefined && isDeviceOnline(chosen.lastSeenAt, now);
    // The computer asked, by the name it had when asked, even once it leaves the list and another takes its place.
    const name = active?.name ?? chosen?.name ?? "";
    const callFailure: Failure | undefined = (() => {
        if (callLost) {
            return "lost";
        }

        if (!call || call.status === "completed" || call.status === "pending" || call.status === "claimed") {
            return undefined;
        }

        return call.code === "ANSWER_UNREADABLE" ? "unreadable" : call.status;
    })();
    const failure = startFailure ?? callFailure;
    // A call just started has no answer yet (`call` is still undefined for its new key): it waits too, so a second click starts nothing.
    // A status no longer read waits for nothing, whatever it said before.
    const waiting =
        starting !== undefined ||
        (!callLost && ((activeCallId !== undefined && call === undefined) || call?.status === "pending" || call?.status === "claimed"));
    // Import selected takes Find files' place once files were found.
    const canRead = found?.some((file) => file.status === "found") ?? false;
    // Find files cannot be clicked for this reason, and no alert says it already.
    const offlineNote = chosen !== undefined && !online && !waiting && !canRead && failure !== "offline";

    const failureText: Record<Failure, string> = {
        busy: t`${name} is busy with other requests. Try again in a moment.`,
        denied: t`The request was denied on ${name}.`,
        disconnected: t`You are offline. Reconnect and try again.`,
        expired: t`${name} did not answer in time. Open the desktop app on it and try again.`,
        failed: t`${name} could not read the files.`,
        gone: t`This computer is no longer paired. Pair it again in Settings → Devices.`,
        limited: t`Too many requests. Please try again in a moment.`,
        lost: t`Lost track of the request to ${name}. Try again.`,
        offline: t`${name} is offline. Open the desktop app on it and try again.`,
        outdated: t`Update the desktop app on ${name} first.`,
        unknown: t`The request could not be sent.`,
        unreadable: t`The computer's answer could not be read. Try again, or update the desktop app on ${name}.`,
    };

    const look = () => {
        if (!chosen || disabled) {
            return;
        }

        const deviceId = chosen._id;
        const deviceName = chosen.name;

        // Kept to this computer, so another coming online does not take its place under the files it found.
        setChosenId(deviceId);
        setListing(undefined);
        setReading(undefined);
        setStartFailure(undefined);

        // Refused here rather than sent: an online-only start would fail anyway.
        if (!onlineManager.isOnline()) {
            setStartFailure("disconnected");

            return;
        }

        const token = Symbol("list");

        setStarting(token);
        start
            .mutateAsync({ deviceId: deviceId as Id<"devices"> })
            .then(({ callId }) => {
                startDone(token);
                setListing({ callId, deviceId, name: deviceName, startedAt: Date.now() });

                return undefined;
            })
            .catch((error: unknown) => {
                startDone(token);
                setStartFailure(failureOf(error));
            });
    };

    /** Reads the ticked files inside the editor's import, so it is one import at a time and a Discard drops what comes. */
    const read = (files: FileId[]) => {
        if (!listing || listCallId === undefined || disabled) {
            return;
        }

        // The previous read's ended row must not answer this one.
        setReading(undefined);
        setStartFailure(undefined);

        if (!onlineManager.isOnline()) {
            setStartFailure("disconnected");

            return;
        }

        // The computer that found them, whatever is chosen by the time it answers.
        const { deviceId, name: deviceName } = listing;
        let came: FileEntry[] = [];
        let duplicateOf = new Map<FileId, FileEntry>();
        let allRead = false;
        const token = Symbol("read");

        runImport(
            async (isCurrent, discarded) => {
                setStarting(token);

                const answered = new Promise<FileEntry[] | null>((resolve) => {
                    pendingRead.current = resolve;
                });

                // A Discard ends the read at once: the computer may still answer, but what it sends is dropped, and
                // the panel no longer waits on it.
                discarded.addEventListener(
                    "abort",
                    () => {
                        pendingRead.current?.(null);
                        pendingRead.current = undefined;
                        setReading(undefined);
                        startDone(token);
                    },
                    { once: true },
                );
                // A close settles `answered` with nothing: the import ends then, even while the start still waits.
                const started = await Promise.race([
                    start.mutateAsync({ deviceId: deviceId as Id<"devices">, files }).catch((error: unknown) => {
                        // A start that fails after a Discard is not this panel's to say.
                        if (!discarded.aborted) {
                            setStartFailure(failureOf(error));
                        }

                        return undefined;
                    }),
                    answered.then(() => undefined),
                ]);

                startDone(token);

                if (!started) {
                    pendingRead.current = undefined;

                    return null;
                }

                // Discarded while the start was on its way: the race above already ended this read.
                if (discarded.aborted) {
                    return null;
                }

                setReading({ asked: files, callId: started.callId, deviceId, name: deviceName, startedAt: Date.now() });

                const answer = await answered;

                // Failed, closed or discarded meanwhile: nothing is added (a failure is said by the panel from the call).
                if (!answer || !isCurrent()) {
                    return null;
                }

                // Only the files asked for: one the answer adds, even a known one left unticked, is not imported.
                came = answer.filter((file) => files.includes(file.id) && isRead(file));
                // Each file asked for, not each the answer names: one it left out stays ticked, with a note.
                allRead = files.every((id) => came.some((file) => file.id === id));

                if (came.length === 0) {
                    return null;
                }

                const one = onePerText(came);

                ({ duplicateOf } = one);

                // Each a tool's global instructions, so applied always and whole, Windsurf's `global_rules.md` too.
                const imported = await importRuleTexts(
                    one.kept.map((file) => {
                        return { path: file.name, text: () => file.text ?? "", whole: true };
                    }),
                    MAX_RULE_FILES,
                );

                return { ...imported, duplicates: duplicateOf.size, notRead: 0, unreadable: [] };
            },
            (added) => {
                // A copy left out is done once the file kept for it was added.
                const addedIds = new Set(came.flatMap((file) => (added.includes((duplicateOf.get(file.id) ?? file).name) ? [file.id] : [])));

                // Those added are unticked, so trying again does not add them twice; those the project had no room for stay.
                setPicked((current) => new Set([...current].filter((id) => !addedIds.has(id))));

                // Every ticked file came and was added: the panel's work is done. Otherwise it stays to say which did not.
                if (allRead && addedIds.size === came.length) {
                    onClose();
                }
            },
        );
    };

    const sameText = (path: string): string => t`(same file as ${path})`;

    const sizeOf = (bytes: number): string => t`${formatNumber(Math.max(1, Math.ceil(bytes / 1024)), i18n.locale)} KB`;

    const statusText: Record<FileEntry["status"], string> = {
        found: "",
        left_out: t`(did not fit in one read: import it on its own)`,
        missing: t`(not on this computer)`,
        read: "",
        refused: t`(refused: it links outside your home folder or is not a text file)`,
        too_large: t`(too large)`,
        unanswered: t`(not in the computer's answer: try again)`,
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
            {/* Said even over a list loaded before: the computers shown may no longer be the person's. */}
            {deviceList.isError && (
                <div className="flex flex-wrap items-center gap-2">
                    <p className="text-destructive text-sm" role="alert">
                        {t`Your computers could not be loaded.`}
                    </p>
                    <Button onClick={() => deviceList.refetch().catch(() => undefined)} size="sm" type="button" variant="outline">
                        {t`Try again`}
                    </Button>
                </div>
            )}
            {devices && desktops.length === 0 && <p className="text-sm">{t`Pair the desktop app in Settings → Devices to import from a computer.`}</p>}
            {desktops.length > 1 && (
                <RadioGroup
                    aria-label={t`Computer`}
                    disabled={waiting}
                    onValueChange={(value) => {
                        setChosenId(String(value));
                        setListing(undefined);
                        setReading(undefined);
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
                    {found.map((file) => {
                        const target = file.status === "found" ? linkTarget(file, found) : undefined;

                        return (
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
                                    {target && <span className="text-muted-foreground text-xs">{sameText(target.path)}</span>}
                                </Label>
                            </li>
                        );
                    })}
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
            {/* Why Find files cannot be clicked, with one computer too, where no list says it is offline. */}
            {chosen && offlineNote && (
                <p className="text-muted-foreground text-sm" id={offlineId}>
                    {t`${chosen.name} is offline. Open the desktop app on it to continue.`}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                {found && canRead ? (
                    <Button
                        disabled={disabled || waiting || picked.size === 0}
                        focusableWhenDisabled
                        onClick={() => read(found.flatMap((file) => (picked.has(file.id) ? [file.id] : [])))}
                        size="sm"
                        type="button"
                    >
                        {t`Import selected`}
                    </Button>
                ) : (
                    chosen && (
                        <Button
                            aria-describedby={offlineNote ? offlineId : undefined}
                            disabled={disabled || waiting || !online}
                            focusableWhenDisabled
                            onClick={look}
                            size="sm"
                            type="button"
                        >
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
 * the read runs inside `runImport` as an upload does, so the upload's parser, mapping, limit and notes apply, one import
 * runs at a time and a Discard drops it. Each call is approved in the desktop app. Nothing is asked of the computer,
 * not even the list of devices, before the first click.
 */
const ComputerRuleFileImport: FC<{ disabled: boolean; runImport: RunImport }> = ({ disabled, runImport }) => {
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
            runImport={runImport}
        />
    );
};

export default ComputerRuleFileImport;
