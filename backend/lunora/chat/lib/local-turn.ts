/**
 * Pure helpers for persisting a turn the user's BROWSER ran against a
 * `local-browser` endpoint (Ollama / LM Studio on loopback). The server never
 * saw the generation, so everything here treats the reply as the client's
 * claim: text only, bounded, no usage (so nothing is billed), and marked
 * `provider: "local-browser"` so a reader can tell it apart from a run we made.
 *
 * The procedure is `chat/local-models.ts:saveLocalTurn`.
 */
import { parseCustomModelId } from "@neore/ai/models";

import { isLocalBrowserProvider, type StoredCustomProvider } from "./custom-providers";

/** The `provider` stamped on every assistant row a local turn saves. */
export const LOCAL_BROWSER_PROVIDER = "local-browser";

export const MAX_LOCAL_PROMPT_CHARS = 100_000;
export const MAX_LOCAL_REPLY_CHARS = 200_000;
export const MAX_LOCAL_ERROR_CHARS = 500;

const TITLE_MAX_CHARS = 60;
const WHITESPACE_RE = /\s+/g;

/** How the browser's stream ended. */
export type LocalTurnOutcome = "aborted" | "complete" | "failed";

/**
 * A new local thread's title, straight from the prompt. Deliberately NOT the
 * server-side title generator: that sends the prompt to a hosted model, and
 * someone who chose a local model may have chosen it to keep the text off one.
 */
export const deriveLocalThreadTitle = (prompt: string): string => {
    const collapsed = prompt.replaceAll(WHITESPACE_RE, " ").trim();

    if (!collapsed) {
        return "Local chat";
    }

    return collapsed.length > TITLE_MAX_CHARS ? `${collapsed.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : collapsed;
};

/**
 * Resolve `custom:<providerId>/<modelId>` against the caller's own endpoints.
 * Only an enabled `local-browser` endpoint that lists the model qualifies — a
 * save for a server-side model would let the client write replies we never
 * generated under a platform model's name.
 */
export const resolveLocalModel = (
    model: string,
    providers: Readonly<Record<string, StoredCustomProvider>>,
): { error: string } | { modelId: string; providerId: string } => {
    const parsed = parseCustomModelId(model);

    if (!parsed) {
        return { error: "Not a custom endpoint model" };
    }

    const provider = providers[parsed.providerId];

    if (!provider?.enabled || !isLocalBrowserProvider(provider.type)) {
        return { error: "Local endpoint not found or disabled" };
    }

    if ((provider.models ?? []).every((entry) => entry.id !== parsed.modelId)) {
        return { error: "That model is not listed on the local endpoint" };
    }

    return parsed;
};

export interface LocalTurnInput {
    error?: string;
    modelId: string;
    outcome: LocalTurnOutcome;
    prompt: string;
    reasoning?: string;
    reply: string;
}

/** The user row of a local turn. */
export const buildLocalPromptMessage = (prompt: string) => {
    return {
        message: { content: prompt, role: "user" as const },
        status: "success" as const,
    };
};

/**
 * The assistant row of a local turn. A failed stream keeps whatever text
 * arrived and records the error; an aborted one is a normal reply that ended
 * early.
 */
export const buildLocalReplyMessage = (input: LocalTurnInput) => {
    const reply = input.reply.slice(0, MAX_LOCAL_REPLY_CHARS);
    const reasoning = input.reasoning?.trim() ? input.reasoning.slice(0, MAX_LOCAL_REPLY_CHARS) : undefined;
    const failed = input.outcome === "failed";
    let finishReason: "error" | "other" | "stop" = "stop";

    if (failed) {
        finishReason = "error";
    } else if (input.outcome === "aborted") {
        finishReason = "other";
    }

    return {
        ...(failed && { error: (input.error?.trim() || "The local model stopped with an error").slice(0, MAX_LOCAL_ERROR_CHARS) }),
        finishReason,
        message: { content: reply ? [{ text: reply, type: "text" as const }] : [], role: "assistant" as const },
        model: input.modelId,
        provider: LOCAL_BROWSER_PROVIDER,
        // Nothing here bills: credits are deducted by the gateway when it
        // proxies a call, and the per-message cost the UI shows is read
        // from gateway-written metadata (`neoreGateway`) this row never
        // gets. Set server-side, never from client input.
        providerMetadata: { neore: { billed: false, runtime: LOCAL_BROWSER_PROVIDER } },
        ...(reasoning && { reasoning }),
        status: failed ? ("failed" as const) : ("success" as const),
    };
};

/**
 * The two rows a local turn saves: the user prompt, then the assistant reply
 * in the same `order` (`addMessagesHandler` puts a non-user row at the next
 * `stepOrder`).
 */
export const buildLocalTurnMessages = (input: LocalTurnInput) => [buildLocalPromptMessage(input.prompt), buildLocalReplyMessage(input)];
