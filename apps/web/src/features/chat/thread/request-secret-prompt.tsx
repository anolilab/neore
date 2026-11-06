"use client";

/**
 * RequestSecretPrompt — a `requestSecret` tool call: the agent paused mid-run to
 * ask the user for a secret (`backend/lunora/chat/tools/request-secret.ts`).
 *
 * The card shows what is asked for, why, and where the value will go. While the
 * call waits (`approval-requested`) the owner types the value into a password
 * field (one per secret the request lists, each with a show/hide toggle) and
 * saves it, or declines. A format the request declares is checked here before
 * anything is sent; the server checks it again. The values go to the server in
 * one call (`answerSecretRequest`) that stores each encrypted and resumes the run
 * with only opaque references: they are cleared from this component the moment
 * they are sent, are never shown again, and are kept out of analytics capture.
 *
 * Only the thread owner can answer: the value is stored for them and used with
 * their keys and servers. Anyone else sees the request read-only.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { SecretFormat } from "@neore/backend/request-secret-limits";
import {
    SECRET_HEADER_VALUE_MAX as HEADER_VALUE_MAX,
    SECRET_PROVIDER_KEY_MAX as PROVIDER_KEY_MAX,
    secretFormatProblem,
} from "@neore/backend/request-secret-limits";
import type { ToolPart } from "@neore/chat-ui/types";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound, X } from "lucide-react";
import type { FC, FormEvent } from "react";
import { useId, useRef, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useCRPC } from "@/lib/lunora/crpc";

import { providerLabel } from "./rate-limit-pause";

type SecretUse = { header: string; kind: "mcp_header"; server: string } | { kind: "provider_key"; provider: string };

type Server = { address: string; kind: "found"; url: string } | { kind: "ambiguous" } | { kind: "failed" } | { kind: "loading" } | { kind: "missing" };

interface RequestedField {
    format?: SecretFormat;
    label?: string;
    name?: string;
    use?: SecretUse;
}

interface RequestSecretInput {
    fields?: RequestedField[];
    format?: SecretFormat;
    label?: string;
    purpose?: string;
    use?: SecretUse;
}

/** The secrets the call asks for: its `fields`, or the one destination of a plain request. */
const requestedFields = (input: RequestSecretInput): RequestedField[] =>
    Array.isArray(input.fields) ? input.fields : [{ format: input.format, label: input.label, use: input.use }];

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
    const fieldId = useId();
    const saveErrorId = useId();
    const loadErrorId = useId();
    const [drafts, setDrafts] = useState<string[]>([]);
    // Which fields are shown as plain text; hidden again once the answer is sent.
    const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
    // Fields the person has left: a format problem is shown only then, so typing a value is not announced one keystroke at a time.
    const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set());
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
    const fields = requestedFields(input);
    const several = Array.isArray(input.fields);
    const approvalId = part.approval?.id;
    // A public viewer's thread copy has no `userId`, so it never matches.
    const isOwner = !!thread?.userId && thread.userId === sessionData?.user?.id;
    const isWaiting = part.state === "approval-requested" && submitted === null && !closed;
    const usesServer = fields.some((field) => field.use?.kind === "mcp_header");
    // Only the owner's servers are the destination, and only the owner's card needs them: for anyone else (a
    // collaborator, a public view) the query never runs. For the owner it is the one the composer and Settings read.
    const {
        data: preferences,
        isError: preferencesFailed,
        errorUpdateCount: preferenceFailures,
        isFetching: preferencesFetching,
        isSuccess: preferencesLoaded,
        refetch: retryPreferences,
    } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions(isOwner && isWaiting && usesServer ? {} : skipToken));
    // A user who never saved a server has no `mcpServers` (or no row at all): once the read has answered, that is an empty list, not "still loading".
    const savedServers = preferences?.mcpServers ?? (preferencesLoaded ? [] : undefined);
    const servers = fields.map((field) =>
        field.use?.kind === "mcp_header" && isOwner ? resolveServer(savedServers, field.use.server, preferencesFailed) : undefined,
    );
    // A retry with nothing cached puts the query back to loading; the failure line and its button stay through it, so focus is not lost and the wait is announced.
    const loadFailureShown = servers.some(
        (server) => server?.kind === "failed" || (server?.kind === "loading" && preferencesFetching && preferenceFailures > 0),
    );
    const valueMaxOf = (field: RequestedField) => (field.use?.kind === "provider_key" ? PROVIDER_KEY_MAX : HEADER_VALUE_MAX);
    const draftOf = (index: number) => (drafts[index] ?? "").trim();
    // Checked before anything is sent: the card clears the drafts once they go, and the server would refuse them after that.
    const tooLong = fields.map((field, index) => draftOf(index).length > valueMaxOf(field));
    const formatProblems = fields.map((field, index) => (draftOf(index).length > 0 ? secretFormatProblem(draftOf(index), field.format) : undefined));
    // A header goes to one saved server, found by name when the answer arrives: without exactly one the server refuses it.
    const destinationReady = servers.every((server) => server === undefined || server.kind === "found");
    const canAnswer = isOwner && isWaiting && !!approvalId && !!threadId && !isPending;
    const complete = fields.every((_field, index) => draftOf(index).length > 0);
    const valid = complete && !tooLong.includes(true) && formatProblems.every((problem) => problem === undefined);

    const destinationOf = (field: RequestedField, server: Server | undefined): string => {
        const { use } = field;

        if (use?.kind === "provider_key") {
            const provider = providerLabel(use.provider) ?? use.provider;

            return t`Will be saved as your ${provider} API key`;
        }

        if (use?.kind !== "mcp_header") {
            return "";
        }

        const { header, server: serverName } = use;

        switch (server?.kind) {
            case "ambiguous": {
                return t`More than one of your MCP servers is named ${serverName}. Rename one in Settings first, or decline.`;
            }
            case "found": {
                const { address } = server;

                return t`Set as the ${header} header on your ${serverName} MCP server (${address})`;
            }
            case "missing": {
                return t`You have no saved MCP server named ${serverName}. Add it in Settings first, or decline.`;
            }
            default: {
                return t`Set as the ${header} header on your ${serverName} MCP server`;
            }
        }
    };

    // The rule a value must meet, shown as help text before anything is typed, so a disabled Save has a visible reason.
    const ruleOf = (format: SecretFormat | undefined): string | undefined => {
        const prefix = format?.prefix;
        const minLength = format?.minLength;

        if (prefix !== undefined && minLength !== undefined) {
            return t`Starts with ${prefix}, at least ${minLength} characters`;
        }

        if (prefix !== undefined) {
            return t`Starts with ${prefix}`;
        }

        return minLength === undefined ? undefined : t`At least ${minLength} characters`;
    };

    const formatMessageOf = (field: RequestedField, problem: "min_length" | "prefix" | undefined): string => {
        if (problem === "prefix") {
            const prefix = field.format?.prefix ?? "";

            return t`This does not look right: it must start with ${prefix}.`;
        }

        if (problem === "min_length") {
            const minLength = field.format?.minLength ?? 0;

            return t`This is too short: at least ${minLength} characters.`;
        }

        return "";
    };

    const setDraft = (index: number, value: string) => setDrafts((current) => Object.assign([...current], { [index]: value }));

    const toggleReveal = (index: number) =>
        setRevealed((current) => {
            const next = new Set(current);

            if (!next.delete(index)) {
                next.add(index);
            }

            return next;
        });

    const send = (reply: Submitted) => {
        if (!approvalId || !threadId) {
            return;
        }

        const values = reply === "save" ? fields.map((_field, index) => draftOf(index)) : null;

        if (values !== null && (!valid || !destinationReady)) {
            return;
        }

        // The address each card field displayed: the server refuses a header save if the saved server has moved since (empty when there is no server to name).
        const urlOf = (index: number) => {
            const server = servers[index];

            return values !== null && server?.kind === "found" ? server.url : "";
        };
        const more =
            values === null
                ? []
                : values.slice(1).map((value, index) => {
                      return { expectedUrl: urlOf(index + 1), value };
                  });

        // Cleared before the call returns: the values live in this component for no longer than the keystrokes.
        setDrafts([]);
        setRevealed(new Set());
        // A retyped value is named again only once the person leaves its field, as the first one was.
        setTouched(new Set());
        setSaveError(null);
        setSubmitted(reply);
        groupRef.current?.focus();
        mutate(
            { approvalId, expectedUrl: urlOf(0), ...(more.length > 0 && { more }), threadId: threadId as Id<"threads">, value: values?.[0] ?? null },
            {
                onError: (error) => {
                    setSubmitted(null);

                    const code = (error as { data?: { code?: string } }).data?.code;

                    if (code === "TOOL_REQUEST_ABANDONED") {
                        setClosed(true);

                        return;
                    }

                    // The saved server's address moved since the card showed it: the card's copy is stale, so load the current one.
                    if (code === "SECRET_SERVER_MOVED") {
                        setSaveError(t`This server's address changed. Check the address below and save again.`);
                        void retryPreferences();

                        return;
                    }

                    if (code === "SECRET_FORMAT_INVALID") {
                        // The server names the refused field by its index in the request.
                        const refusedIndex = (error as { data?: { field?: unknown } }).data?.field;
                        const refusedLabel = typeof refusedIndex === "number" ? fields[refusedIndex]?.label : undefined;

                        setSaveError(
                            refusedLabel
                                ? t`${refusedLabel} does not have the format this request asks for, so nothing was saved. Enter it again.`
                                : t`A value does not have the format this request asks for, so nothing was saved. Check it and enter it again.`,
                        );

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

        if (valid && canAnswer && destinationReady) {
            send("save");
        }
    };

    let statusText: string;

    if (part.state === "output-denied" || submitted === "decline") {
        statusText = t`Declined — continuing without it`;
    } else if (part.state === "output-available") {
        statusText = several ? t`Saved — the assistant can use each once, in this reply` : t`Saved — the assistant can use it once, in this reply`;
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
                    {!several && destinationOf(fields[0] ?? {}, servers[0]) && (
                        <p className="text-muted-foreground text-xs" id={`${fieldId}-0-destination`}>
                            {destinationOf(fields[0] ?? {}, servers[0])}
                        </p>
                    )}
                    <p aria-live="polite" className="text-muted-foreground text-xs" role="status">
                        {statusText}
                    </p>
                </div>
            </div>

            {several && fields.some((field, index) => destinationOf(field, servers[index])) && (
                // Outside the form, so the destinations stay on the card after the answer is sent or when it cannot be answered.
                <ul className="text-muted-foreground mt-3 flex flex-col gap-0.5 text-xs">
                    {fields.map((field, index) => {
                        const destination = destinationOf(field, servers[index]);

                        return destination ? (
                            <li id={`${fieldId}-${index}-destination`} key={field.name ?? index}>
                                {field.label || label || t`Secret`} · {destination}
                            </li>
                        ) : null;
                    })}
                </ul>
            )}

            {canAnswer && (
                // `ph-no-capture` keeps the fields out of PostHog's autocapture and recordings.
                <form className="ph-no-capture mt-3 flex flex-col gap-3" onSubmit={onSubmit}>
                    {fields.map((field, index) => {
                        const inputId = `${fieldId}-${index}`;
                        const destination = destinationOf(field, servers[index]);
                        const formatMessage = touched.has(index) ? formatMessageOf(field, formatProblems[index]) : undefined;
                        const rule = ruleOf(field.format);
                        const valueMax = valueMaxOf(field);
                        const fieldLabel = field.label || label || t`Secret`;
                        const shown = revealed.has(index);
                        const describedBy = [
                            destination ? `${inputId}-destination` : "",
                            tooLong[index] === true ? `${inputId}-too-long` : "",
                            rule ? `${inputId}-rule` : "",
                            formatMessage ? `${inputId}-format` : "",
                            saveError ? saveErrorId : "",
                            loadFailureShown ? loadErrorId : "",
                        ]
                            .filter(Boolean)
                            .join(" ");

                        return (
                            <div className="flex flex-col gap-1" key={field.name ?? "secret"}>
                                <label className={several ? "text-sm font-medium" : "sr-only"} htmlFor={inputId}>
                                    {fieldLabel}
                                </label>
                                <div className="flex items-center gap-1">
                                    <Input
                                        aria-describedby={describedBy || undefined}
                                        aria-invalid={tooLong[index] || !!formatMessage || saveError !== null || loadFailureShown || undefined}
                                        aria-required="true"
                                        autoCapitalize="off"
                                        autoComplete="new-password"
                                        autoCorrect="off"
                                        id={inputId}
                                        maxLength={HEADER_VALUE_MAX}
                                        name={`requested-secret-${field.name ?? "value"}`}
                                        onBlur={() => setTouched((previous) => (previous.has(index) ? previous : new Set(previous).add(index)))}
                                        onChange={(event) => setDraft(index, event.target.value)}
                                        placeholder={t`Paste it here — it is not shown in the chat`}
                                        size="sm"
                                        spellCheck={false}
                                        type={shown ? "text" : "password"}
                                        value={drafts[index] ?? ""}
                                    />
                                    <Button
                                        aria-label={shown ? t`Hide ${fieldLabel}` : t`Show ${fieldLabel}`}
                                        aria-pressed={shown}
                                        onClick={() => toggleReveal(index)}
                                        size="icon-sm"
                                        type="button"
                                        variant="ghost"
                                    >
                                        {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                                    </Button>
                                </div>
                                {tooLong[index] && (
                                    <p className="text-destructive text-xs" id={`${inputId}-too-long`} role="alert">
                                        {t`This is too long: up to ${valueMax} characters.`}
                                    </p>
                                )}
                                {rule && (
                                    <p className="text-muted-foreground text-xs" id={`${inputId}-rule`}>
                                        {rule}
                                    </p>
                                )}
                                {formatMessage && (
                                    <p className="text-destructive text-xs" id={`${inputId}-format`} role="alert">
                                        {formatMessage}
                                    </p>
                                )}
                            </div>
                        );
                    })}
                    {loadFailureShown && (
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-destructive text-xs" id={loadErrorId} role="alert">
                                {t`Your saved MCP servers could not be loaded, so this cannot be saved yet.`}
                            </p>
                            <Button
                                aria-busy={preferencesFetching || undefined}
                                disabled={preferencesFetching}
                                onClick={() => retryPreferences()}
                                size="sm"
                                type="button"
                                variant="outline"
                            >
                                {t`Retry`}
                            </Button>
                            <span aria-live="polite" className="text-muted-foreground text-xs" role="status">
                                {preferencesFetching ? t`Loading…` : ""}
                            </span>
                        </div>
                    )}
                    {saveError && (
                        <p className="text-destructive text-xs" id={saveErrorId} role="alert">
                            {saveError}
                        </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={!valid || !destinationReady} size="sm" type="submit">
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
