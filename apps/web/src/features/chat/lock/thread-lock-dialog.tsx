import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { forgetUnlockProof, rememberUnlockProof } from "@neore/client-runtime";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

/** What the dialog does: set a passcode, unlock, change it, or remove it. */
export type ThreadLockMode = "change" | "remove" | "set" | "unlock";

/** The server's answer to a passcode check. A wrong passcode is a result, not an error. */
interface LockOutcome {
    expiresAt?: number;
    ok: boolean;
    proof?: string;
    retryAfterMs?: number;
}

const MIN_PASSCODE_LENGTH = 6;
const CURRENT_PASSCODE_MODES = new Set<ThreadLockMode>(["change", "remove", "unlock"]);

const waitMinutes = (retryAfterMs: number): number => Math.max(1, Math.ceil(retryAfterMs / 60_000));

interface ThreadLockDialogProps {
    mode: ThreadLockMode;
    onOpenChange: (open: boolean) => void;
    open: boolean;
    threadId: string;
}

export const ThreadLockDialog = ({ mode, onOpenChange, open, threadId }: ThreadLockDialogProps) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const currentId = useId();
    const newId = useId();
    const confirmId = useId();
    const [current, setCurrent] = useState("");
    const [next, setNext] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);

    const enable = useMutation(crpc.agent.thread_lock.enableThreadLock.mutationOptions());
    const unlock = useMutation(crpc.agent.thread_lock.unlockThread.mutationOptions());
    const change = useMutation(crpc.agent.thread_lock.changeThreadPasscode.mutationOptions());
    const remove = useMutation(crpc.agent.thread_lock.removeThreadPasscode.mutationOptions());
    const pending = enable.isPending || unlock.isPending || change.isPending || remove.isPending;

    const wrongOrWaiting = (outcome: LockOutcome): string => {
        if (outcome.retryAfterMs !== undefined) {
            return t`Too many wrong attempts. Try again in ${waitMinutes(outcome.retryAfterMs)} min.`;
        }

        return t`That passcode is not right.`;
    };

    const finish = async (outcome: LockOutcome) => {
        if (outcome.proof !== undefined && outcome.expiresAt !== undefined) {
            rememberUnlockProof(threadId, outcome.proof, outcome.expiresAt);
        } else if (mode === "remove") {
            forgetUnlockProof(threadId);
        }

        await queryClient.invalidateQueries();
        setCurrent("");
        setNext("");
        setConfirm("");
        setError(null);
        onOpenChange(false);
    };

    const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);

        try {
            if (mode === "set") {
                if (next.length < MIN_PASSCODE_LENGTH) {
                    setError(t`Use at least ${MIN_PASSCODE_LENGTH} characters.`);

                    return;
                }

                if (next !== confirm) {
                    setError(t`The two passcodes do not match.`);

                    return;
                }

                await finish(await enable.mutateAsync({ passcode: next, threadId: threadId as Id<"threads"> }));

                return;
            }

            if (mode === "unlock") {
                const outcome = await unlock.mutateAsync({ passcode: current, threadId: threadId as Id<"threads"> });

                if (!outcome.ok) {
                    setError(wrongOrWaiting(outcome));

                    return;
                }

                await finish(outcome);

                return;
            }

            if (mode === "change") {
                if (next.length < MIN_PASSCODE_LENGTH || next !== confirm) {
                    setError(t`The new passcode needs ${MIN_PASSCODE_LENGTH} characters, typed twice the same.`);

                    return;
                }

                const outcome = await change.mutateAsync({ currentPasscode: current, newPasscode: next, threadId: threadId as Id<"threads"> });

                if (!outcome.ok) {
                    setError(wrongOrWaiting(outcome));

                    return;
                }

                await finish(outcome);

                return;
            }

            const outcome = await remove.mutateAsync({ passcode: current, threadId: threadId as Id<"threads"> });

            if (!outcome.ok) {
                setError(wrongOrWaiting(outcome));

                return;
            }

            await finish(outcome);
        } catch {
            setError(t`Something went wrong. Nothing was changed. Try again.`);
        }
    };

    const titles = {
        change: t`Change passcode`,
        remove: t`Remove passcode`,
        set: t`Lock this chat`,
        unlock: t`Unlock this chat`,
    } as const;

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{titles[mode]}</DialogTitle>
                    <DialogDescription>
                        {t`A passcode keeps this chat closed to anyone using a browser you are already signed in to. It is not end-to-end encryption: the service can still read the chat. If you forget the passcode, the only way out is to delete the chat.`}
                    </DialogDescription>
                </DialogHeader>
                <form className="flex flex-col gap-3" noValidate onSubmit={onSubmit}>
                    {CURRENT_PASSCODE_MODES.has(mode) && (
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor={currentId}>{mode === "unlock" || mode === "remove" ? t`Passcode` : t`Current passcode`}</Label>
                            <Input
                                autoComplete="current-password"
                                autoFocus
                                id={currentId}
                                onChange={(event) => setCurrent(event.target.value)}
                                type="password"
                                value={current}
                            />
                        </div>
                    )}
                    {(mode === "set" || mode === "change") && (
                        <>
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor={newId}>{t`New passcode`}</Label>
                                <Input
                                    autoComplete="new-password"
                                    autoFocus={mode === "set"}
                                    id={newId}
                                    onChange={(event) => setNext(event.target.value)}
                                    type="password"
                                    value={next}
                                />
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor={confirmId}>{t`Type it again`}</Label>
                                <Input
                                    autoComplete="new-password"
                                    id={confirmId}
                                    onChange={(event) => setConfirm(event.target.value)}
                                    type="password"
                                    value={confirm}
                                />
                            </div>
                        </>
                    )}
                    {error !== null && (
                        <p className="text-destructive text-sm" role="alert">
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
                            {t`Cancel`}
                        </Button>
                        <Button disabled={pending} type="submit">
                            {pending ? t`Checking…` : titles[mode]}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};
