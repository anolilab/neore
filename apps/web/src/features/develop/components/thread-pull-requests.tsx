"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitPullRequestArrow } from "lucide-react";
import { useId, useState } from "react";

import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC } from "@/lib/lunora/crpc";

import { MAX_PULL_REQUESTS_PER_ATTACH, parsePullRequestAddresses } from "../lib/pull-request-address";
import { useAttachPullRequests, useThreadPullRequests } from "../lib/use-develop";

type AttachStatus =
    | "already_linked"
    | "attached"
    | "forbidden"
    | "host_error"
    | "needs_reconnect"
    | "not_connected"
    | "not_found"
    | "pull_request_full"
    | "rate_limited"
    | "thread_full";

/**
 * The pull requests a thread is linked to, in the chat header: each opens the pull request in Develop, and a dialog
 * links more by hand. Only the thread's owner sees it, and the list is asked for after first paint, so the header does
 * not add to the queries that wait for it.
 */
const ThreadPullRequests = ({ threadId }: { threadId: string | undefined }) => {
    const { t } = useLingui();
    const dialogId = useId();
    const ready = useAfterFirstPaint();
    const crpc = useCRPC();
    const access = useQuery(
        crpc.chat.sharing.getThreadAccess.queryOptions(ready && threadId !== undefined ? { threadId: threadId as Id<"threads"> } : skipToken),
    );
    const links = useThreadPullRequests(ready ? threadId : undefined);
    const attach = useAttachPullRequests();
    const [open, setOpen] = useState(false);
    const [text, setText] = useState("");
    // `success` is what was linked; `failures` names each pull request that was not, with the reason.
    const [success, setSuccess] = useState<string | null>(null);
    const [failures, setFailures] = useState<string[]>([]);
    const [inputProblem, setInputProblem] = useState(false);
    const [busy, setBusy] = useState(false);

    // Only the owner can link: the attach action refuses anyone else, so the control is not shown to them.
    if (threadId === undefined || access.data?.isOwner !== true) {
        return null;
    }

    const statusText: Record<AttachStatus, string> = {
        already_linked: t`Already linked to this thread.`,
        attached: t`Linked to this thread.`,
        forbidden: t`You cannot see that pull request on the host.`,
        host_error: t`The host did not answer. Try again.`,
        needs_reconnect: t`Reconnect your Git host in settings to link a pull request.`,
        not_connected: t`Connect your Git host in settings to link a pull request.`,
        not_found: t`The host has no pull request at that address.`,
        pull_request_full: t`This pull request already has as many threads linked as it can keep.`,
        rate_limited: t`The host is limiting requests. Try again shortly.`,
        thread_full: t`This thread already has as many pull requests linked as it can keep.`,
    };

    const reset = () => {
        setSuccess(null);
        setFailures([]);
        setInputProblem(false);
    };

    const submit = async () => {
        const parsed = parsePullRequestAddresses(text);

        if (parsed === null) {
            reset();
            setInputProblem(true);
            setFailures([t`Enter pull requests as owner/name#123.`]);

            return;
        }

        if (parsed.length === 0) {
            return;
        }

        if (parsed.length > MAX_PULL_REQUESTS_PER_ATTACH) {
            reset();
            setInputProblem(true);
            setFailures([t`Link at most ${MAX_PULL_REQUESTS_PER_ATTACH} pull requests at a time.`]);

            return;
        }

        setBusy(true);
        reset();

        try {
            const outcome = await attach({ pullRequests: parsed, threadId });
            const linked = outcome.results.filter((result) => result.status === "attached").length;
            const alreadyLinked = outcome.results.some((result) => result.status === "already_linked");
            const failed = outcome.results.filter((result) => result.status !== "attached" && result.status !== "already_linked");

            // Every failure is named with its reason, and the input is kept, so a retry does not mean typing the addresses again.
            setFailures(
                failed.map((result) => {
                    const address = `${result.repository}#${String(result.number)}`;
                    const reason = statusText[result.status];

                    return t`${address}: ${reason}`;
                }),
            );

            if (linked > 0) {
                setSuccess(plural(linked, { one: "# pull request linked.", other: "# pull requests linked." }));
            } else if (alreadyLinked) {
                setSuccess(statusText.already_linked);
            }

            if (failed.length === 0) {
                setText("");
            }
        } catch {
            setFailures([t`Could not link. Try again.`]);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-2">
            {(links.data ?? []).length > 0 && (
                <ul className="flex flex-wrap items-center gap-2">
                    {(links.data ?? []).map((link) => (
                        <li key={`${link.repository}#${link.number}`}>
                            <Link
                                aria-label={t`Open the pull request ${link.repository}#${link.number}`}
                                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline"
                                search={{ number: link.number, repository: link.repository }}
                                to="/develop"
                            >
                                <GitPullRequestArrow aria-hidden className="size-3" />
                                <span>
                                    {link.repository}#{link.number}
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
            <Button onClick={() => setOpen(true)} size="sm" variant="ghost">
                {t`Link pull request`}
            </Button>
            <Dialog onOpenChange={setOpen} open={open}>
                <DialogPopup>
                    <DialogHeader>
                        <DialogTitle>{t`Link pull requests`}</DialogTitle>
                        <DialogDescription>{t`Add pull requests that already exist to this thread. Each one is read from the host with your own connection first.`}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1 px-6">
                        <Label htmlFor={`${dialogId}-input`}>{t`Pull requests`}</Label>
                        <Input
                            aria-describedby={inputProblem ? `${dialogId}-problem` : undefined}
                            aria-invalid={inputProblem || undefined}
                            disabled={busy}
                            id={`${dialogId}-input`}
                            onChange={(event) => {
                                setText(event.target.value);
                                setInputProblem(false);
                            }}
                            placeholder="owner/name#123"
                            value={text}
                        />
                    </div>
                    <div aria-live="polite" className="px-6" role="status">
                        {success !== null && <p className="text-sm">{success}</p>}
                        {busy && <p className="text-muted-foreground text-sm">{t`Linking…`}</p>}
                    </div>
                    {failures.length > 0 && (
                        <div className="px-6" id={`${dialogId}-problem`}>
                            <Alert role="alert" variant="destructive">
                                <AlertTitle>{t`Not linked`}</AlertTitle>
                                <AlertDescription>
                                    <ul className="list-disc pl-4">
                                        {failures.map((failure) => (
                                            <li key={failure}>{failure}</li>
                                        ))}
                                    </ul>
                                </AlertDescription>
                            </Alert>
                        </div>
                    )}
                    <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>{t`Close`}</DialogClose>
                        <Button disabled={busy || text.trim() === ""} onClick={submit}>
                            {busy ? t`Linking…` : t`Link`}
                        </Button>
                    </DialogFooter>
                </DialogPopup>
            </Dialog>
        </div>
    );
};

export default ThreadPullRequests;
