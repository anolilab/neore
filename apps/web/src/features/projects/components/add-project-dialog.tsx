"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, Folder, Loader2, Monitor, Server } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getLocalizedError } from "@/features/auth/lib/utilities";
import { useCRPC } from "@/lib/lunora/crpc";
import { getAddProjectBridge, pairNativeHost, probeNativeHost } from "@/lib/native/bridge";

import type { AddProjectMachine, AddProjectMachinesBridge, MachineFolderPage, MachineServerSpec } from "../../../../../desktop/src/add-project-machines.types";
import {
    classifyDisabledReason,
    folderNeedsSharing,
    hostSpecOf,
    isAbsolutePath,
    isAlreadySharedError,
    isDeclinedError,
    isFilePathError,
    isMissingFolderError,
    isNotConnectedError,
    isPathFailure,
    isRefusedRootError,
    isTooManyRootsError,
    isUnreadableFolderError,
    joinPath,
    lastSegment,
    machineRowState,
    parentPath,
} from "../lib/machine-paths";

interface AddProjectDialogProps {
    onClose: () => void;
    /** "Clone or create new…": closes this dialog and opens the project form. */
    onCreateNew: () => void;
    open: boolean;
}

type Attempt<T> = { error: unknown; ok: false } | { ok: true; value: T };

/** Module level so the components stay free of try/catch. */
const attempt = async <T,>(run: () => Promise<T>): Promise<Attempt<T>> => {
    try {
        return { ok: true, value: await run() };
    } catch (error) {
        return { error, ok: false };
    }
};

/** Arrow keys, Home and End move focus between the row buttons of one list. */
const moveFocus = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];

    if (!keys.includes(event.key)) {
        return;
    }

    const rows = [...(event.currentTarget.closest("ul")?.querySelectorAll<HTMLButtonElement>("button[data-row]:not(:disabled)") ?? [])];

    if (rows.length === 0) {
        return;
    }

    event.preventDefault();

    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const targets: Record<string, number> = {
        ArrowDown: Math.min(rows.length - 1, current + 1),
        ArrowUp: Math.max(0, current - 1),
        End: rows.length - 1,
        Home: 0,
    };

    rows[targets[event.key] ?? 0]?.focus();
};

/** Starts a handler's promise from an event; `attempt` never rejects, so nothing is left unhandled. */
const start = (work: Promise<void>): undefined => {
    work.catch(() => {});
};

const ROW_CLASS =
    "hover:bg-muted focus-visible:ring-ring flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60";

interface AddProjectContentProps extends Omit<AddProjectDialogProps, "open"> {
    /** The host being paired or connected. Held by the owner of the open state, so it outlives a closed dialog. */
    pairingHosts: Set<string>;
}

