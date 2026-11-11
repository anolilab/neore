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

import { useCRPC } from "@/lib/lunora/crpc";
import { getAddProjectBridge } from "@/lib/native/bridge";

import type { AddProjectMachine, MachineFolderPage } from "../../../../../desktop/src/add-project-machines.types";
import {
    failureText,
    folderNeedsSharing,
    isAbsolutePath,
    isAlreadySharedError,
    isMissingFolderError,
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

const AddProjectContent = ({ onClose, onCreateNew }: Omit<AddProjectDialogProps, "open">) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { mutateAsync: createProject } = useMutation(crpc.projects.functions.createProject.mutationOptions());
    const titleReference = useRef<HTMLHeadingElement>(null);

    const [machines, setMachines] = useState<AddProjectMachine[] | null>(null);
    const [machine, setMachine] = useState<AddProjectMachine | null>(null);
    const [pendingKey, setPendingKey] = useState<string | null>(null);
    const [listing, setListing] = useState<MachineFolderPage | null>(null);
    const [typedPath, setTypedPath] = useState("");
    const [isBrowsing, setIsBrowsing] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    const machineId = machine?.id ?? null;

    const browse = useCallback(
        async (id: string, path: string, options: { after?: string; createIfMissing: boolean }) => {
            const bridge = getAddProjectBridge();

            if (bridge === undefined) {
                return;
            }

            setIsBrowsing(true);
            setError("");
            setMessage("");

            let result = await attempt(() => bridge.browseMachineFolders({ after: options.after, machineId: id, path }));

            if (!result.ok && options.createIfMissing && isMissingFolderError(result.error) && isAbsolutePath(path)) {
                const created = await attempt(() => bridge.createMachineFolder({ machineId: id, path }));

                if (created.ok) {
                    setMessage(t`Created ${path}`);
                    result = await attempt(() => bridge.browseMachineFolders({ machineId: id, path: created.value.path }));
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
            } else {
                setError(failureText(result.error));
            }
        },
        [t],
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
                setError(failureText(result.error));
            }
        };

        load().catch(() => {});

        return () => {
            cancelled = true;
        };
    }, []);

    // Focus moves to the step title when the step changes.
    const step = machine === null ? 1 : 2;

    useEffect(() => {
        titleReference.current?.focus();
    }, [step]);

    const pick = async (row: AddProjectMachine): Promise<void> => {
        const state = machineRowState(row);
        const bridge = getAddProjectBridge();

        if (state.kind === "disabled" || bridge === undefined || pendingKey !== null) {
            return;
        }

        setError("");

        let target = row;

        if (state.kind === "needs-connect") {
            setPendingKey(state.sshAlias);

            const connected = await attempt(() => bridge.connectAddProjectMachine(state.sshAlias));

            setPendingKey(null);

            if (!connected.ok) {
                setError(failureText(connected.error));

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
        setMachine(null);
        setListing(null);
        setError("");
        setMessage("");
    };

    const add = async (): Promise<void> => {
        const bridge = getAddProjectBridge();
        const path = listing?.path;

        if (bridge === undefined || machine === null || machineId === null || path === undefined || isAdding) {
            return;
        }

        setIsAdding(true);
        setError("");

        if (folderNeedsSharing(machine)) {
            const shared = await attempt(() => bridge.shareMachineFolder({ machineId, path }));

            if (!shared.ok && !isAlreadySharedError(shared.error)) {
                setIsAdding(false);
                setError(failureText(shared.error));

                return;
            }
        }

        const created = await attempt(() =>
            createProject({
                machineId: machineId as Id<"devices">,
                path,
                title: lastSegment(path) || machine.name,
            }),
        );

        setIsAdding(false);

        if (!created.ok) {
            setError(failureText(created.error));

            return;
        }

        onClose();
    };

    const parent = listing === null ? null : parentPath(listing.path);

    return (
        <DialogContent className="max-h-dvh max-w-xl overflow-y-auto">
            <DialogHeader>
                <DialogTitle ref={titleReference} tabIndex={-1}>
                    {machine === null ? t`Where is the project?` : t`Add project on ${machine.name}`}
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
                    <p className="text-destructive text-sm" role="alert">
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
                                                    <span className="block truncate font-medium">{row.name}</span>
                                                    <span className="text-muted-foreground block truncate text-xs">{row.label}</span>
                                                    {reason !== "" && (
                                                        <span className="text-muted-foreground block text-xs" id={`machine-reason-${key}`}>
                                                            {reason}
                                                        </span>
                                                    )}
                                                </span>
                                                {pendingKey === row.sshAlias ? (
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
                                autoComplete="off"
                                id="add-project-path"
                                onChange={(event) => setTypedPath(event.target.value)}
                                spellCheck={false}
                                value={typedPath}
                            />
                            <p className="text-muted-foreground mt-1 text-xs">{t`Press Enter to open the folder. A folder that does not exist is created.`}</p>
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
                        <Button disabled={isAdding || isBrowsing || listing === null} onClick={() => start(add())} type="button">
                            {isAdding ? t`Adding…` : t`Add project`}
                        </Button>
                    </>
                )}
            </DialogFooter>
        </DialogContent>
    );
};

const AddProjectDialog = ({ onClose, onCreateNew, open }: AddProjectDialogProps) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
        <AddProjectContent onClose={onClose} onCreateNew={onCreateNew} />
    </Dialog>
);

export default AddProjectDialog;
