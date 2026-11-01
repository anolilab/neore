"use client";

/**
 * RequestSecretPrompt — a `requestSecret` tool call: the agent paused mid-run to
 * ask the user for a secret (`backend/lunora/chat/tools/request-secret.ts`).
 *
 * The card shows what is asked for, why, and where the value will go. While the
 * call waits (`approval-requested`) the owner types the value into a password
 * field and saves it, or declines. The value goes to the server in one call
 * (`answerSecretRequest`) that stores it encrypted and resumes the run with only
 * an opaque reference: it is cleared from this component the moment it is sent,
 * is never shown again, and is kept out of analytics capture.
 *
 * Only the thread owner can answer: the value is stored for them and used with
 * their keys and servers. Anyone else sees the request read-only.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { ToolPart } from "@neore/chat-ui/types";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, X } from "lucide-react";
import type { FC, FormEvent } from "react";
import { useId, useRef, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useCRPC } from "@/lib/lunora/crpc";

import { providerLabel } from "./rate-limit-pause";

/** Mirror `SECRET_HEADER_VALUE_MAX` and `SECRET_PROVIDER_KEY_MAX` on the server (`chat/tools/request-secret-constants.ts`). */
const HEADER_VALUE_MAX = 10_000;
const PROVIDER_KEY_MAX = 500;

type SecretUse = { header: string; kind: "mcp_header"; server: string } | { kind: "provider_key"; provider: string };

type Server = { address: string; kind: "found"; url: string } | { kind: "ambiguous" } | { kind: "failed" } | { kind: "loading" } | { kind: "missing" };

interface RequestSecretInput {
    label?: string;
    purpose?: string;
    use?: SecretUse;
}

type Submitted = "decline" | "save";

/** Where the header will be sent, without a query or fragment (a saved URL can carry a token there). */
const addressOf = (url: string): string => {
    try {
        const { host, pathname, protocol } = new URL(url);

        return `${protocol}//${host}${pathname}`;
    } catch {
        return url;
    }
};

/** Which of the user's saved MCP servers the card names. The answer binds the value to that server's address, so the card shows where that is. */
const resolveServer = (servers: ReadonlyArray<{ name: string; url: string }> | undefined, name: string, failed: boolean): Server => {
    // A failed refresh counts even when an earlier read left servers in the cache: that copy may be the stale address.
    if (failed) {
        return { kind: "failed" };
    }

    if (!servers) {
        return { kind: "loading" };
    }

    const matches = servers.filter((server) => server.name === name);

    if (matches.length > 1) {
        return { kind: "ambiguous" };
    }

    return matches[0] ? { address: addressOf(matches[0].url), kind: "found", url: matches[0].url } : { kind: "missing" };
};

