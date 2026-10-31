"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Skeleton } from "@neore/ui/components/skeleton";
import type { FormEvent } from "react";
import { useState } from "react";

import env from "@/lib/env";

import { useRefreshWatchedOnOpen, useWatchedRepositories, useWatchMutations } from "../lib/use-watched";

type Watched = NonNullable<ReturnType<typeof useWatchedRepositories>["data"]>["watched"][number];

const webhookUrl = (id: string): string => `${env.VITE_LUNORA_URL}/source-control/webhook/${id}`;

/** Owns the mutation that issues the secret, so the secret it returns is the one this row shows. */
const WebhookSetup = ({ watched }: { watched: Watched }) => {
    const { t } = useLingui();
    const { disableWebhook, enableWebhook } = useWatchMutations();
    const issued = enableWebhook.data?.status === "ok" ? enableWebhook.data : undefined;

    return (
        <div className="space-y-2 text-xs">
            {issued && (
                <div className="bg-muted space-y-1 rounded-md p-2" role="status">
                    <p>{t`Add this as a webhook on the repository (content type JSON). Choose individual events and tick Pull requests and Pull request reviews: without them a new review request waits for the next poll, up to 30 minutes. The secret is shown once.`}</p>
                    <p className="break-all">
                        <span className="font-medium">{t`URL`}:</span> {webhookUrl(issued.id)}
                    </p>
                    <p className="break-all">
                        <span className="font-medium">{t`Secret`}:</span> <code>{issued.secret}</code>
                    </p>
                </div>
            )}
            <p className="text-muted-foreground">
                {t`A webhook only tells Neore to look again sooner. Polling keeps working without one.`}
                {watched.webhook.seenAt > 0 && ` ${t`Last heard from it`}: ${new Date(watched.webhook.seenAt).toLocaleString()}.`}
            </p>
            <div className="flex flex-wrap gap-2">
                <Button disabled={enableWebhook.isPending} onClick={() => enableWebhook.mutate({ repository: watched.repository })} size="sm" variant="outline">
                    {watched.webhook.enabled ? t`Issue a new secret` : t`Set up a webhook`}
                </Button>
                {watched.webhook.enabled && (
                    <Button
                        disabled={disableWebhook.isPending}
                        onClick={() => disableWebhook.mutate({ repository: watched.repository })}
                        size="sm"
                        variant="outline"
                    >
                        {t`Remove the webhook`}
                    </Button>
                )}
            </div>
        </div>
    );
};

const WatchedRow = ({ onSelect, watched, webhooks }: { onSelect: (repo: string, number: number) => void; watched: Watched; webhooks: boolean }) => {
    const { t } = useLingui();
    const { unwatch } = useWatchMutations();
    const problems: Record<Exclude<Watched["lastStatus"], "ok">, string> = {
        forbidden: t`No access to this repository.`,
        host_error: t`The host did not answer. Trying again later.`,
        needs_reconnect: t`Sign in to the host again to keep this fresh.`,
        not_connected: t`Connect the host to keep this fresh.`,
        not_found: t`This repository was not found.`,
        rate_limited: t`The host is limiting requests. Trying again later.`,
    };

    const waiting = watched.dirty ? ` · ${t`a change is waiting to be read`}` : "";
    const checkedNote = watched.checkedAt === 0 ? t`Not read yet.` : `${t`Checked`} ${new Date(watched.checkedAt).toLocaleTimeString()}${waiting}`;

    return (
        <li className="space-y-2 p-3">
            <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{watched.repository}</span>
                <Button
                    aria-label={t`Stop watching ${watched.repository}`}
                    disabled={unwatch.isPending}
                    onClick={() => unwatch.mutate({ repository: watched.repository })}
                    size="sm"
                    variant="ghost"
                >
                    {t`Stop`}
                </Button>
            </div>
            {watched.lastStatus !== "ok" && (
                <p className="text-destructive text-xs" role="status">
                    {problems[watched.lastStatus]}
                </p>
            )}
            <p className="text-muted-foreground text-xs">{checkedNote}</p>
            {watched.requested.length > 0 && (
                <ul aria-label={t`Review requests in ${watched.repository}`} className="divide-y rounded-md border">
                    {watched.requested.map((request) => (
                        <li key={request.number}>
                            <button
                                className="hover:bg-muted focus-visible:ring-ring w-full px-2 py-1 text-left text-xs outline-none focus-visible:ring-2"
                                onClick={() => onSelect(watched.repository, request.number)}
                                type="button"
                            >
                                <span className="block truncate font-medium">{request.title}</span>
                                <span className="text-muted-foreground">
                                    #{request.number} · {request.authorLogin}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {webhooks && <WebhookSetup watched={watched} />}
        </li>
    );
};

/**
 * The repositories the user chose to keep fresh, with the review requests found in each. Read again when this opens
 * (`useRefreshWatchedOnOpen`) and by the backend's polling afterwards; the list is live.
 */
const WatchedRepositories = ({ onSelect, webhooks }: { onSelect: (repo: string, number: number) => void; webhooks: boolean }) => {
    const { t } = useLingui();
    const list = useWatchedRepositories(true);
    const { watch } = useWatchMutations();
    const [repo, setRepo] = useState("");

    useRefreshWatchedOnOpen(true);

    const rejected = watch.data !== undefined && watch.data.status !== "ok";

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();

        if (repo.trim() === "") {
            return;
        }

        watch.mutate({ repository: repo }, { onSuccess: (outcome) => outcome.status === "ok" && setRepo("") });
    };

    return (
        <section aria-label={t`Watched repositories`} className="space-y-3">
            <h2 className="text-sm font-semibold">{t`Watched repositories`}</h2>
            <p className="text-muted-foreground text-xs">{t`Neore keeps these up to date and tells you when someone asks for your review.`}</p>
            <form className="flex gap-2" onSubmit={submit}>
                <Input
                    aria-label={t`Repository to watch`}
                    maxLength={200}
                    onChange={(event) => setRepo(event.target.value)}
                    placeholder={t`owner/name`}
                    value={repo}
                />
                <Button disabled={watch.isPending} type="submit" variant="outline">
                    {t`Watch`}
                </Button>
            </form>
            {rejected && (
                <p className="text-destructive text-xs" role="status">
                    {watch.data?.status === "limit" ? t`You are watching as many repositories as is allowed.` : t`That is not a repository address.`}
                </p>
            )}
            {list.isError && !list.data && (
                <p className="text-destructive text-sm" role="alert">
                    {t`Your watched repositories could not be loaded.`}
                </p>
            )}
            {list.isPending && <Skeleton aria-label={t`Loading`} className="h-12 w-full" role="status" />}
            {list.data && list.data.watched.length === 0 && <p className="text-muted-foreground text-sm">{t`You are not watching any repository.`}</p>}
            {list.data && list.data.watched.length > 0 && (
                <ul className="divide-y rounded-md border">
                    {list.data.watched.map((watched) => (
                        <WatchedRow key={watched.id} onSelect={onSelect} watched={watched} webhooks={webhooks} />
                    ))}
                </ul>
            )}
        </section>
    );
};

export default WatchedRepositories;
