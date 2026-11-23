"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ComponentProps, FormEvent, ReactNode } from "react";
import { useId, useState } from "react";

import SettingsCard from "@/components/settings/settings-card";
import { useCRPC } from "@/lib/lunora/crpc";

import type { HostProblem } from "./event-webhook-host-input";
import { hostProblemOf } from "./event-webhook-host-input";

export type EventWebhookHostsCardProperties = ComponentProps<typeof SettingsCard>;

/**
 * The owner's approved callback hosts for Events webhooks. Only the signed-in owner can change the list: the server refuses the
 * API-key path. Removing a host ends the subscriptions that use it, so the removal is confirmed first.
 */
const EventWebhookHostsCard = ({ ...properties }: EventWebhookHostsCardProperties) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const listKey = crpc.auth.event_webhook_hosts.listEventWebhookHosts.queryKey({});
    const { data, isError, isPending } = useQuery(crpc.auth.event_webhook_hosts.listEventWebhookHosts.queryOptions({}));
    const addHost = useMutation(crpc.auth.event_webhook_hosts.addEventWebhookHost.mutationOptions());
    const removeHost = useMutation(crpc.auth.event_webhook_hosts.removeEventWebhookHost.mutationOptions());

    const inputId = useId();
    const hintId = useId();
    const [draft, setDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

    const problemText = (problem: HostProblem): string => {
        switch (problem) {
            case "empty": {
                return t`Enter a host name.`;
            }
            case "ip_address": {
                return t`Enter a host name, not an IP address.`;
            }
            case "long": {
                return t`The host name is too long.`;
            }
            case "path": {
                return t`Enter the host name only, without a path or @.`;
            }
            case "port": {
                return t`Enter the host name only, without a port.`;
            }
            case "scheme": {
                return t`Enter the host name only, without https://.`;
            }
            default: {
                return t`A host name can contain only letters, digits, dots and hyphens.`;
            }
        }
    };

    const refresh = async () => {
        await queryClient.invalidateQueries({ queryKey: listKey });
    };

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const problem = hostProblemOf(draft);

        if (problem !== null) {
            setError(problemText(problem));

            return;
        }

        setError(null);

        try {
            await addHost.mutateAsync({ host: draft.trim() });
            setDraft("");
            await refresh();
        } catch (error_) {
            setError(error_ instanceof Error && error_.message ? error_.message : t`Could not approve the host. Try again.`);
        }
    };

    const confirmRemoval = async (host: string) => {
        setError(null);

        try {
            await removeHost.mutateAsync({ host });
            setPendingRemoval(null);
            await refresh();
        } catch (error_) {
            setError(error_ instanceof Error && error_.message ? error_.message : t`Could not remove the host. Try again.`);
        }
    };

    let listBody: ReactNode;

    if (isPending) {
        listBody = <div className="text-muted-foreground py-6 text-center text-sm">{t`Loading approved hosts…`}</div>;
    } else if (isError && !data) {
        listBody = (
            <div className="text-destructive py-6 text-center text-sm" role="alert">
                {t`Could not load approved hosts. Try again later.`}
            </div>
        );
    } else if (data && data.hosts.length > 0) {
        listBody = (
            <ul aria-label={t`Approved hosts`} className="divide-border divide-y">
                {data.hosts.map((row) => (
                    <li className="flex flex-wrap items-center justify-between gap-2 py-2" key={row.host}>
                        <div className="min-w-0">
                            <span className="font-mono text-sm break-all">{row.host}</span>
                            <span className="text-muted-foreground block text-xs">
                                {t`Approved ${new Date(row.createdAt).toLocaleDateString(i18n.locale)}`}
                            </span>
                        </div>
                        {pendingRemoval === row.host ? (
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span>{t`Events to this host will stop.`}</span>
                                <Button
                                    disabled={removeHost.isPending}
                                    onClick={async () => {
                                        await confirmRemoval(row.host);
                                    }}
                                    size="sm"
                                    variant="destructive"
                                >
                                    {t`Confirm removal`}
                                </Button>
                                <Button onClick={() => setPendingRemoval(null)} size="sm" variant="outline">
                                    {t`Cancel`}
                                </Button>
                            </div>
                        ) : (
                            <Button
                                aria-label={t`Remove ${row.host}`}
                                onClick={() => {
                                    setError(null);
                                    setPendingRemoval(row.host);
                                }}
                                size="sm"
                                variant="outline"
                            >
                                {t`Remove`}
                            </Button>
                        )}
                    </li>
                ))}
            </ul>
        );
    } else {
        listBody = (
            <div className="text-muted-foreground py-6 text-center text-sm">
                {t`No hosts approved yet. Events are not sent to a callback until its host is approved.`}
            </div>
        );
    }

    return (
        <SettingsCard {...properties} description={t`Approve the callback hosts that Events webhooks may send to.`} header={t`Event webhook hosts`}>
            <div className="space-y-4">
                {listBody}
                <form className="space-y-2" onSubmit={submit}>
                    <label className="text-sm font-medium" htmlFor={inputId}>
                        {t`Approve a callback host`}
                    </label>
                    <div className="flex flex-wrap gap-2">
                        <Input
                            aria-describedby={hintId}
                            autoComplete="off"
                            className="min-w-0 flex-1"
                            id={inputId}
                            onChange={(event) => setDraft(event.target.value)}
                            placeholder="hooks.example.com"
                            spellCheck={false}
                            value={draft}
                        />
                        <Button disabled={addHost.isPending} type="submit">
                            {addHost.isPending ? t`Approving…` : t`Approve host`}
                        </Button>
                    </div>
                    <p className="text-muted-foreground text-xs" id={hintId}>
                        {t`The host name only, such as hooks.example.com. HTTPS on the standard port.`}
                    </p>
                    {error ? (
                        <p className="text-destructive text-sm" role="alert">
                            {error}
                        </p>
                    ) : null}
                </form>
            </div>
        </SettingsCard>
    );
};

export default EventWebhookHostsCard;