const RequestSecretPrompt: FC<{ part: ToolPart }> = ({ part }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { thread, threadId } = useChatThread();
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const headingId = useId();
    const valueId = useId();
    const destinationId = useId();
    const tooLongId = useId();
    const saveErrorId = useId();
    const loadErrorId = useId();
    const [draft, setDraft] = useState("");
    // Shown in the card, tied to the field: the typed value is cleared on send, so the person must know to type it again.
    const [saveError, setSaveError] = useState<string | null>(null);
    const [submitted, setSubmitted] = useState<Submitted | null>(null);
    // The server closed this request when the conversation moved on: nothing is waiting for an answer.
    const [closed, setClosed] = useState(false);
    // Focus lands here after a send: the form (and the focused control) goes away.
    const groupRef = useRef<HTMLDivElement>(null);
    // The mutation cache holds a mutation's variables for five minutes after it settles; `gcTime: 0` drops them (the value) at once.
    // Offline, the default network mode would PAUSE the call with the value in its variables; `always` sends it now, so it fails and is dropped.
    const { isPending, mutate, reset } = useMutation({
        ...crpc.chat.request_secret.answerSecretRequest.mutationOptions(),
        gcTime: 0,
        networkMode: "always",
        retry: 0,
    });

    const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as RequestSecretInput;
    const label = input.label ?? "";
    const approvalId = part.approval?.id;
    // A public viewer's thread copy has no `userId`, so it never matches.
    const isOwner = !!thread?.userId && thread.userId === sessionData?.user?.id;
    const isWaiting = part.state === "approval-requested" && submitted === null && !closed;
    // Only the owner's servers are the destination, and only the owner's card needs them: for anyone else (a
    // collaborator, a public view) the query never runs. For the owner it is the one the composer and Settings read.
    const {
        data: preferences,
        isError: preferencesFailed,
        isFetching: preferencesFetching,
        isSuccess: preferencesLoaded,
        refetch: retryPreferences,
    } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions(isOwner && isWaiting && input.use?.kind === "mcp_header" ? {} : skipToken));
    // A user who never saved a server has no `mcpServers` (or no row at all): once the read has answered, that is an empty list, not "still loading".
    const savedServers = preferences?.mcpServers ?? (preferencesLoaded ? [] : undefined);
    const server = input.use?.kind === "mcp_header" && isOwner ? resolveServer(savedServers, input.use.server, preferencesFailed) : undefined;
    const valueMax = input.use?.kind === "provider_key" ? PROVIDER_KEY_MAX : HEADER_VALUE_MAX;
    // Checked before anything is sent: the card clears the draft once it goes, and the server would refuse it after that.
    const tooLong = draft.trim().length > valueMax;
    // A header goes to one saved server, found by name when the answer arrives: without exactly one the server refuses it.
    const destinationReady = server === undefined || server.kind === "found";
    const canAnswer = isOwner && isWaiting && !!approvalId && !!threadId && !isPending;

    let destination = "";

    if (input.use?.kind === "provider_key") {
        const provider = providerLabel(input.use.provider) ?? input.use.provider;

        destination = t`Will be saved as your ${provider} API key`;
    } else if (input.use?.kind === "mcp_header") {
        const { header, server: serverName } = input.use;

        switch (server?.kind) {
            case "ambiguous": {
                destination = t`More than one of your MCP servers is named ${serverName}. Rename one in Settings first, or decline.`;

                break;
            }
            case "failed": {
                destination = t`Set as the ${header} header on your ${serverName} MCP server`;

                break;
            }
            case "found": {
                const { address } = server;

                destination = t`Set as the ${header} header on your ${serverName} MCP server (${address})`;

                break;
            }
            case "missing": {
                destination = t`You have no saved MCP server named ${serverName}. Add it in Settings first, or decline.`;

                break;
            }
            default: {
                destination = t`Set as the ${header} header on your ${serverName} MCP server`;
            }
        }
    }

    const send = (reply: Submitted) => {
        if (!approvalId || !threadId) {
            return;
        }

        const value = reply === "save" ? draft.trim() : null;

        if (value !== null && value.length > valueMax) {
            return;
        }

        // The address the card displayed: the server refuses the save if the saved server has moved since.
        const expectedUrl = value !== null && server?.kind === "found" ? server.url : undefined;

        // Cleared before the call returns: the value lives in this component for no longer than the keystrokes.
        setDraft("");
        setSaveError(null);
        setSubmitted(reply);
        groupRef.current?.focus();
        mutate(
            { approvalId, ...(expectedUrl !== undefined && { expectedUrl }), threadId: threadId as Id<"threads">, value },
            {
                onError: (error) => {
                    setSubmitted(null);

                    if ((error as { data?: { code?: string } }).data?.code === "TOOL_REQUEST_ABANDONED") {
                        setClosed(true);

                        return;
                    }

                    // The saved server's address moved since the card showed it: the card's copy is stale, so load the current one.
                    if ((error as { data?: { code?: string } }).data?.code === "SECRET_SERVER_MOVED") {
                        setSaveError(t`This server's address changed. Check the address below and save again.`);
                        void retryPreferences();

                        return;
                    }

                    setSaveError(reply === "save" ? t`It was not saved. Paste it again and save.` : t`Could not answer. Please try again.`);
                },
                // The mutation's own copy of the arguments goes too.
                onSettled: () => reset(),
            },
        );
    };

    const onSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (draft.trim().length > 0 && !tooLong && canAnswer && destinationReady) {
            send("save");
        }
    };

    let statusText: string;

    if (part.state === "output-denied" || submitted === "decline") {
        statusText = t`Declined — continuing without it`;
    } else if (part.state === "output-available") {
        statusText = t`Saved — the assistant can use it once, in this reply`;
    } else if (submitted || part.state === "approval-responded") {
        statusText = t`Saved — continuing`;
    } else if (closed) {
        statusText = t`Closed — the conversation moved on. Ask again in the chat.`;
    } else if (part.state === "input-streaming" || part.state === "input-available") {
        statusText = t`Preparing a request…`;
    } else {
        statusText = isOwner ? t`Waiting for you` : t`Waiting for the owner`;
    }

    return (
        <div
            aria-labelledby={headingId}
            className="bg-muted/40 focus-visible:ring-ring mb-4 rounded-lg border p-3 outline-none focus-visible:ring-2"
            ref={groupRef}
            role="group"
            tabIndex={-1}
        >
            <div className="flex items-start gap-2">
                <KeyRound aria-hidden="true" className="text-primary mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium" id={headingId}>
                        {label || t`The assistant needs a secret`}
                    </p>
                    {input.purpose && <p className="text-muted-foreground text-sm">{input.purpose}</p>}
                    {destination && (
                        <p className="text-muted-foreground text-xs" id={destinationId}>
                            {destination}
                        </p>
                    )}
                    <p aria-live="polite" className="text-muted-foreground text-xs" role="status">
                        {statusText}
                    </p>
                </div>
            </div>

            {canAnswer && (
                // `ph-no-capture` keeps the field out of PostHog's autocapture and recordings.
                <form className="ph-no-capture mt-3 flex flex-col gap-2" onSubmit={onSubmit}>
                    <label className="sr-only" htmlFor={valueId}>
                        {label || t`Secret`}
                    </label>
                    <Input
                        aria-describedby={
                            [
                                destination ? destinationId : "",
                                tooLong ? tooLongId : "",
                                saveError ? saveErrorId : "",
                                server?.kind === "failed" ? loadErrorId : "",
                            ]
                                .filter(Boolean)
                                .join(" ") || undefined
                        }
                        aria-invalid={tooLong || saveError !== null || server?.kind === "failed" || undefined}
                        autoComplete="new-password"
                        autoCorrect="off"
                        id={valueId}
                        maxLength={HEADER_VALUE_MAX}
                        name="requested-secret"
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={t`Paste it here — it is not shown in the chat`}
                        size="sm"
                        spellCheck={false}
                        type="password"
                        value={draft}
                    />
                    {server?.kind === "failed" && (
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-destructive text-xs" id={loadErrorId} role="alert">
                                {t`Your saved MCP servers could not be loaded, so this cannot be saved yet.`}
                            </p>
                            <Button disabled={preferencesFetching} onClick={() => retryPreferences()} size="sm" type="button" variant="outline">
                                {t`Retry`}
                            </Button>
                        </div>
                    )}
                    {saveError && (
                        <p className="text-destructive text-xs" id={saveErrorId} role="alert">
                            {saveError}
                        </p>
                    )}
                    {tooLong && (
                        <p className="text-destructive text-xs" id={tooLongId} role="alert">
                            {t`This is too long: up to ${valueMax} characters.`}
                        </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={draft.trim().length === 0 || tooLong || !destinationReady} size="sm" type="submit">
                            <KeyRound aria-hidden="true" />
                            {t`Save`}
                        </Button>
                        <Button onClick={() => send("decline")} size="sm" type="button" variant="ghost">
                            <X aria-hidden="true" />
                            {t`Decline`}
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
};

export default RequestSecretPrompt;
