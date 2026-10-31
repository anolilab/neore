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
import { useMutation } from "@tanstack/react-query";
import { KeyRound, X } from "lucide-react";
import type { FC, FormEvent } from "react";
import { useId, useRef, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

/** Mirrors `SECRET_HEADER_VALUE_MAX` on the server; a provider key is capped lower there. */
const VALUE_MAX = 10_000;

type SecretUse = { header: string; kind: "mcp_header"; server: string } | { kind: "provider_key"; provider: string };

interface RequestSecretInput {
    label?: string;
    purpose?: string;
    use?: SecretUse;
}

type Submitted = "decline" | "save";

const PROVIDER_NAMES: Record<string, string> = {
    anthropic: "Anthropic",
    groq: "Groq",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    requesty: "Requesty",
    xai: "xAI",
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
    const [draft, setDraft] = useState("");
    const [submitted, setSubmitted] = useState<Submitted | null>(null);
    // Focus lands here after a send: the form (and the focused control) goes away.
    const groupRef = useRef<HTMLDivElement>(null);
    const { isPending, mutate, reset } = useMutation(crpc.chat.request_secret.answerSecretRequest.mutationOptions());

    const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as RequestSecretInput;
    const label = input.label ?? "";
    const approvalId = part.approval?.id;
    // A public viewer's thread copy has no `userId`, so it never matches.
    const isOwner = !!thread?.userId && thread.userId === sessionData?.user?.id;
    const isWaiting = part.state === "approval-requested" && submitted === null;
    const canAnswer = isOwner && isWaiting && !!approvalId && !!threadId && !isPending;

    let destination = "";

    if (input.use?.kind === "provider_key") {
        const provider = PROVIDER_NAMES[input.use.provider] ?? input.use.provider;

        destination = t`Saved as your ${provider} API key`;
    } else if (input.use?.kind === "mcp_header") {
        const { header, server } = input.use;

        destination = t`Set as the ${header} header on your ${server} MCP server`;
    }

    const send = (reply: Submitted) => {
        if (!approvalId || !threadId) {
            return;
        }

        const value = reply === "save" ? draft.trim() : null;

        // Cleared before the call returns: the value lives in this component for no longer than the keystrokes.
        setDraft("");
        setSubmitted(reply);
        groupRef.current?.focus();
        mutate(
            { approvalId, threadId: threadId as Id<"threads">, value },
            {
                onError: (error) => {
                    setSubmitted(null);
                    showError(error instanceof Error ? error : t`Could not save. Please try again.`);
                },
                // The mutation's own copy of the arguments goes too.
                onSettled: () => reset(),
            },
        );
    };

    const onSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (draft.trim().length > 0 && canAnswer) {
            send("save");
        }
    };

    let statusText: string;

    if (part.state === "output-denied" || submitted === "decline") {
        statusText = t`Declined — continuing without it`;
    } else if (part.state === "output-available") {
        statusText = t`Saved — the assistant can use it once`;
    } else if (submitted || part.state === "approval-responded") {
        statusText = t`Saved — continuing`;
    } else if (part.state === "input-streaming" || part.state === "input-available") {
        statusText = t`Preparing a request…`;
    } else {
        statusText = isOwner ? t`Waiting for you` : t`Waiting for the owner`;
    }

    return (
        <div aria-labelledby={headingId} className="bg-muted/40 mb-4 rounded-lg border p-3 outline-none" ref={groupRef} role="group" tabIndex={-1}>
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
                        aria-describedby={destination ? destinationId : undefined}
                        autoComplete="new-password"
                        autoCorrect="off"
                        id={valueId}
                        maxLength={VALUE_MAX}
                        name="requested-secret"
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={t`Paste it here — it is not shown in the chat`}
                        size="sm"
                        spellCheck={false}
                        type="password"
                        value={draft}
                    />
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={draft.trim().length === 0} size="sm" type="submit">
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