const AddProjectContent = ({ onClose, onCreateNew, pairingHosts }: AddProjectContentProps) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { mutateAsync: createProject } = useMutation(crpc.projects.functions.createProject.mutationOptions());
    const { mutateAsync: registerDevice } = useMutation(crpc.devices.functions.registerDevice.mutationOptions());
    const { mutateAsync: revokeDevice } = useMutation(crpc.devices.functions.revokeDevice.mutationOptions());
    const titleReference = useRef<HTMLHeadingElement>(null);

    const [machines, setMachines] = useState<AddProjectMachine[] | null>(null);
    const [machine, setMachine] = useState<AddProjectMachine | null>(null);
    const [pendingKey, setPendingKey] = useState<string | null>(null);
    const [listing, setListing] = useState<MachineFolderPage | null>(null);
    const [typedPath, setTypedPath] = useState("");
    const [isBrowsing, setIsBrowsing] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [message, setMessage] = useState("");
    const [problem, setProblem] = useState({ forPath: false, text: "" });

    const machineId = machine?.id ?? null;
    const error = problem.text;
    const isPathError = problem.forPath && error !== "";
    const setError = useCallback((text: string, forPath = false) => setProblem({ forPath, text }), []);

    /** A failure, in the words of the picker. The desktop's own text is English, so only recognised refusals are named. */
    const describeFailure = useCallback(
        (failure: unknown): string => {
            if (isMissingFolderError(failure)) {
                return t`That folder was not found.`;
            }

            if (isFilePathError(failure)) {
                return t`That path is a file.`;
            }

            if (isUnreadableFolderError(failure)) {
                return t`This folder cannot be read.`;
            }

            if (isDeclinedError(failure)) {
                return t`Cancelled on this computer.`;
            }

            if (isAlreadySharedError(failure)) {
                return t`That folder is already shared with this server.`;
            }

            if (isRefusedRootError(failure)) {
                return t`That folder is the server's home folder or a folder above it. Choose a folder inside it.`;
            }

            if (isTooManyRootsError(failure)) {
                return t`This server already has its maximum of shared folders. Share a parent folder or remove one in the desktop app.`;
            }

            if (isNotConnectedError(failure)) {
                return t`Connect this server first.`;
            }

            return t`The desktop could not complete that. Try again.`;
        },
        [t],
    );

    // The desktop names rows in English, so the picker names them itself: this computer and the status of a server.
    const rowName = (row: AddProjectMachine): string => (row.kind === "this-computer" ? t`This computer` : row.name);

    const rowLabel = (row: AddProjectMachine): string => {
        if (row.kind === "this-computer") {
            return t`This computer`;
        }

        if (row.status === "connected") {
            return t`Connected`;
        }

        if (row.status === "disabled") {
            return t`SSH · ${row.name}`;
        }

        return t`SSH · ${row.name} · not connected yet`;
    };

    const reasonLabel = (reason: string): string => {
        const kind = classifyDisabledReason(reason);

        if (kind.kind === "unsupported-setting") {
            const { key } = kind;

            return t`This host uses ${key} in ~/.ssh/config, which Neore does not support.`;
        }

        if (kind.kind === "match-rule") {
            return t`This host is used by a Match rule in ~/.ssh/config, which Neore does not evaluate.`;
        }

        return kind.kind === "pair-this-computer" ? t`Pair this computer with your account first (Settings → Devices).` : reason;
    };

    // Each browse request gets a number. A response that is no longer the latest (the person went back, picked another
    // machine or typed another path meanwhile) is dropped, so an old folder never ends up under a new machine.
    const browseGeneration = useRef(0);

    const browse = useCallback(
        async (id: string, path: string, options: { after?: string; createIfMissing: boolean }) => {
            const bridge = getAddProjectBridge();

            if (bridge === undefined) {
                return;
            }

            const generation = browseGeneration.current + 1;
            const isCurrent = (): boolean => generation === browseGeneration.current;

            browseGeneration.current = generation;
            setIsBrowsing(true);
            setError("");
            setMessage("");

            let result = await attempt(() => bridge.browseMachineFolders({ after: options.after, machineId: id, path }));

            if (!isCurrent()) {
                return;
            }

            if (!result.ok && options.createIfMissing && isMissingFolderError(result.error) && isAbsolutePath(path)) {
                const created = await attempt(() => bridge.createMachineFolder({ machineId: id, path }));

                if (!isCurrent()) {
                    return;
                }

                if (created.ok) {
                    setMessage(t`Created ${path}`);
                    result = await attempt(() => bridge.browseMachineFolders({ machineId: id, path: created.value.path }));

                    if (!isCurrent()) {
                        return;
                    }
                } else {
                    result = created;
                }
            }

            setIsBrowsing(false);

            if (result.ok) {
                const page = result.value;

                setListing((previous) =>
                    options.after !== undefined && previous !== null ? { ...page, entries: [...previous.entries, ...page.entries] } : page,
                );
                setTypedPath(result.value.path);

                return;
            }

            setError(describeFailure(result.error), isPathFailure(result.error));

            // A failed move to another folder selects nothing, so Add project cannot submit the folder still listed.
            // A failed next page keeps the page that was shown.
            if (options.after === undefined) {
                setListing(null);
            }
        },
        [describeFailure, setError, t],
    );

    // The content mounts only while the dialog is open, so every opening starts at step 1 with a fresh list.
    useEffect(() => {
        let cancelled = false;

        const load = async (): Promise<void> => {
            const bridge = getAddProjectBridge();
            const result = await attempt(async () => (bridge === undefined ? [] : bridge.listAddProjectMachines()));

            if (cancelled) {
                return;
            }

            if (result.ok) {
                setMachines(result.value);
            } else {
                setMachines([]);
                setError(describeFailure(result.error));
            }
        };

        load().catch(() => {});

        return () => {
            cancelled = true;
        };
    }, [describeFailure, setError]);

    // Focus moves to the step title when the step changes.
    const step = machine === null ? 1 : 2;

    useEffect(() => {
        titleReference.current?.focus();
    }, [step]);

    /** Pairs an ssh host as the Add a server form does: probe, register a device, pair it in the shell. Declining undoes the device. */
    const pairServer = async (bridge: AddProjectMachinesBridge, sshAlias: string, spec: MachineServerSpec): Promise<Attempt<AddProjectMachine>> => {
        const desktopId = machines?.find((candidate) => candidate.kind === "this-computer")?.id ?? null;

        if (desktopId === null) {
            return { error: new Error(t`This computer must be paired first.`), ok: false };
        }

        const nativeSpec = hostSpecOf(spec);
        const probe = await attempt(() => probeNativeHost(nativeSpec));

        if (!probe.ok) {
            return { error: probe.error, ok: false };
        }

        const registered = await attempt(() => registerDevice({ name: spec.name, platform: probe.value.platform, viaDeviceId: desktopId as Id<"devices"> }));

        if (!registered.ok) {
            return { error: registered.error, ok: false };
        }

        const { deviceId, secret } = registered.value;
        const confirmed = await attempt(() => pairNativeHost({ deviceId, secret, spec: nativeSpec }));

        if (!confirmed.ok || !confirmed.value) {
            await attempt(() => revokeDevice({ deviceId: deviceId as Id<"devices"> }));

            return { error: new Error("device: the person declined the pairing"), ok: false };
        }

        return attempt(() => bridge.connectAddProjectMachine(sshAlias));
    };

    const pick = async (row: AddProjectMachine): Promise<void> => {
        const state = machineRowState(row);
        const bridge = getAddProjectBridge();

        if (state.kind === "disabled" || bridge === undefined || pendingKey !== null || pairingHosts.size > 0) {
            return;
        }

        setError("");

        let target = row;

        if (state.kind === "needs-connect" || state.kind === "needs-pair") {
            pairingHosts.add(state.sshAlias);
            setPendingKey(state.sshAlias);

            const connected =
                state.kind === "needs-pair"
                    ? await pairServer(bridge, state.sshAlias, state.spec)
                    : await attempt(() => bridge.connectAddProjectMachine(state.sshAlias));

            if (state.kind === "needs-pair") {
                // Pairing changed this server's row, so the list must show it as paired before the next pick, even when
                // the connection after it failed.
                const refreshed = await attempt(() => bridge.listAddProjectMachines());

                if (refreshed.ok) {
                    setMachines(refreshed.value);
                }
            }

            // Cleared only after the refresh, so the row cannot be picked again while it still shows as unpaired.
            pairingHosts.clear();
            setPendingKey(null);

            if (!connected.ok) {
                setError(describeFailure(connected.error));

                return;
            }

            target = connected.value;
        }

        if (target.id === null) {
            setError(t`This machine is not ready yet.`);

            return;
        }

        setMachine(target);
        setListing(null);
        setTypedPath("");
        await browse(target.id, "", { createIfMissing: false });
    };

    const goBack = (): void => {
        // A request still in flight belongs to the machine being left, so its answer is dropped.
        browseGeneration.current += 1;
        setIsBrowsing(false);
        setMachine(null);
        setListing(null);
        setError("");
        setMessage("");
    };

    const add = async (): Promise<void> => {
        const bridge = getAddProjectBridge();
        const path = listing?.path;

        if (bridge === undefined || machine === null || machineId === null || path === undefined || isAdding || typedPath.trim() !== path) {
            return;
        }

        setIsAdding(true);
        setError("");

        // The desktop answers with the folder it shared: a symlink is shared as its target, which is the folder to record.
        let projectPath = path;

        if (folderNeedsSharing(machine)) {
            const shared = await attempt(() => bridge.shareMachineFolder({ machineId, path }));

            if (shared.ok) {
                projectPath = shared.value.path;
            } else if (!isAlreadySharedError(shared.error)) {
                setIsAdding(false);
                setError(describeFailure(shared.error), isPathFailure(shared.error));

                return;
            }
        }

        const created = await attempt(() =>
            createProject({
                machineId: machineId as Id<"devices">,
                path: projectPath,
                title: lastSegment(projectPath) || rowName(machine),
            }),
        );

        setIsAdding(false);

        if (!created.ok) {
            setError(getLocalizedError({ error: created.error, t }));

            return;
        }

        onClose();
    };

    const parent = listing === null ? null : parentPath(listing.path);

    return (
        <DialogContent className="max-h-dvh max-w-xl overflow-y-auto">
            <DialogHeader>
                <DialogTitle ref={titleReference} tabIndex={-1}>
                    {machine === null ? t`Where is the project?` : t`Add project on ${rowName(machine)}`}
                </DialogTitle>
                <DialogDescription>
                    {machine === null ? t`Pick the computer or server the project's folder is on.` : t`Choose the project's folder, or type a path.`}
                </DialogDescription>
            </DialogHeader>
            <DialogPanel className="min-h-0 flex-1 space-y-3">
                <div aria-live="polite" role="status">
                    {pendingKey !== null && <p className="text-muted-foreground text-sm">{t`Connecting ${pendingKey}…`}</p>}
                    {isBrowsing && <p className="text-muted-foreground text-sm">{t`Loading folders…`}</p>}
                    {message !== "" && !isBrowsing && <p className="text-muted-foreground text-sm">{message}</p>}
                    {isAdding && <p className="text-muted-foreground text-sm">{t`Adding the project…`}</p>}
                </div>
                {error !== "" && (
                    <p className="text-destructive text-sm" id="add-project-path-error" role="alert">
                        {error}
                    </p>
                )}

                {machine === null && (
                    <>
                        {machines === null && getAddProjectBridge() !== undefined && error === "" && (
                            <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
                                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                                {t`Looking for machines…`}
                            </p>
                        )}
                        {machines !== null && (
                            <ul aria-label={t`Machines`} className="space-y-1">
                                {machines.map((row) => {
                                    const state = machineRowState(row);
                                    const key = row.sshAlias ?? row.id ?? row.name;
                                    const Icon = row.kind === "server" ? Server : Monitor;
                                    const reason = state.kind === "disabled" ? state.reason : "";

                                    return (
                                        <li key={key}>
                                            <button
                                                aria-describedby={reason === "" ? undefined : `machine-reason-${key}`}
                                                className={ROW_CLASS}
                                                data-row=""
                                                disabled={state.kind === "disabled" || pendingKey !== null}
                                                onClick={() => start(pick(row))}
                                                onKeyDown={moveFocus}
                                                type="button"
                                            >
                                                <Icon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate font-medium">{rowName(row)}</span>
                                                    <span className="text-muted-foreground block truncate text-xs">{rowLabel(row)}</span>
                                                    {reason !== "" && (
                                                        <span className="text-muted-foreground block text-xs" id={`machine-reason-${key}`}>
                                                            {reasonLabel(reason)}
                                                        </span>
                                                    )}
                                                </span>
                                                {pendingKey !== null && pendingKey === row.sshAlias ? (
                                                    <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
                                                ) : (
                                                    <ChevronRight aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                                                )}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                        <p className="text-muted-foreground text-xs">{t`SSH hosts come from ~/.ssh/config. Picking one connects it.`}</p>
                    </>
                )}

                {machine !== null && (
                    <>
                        <form
                            onSubmit={(event) => {
                                event.preventDefault();

                                if (machineId !== null && typedPath.trim() !== "") {
                                    start(browse(machineId, typedPath.trim(), { createIfMissing: true }));
                                }
                            }}
                        >
                            <label className="mb-1 block text-sm font-medium" htmlFor="add-project-path">
                                {t`Folder path`}
                            </label>
                            <Input
                                aria-describedby={isPathError ? "add-project-path-error add-project-path-hint" : "add-project-path-hint"}
                                aria-invalid={isPathError}
                                autoComplete="off"
                                id="add-project-path"
                                onChange={(event) => setTypedPath(event.target.value)}
                                spellCheck={false}
                                value={typedPath}
                            />
                            <p className="text-muted-foreground mt-1 text-xs" id="add-project-path-hint">
                                {t`Press Enter to open the folder. A folder that does not exist is created.`}
                            </p>
                        </form>
                        <ul aria-label={t`Folders`} className="max-h-72 space-y-1 overflow-y-auto">
                            {parent !== null && (
                                <li>
                                    <button
                                        aria-label={t`Go up to ${parent}`}
                                        className={ROW_CLASS}
                                        data-row=""
                                        disabled={isBrowsing || machineId === null}
                                        onClick={() => machineId !== null && start(browse(machineId, parent, { createIfMissing: false }))}
                                        onKeyDown={moveFocus}
                                        type="button"
                                    >
                                        <Folder aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                                        <span>..</span>
                                    </button>
                                </li>
                            )}
                            {listing?.entries.map((entry) => (
                                <li key={entry.name}>
                                    <button
                                        className={ROW_CLASS}
                                        data-row=""
                                        disabled={isBrowsing || machineId === null}
                                        onClick={() =>
                                            machineId !== null && start(browse(machineId, joinPath(listing.path, entry.name), { createIfMissing: false }))
                                        }
                                        onKeyDown={moveFocus}
                                        type="button"
                                    >
                                        <Folder aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                                        <span className="truncate">{entry.name}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {listing !== null && listing.entries.length === 0 && !isBrowsing && (
                            <p className="text-muted-foreground text-sm">{t`No folders in here.`}</p>
                        )}
                        {listing?.next != null && machineId !== null && (
                            <Button
                                disabled={isBrowsing}
                                onClick={() => start(browse(machineId, listing.path, { after: listing.next ?? undefined, createIfMissing: false }))}
                                size="sm"
                                type="button"
                                variant="ghost"
                            >
                                {t`Show more folders`}
                            </Button>
                        )}
                    </>
                )}
            </DialogPanel>
            <DialogFooter>
                {machine === null ? (
                    <>
                        <Button onClick={onCreateNew} type="button" variant="ghost">
                            {t`Clone or create new…`}
                        </Button>
                        <Button onClick={onClose} type="button" variant="outline">
                            {t`Cancel`}
                        </Button>
                    </>
                ) : (
                    <>
                        <Button disabled={isAdding} onClick={goBack} type="button" variant="outline">
                            {t`Back`}
                        </Button>
                        <Button
                            disabled={isAdding || isBrowsing || listing === null || typedPath.trim() !== listing.path}
                            onClick={() => start(add())}
                            type="button"
                        >
                            {isAdding ? t`Adding…` : t`Add project`}
                        </Button>
                    </>
                )}
            </DialogFooter>
        </DialogContent>
    );
};

const AddProjectDialog = ({ onClose, onCreateNew, open }: AddProjectDialogProps) => {
    const [pairingHosts] = useState(() => new Set<string>());

    return (
        <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
            {/* Mounted only while open: the dialog roots keep closed children mounted, which would reopen the last session. */}
            {open && <AddProjectContent onClose={onClose} onCreateNew={onCreateNew} pairingHosts={pairingHosts} />}
        </Dialog>
    );
};

export default AddProjectDialog;
