"use client";

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
    "already_linked" | "attached" | "forbidden" | "host_error" | "needs_reconnect" | "not_connected" | "not_found" | "rate_limited" | "thread_full";

/**
 * The pull requests a thread is linked to, in the chat header: each opens the pull request in Develop, and a dialog
 * links more by hand. The list is asked for after first paint, so the header does not add to the queries that wait for it.
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
    const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
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
        rate_limited: t`The host is limiting requests. Try again shortly.`,
        thread_full: t`This thread already has as many pull requests linked as it can keep.`,
    };

    const submit = async () => {
        const parsed = parsePullRequestAddresses(text);

        if (parsed === null) {
            setNotice({ kind: "error", text: t`Enter pull requests as owner/name#123.` });

            return;
        }

        if (parsed.length === 0) {
            return;
        }

        if (parsed.length > MAX_PULL_REQUESTS_PER_ATTACH) {
            setNotice({ kind: "error", text: t`Link at most ${MAX_PULL_REQUESTS_PER_ATTACH} pull requests at a time.` });

            return;
        }

        setBusy(true);
        setNotice(null);

        try {
            const outcome = await attach({ pullRequests: parsed, threadId });
            const linked = outcome.results.filter((result) => result.status === "attached").length;
            const alreadyLinked = outcome.results.some((result) => result.status === "already_linked");
            const failed = outcome.results.filter((result) => result.status !== "attached" && result.status !== "already_linked");

            if (failed.length > 0) {
                // Every failure is named and the input is kept, so a retry does not mean typing the addresses again.
                setNotice({
                    kind: "error",
                    text: failed.map((result) => `${result.repository}#${String(result.number)}: ${statusText[result.status]}`).join(" "),
                });

                return;
            }

            if (linked === 0 && alreadyLinked) {
                setNotice({ kind: "success", text: statusText.already_linked });
            } else if (alreadyLinked) {
                setNotice({ kind: "success", text: t`${linked} linked. ${statusText.already_linked}` });
            } else {
                setNotice({ kind: "success", text: t`${linked} linked.` });
            }

            setText("");
        } catch {
            setNotice({ kind: "error", text: t`Could not link. Try again.` });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-2">
            {(links.data ?? []).map((link) => (
                <Link
                    aria-label={t`Open the pull request ${link.repository}#${link.number}`}
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline"
                    key={`${link.repository}#${link.number}`}
                    search={{ number: link.number, repository: link.repository }}
                    to="/develop"
                >
                    <GitPullRequestArrow aria-hidden className="size-3" />
                    <span>
                        {link.repository}#{link.number}
                    </span>
                </Link>
            ))}
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
                            disabled={busy}
                            id={`${dialogId}-input`}
                            onChange={(event) => setText(event.target.value)}
                            placeholder="owner/name#123"
                            value={text}
                        />
                    </div>
                    <div aria-live="polite" className="px-6" role="status">
                        {notice?.kind === "success" && <p className="text-sm">{notice.text}</p>}
                    </div>
                    {notice?.kind === "error" && (
                        <div className="px-6">
                            <Alert role="alert" variant="destructive">
                                <AlertTitle>{t`Not linked`}</AlertTitle>
                                <AlertDescription>{notice.text}</AlertDescription>
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
