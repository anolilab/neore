/**
 * Pure helpers that turn a chat message and a resolved skill into the run's
 * settings. No Lunora imports, so they are unit-tested directly.
 */
import { MAX_SLUG_LENGTH, SLUG_REGEX } from "./constants";

const WHITESPACE_RE = /\s/;

export interface SkillCommand {
    rawArgs: string;
    slug: string;
}

/**
 * The composer's skill menu inserts `/<slug> ` at the start of the message, so a
 * skill invocation is a message whose first token is `/<valid slug>`. Anything
 * else — `/` mid-sentence, a path like `/usr/bin`, a malformed slug — is an
 * ordinary message.
 */
export const parseSkillCommand = (text: string): SkillCommand | null => {
    const trimmed = text.trim();

    if (!trimmed.startsWith("/")) {
        return null;
    }

    // `/slug` runs to the first whitespace; everything after it is the arguments.
    const end = trimmed.search(WHITESPACE_RE);
    const slug = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);

    if (slug.length > MAX_SLUG_LENGTH || !SLUG_REGEX.test(slug)) {
        return null;
    }

    return { rawArgs: end === -1 ? "" : trimmed.slice(end).trim(), slug };
};

export interface SkillModelCandidate {
    enabled?: boolean;
    mode?: string;
    provider?: string;
}

/**
 * The model a skill run uses. A skill's `preferredModel` wins only when it is a
 * platform text model the caller could have picked anyway:
 *
 * - anonymous callers are pinned to the free model by `/chat/start`, and a skill
 *   must not lift that pin;
 * - a `custom:` id names the skill OWNER's endpoint, which the caller cannot use
 *   (and which resolves against the caller's own providers, so it would fail);
 * - an unknown, disabled, listed-only or non-text model would break the run.
 */
export const resolveSkillModel = (
    requestedModel: string,
    preferredModel: string | undefined,
    lookup: (modelId: string) => SkillModelCandidate | undefined,
    isAnonymous: boolean,
): string => {
    if (!preferredModel || isAnonymous || preferredModel.startsWith("custom:")) {
        return requestedModel;
    }

    const definition = lookup(preferredModel);

    if (!definition || definition.enabled === false || definition.provider === "external" || (definition.mode !== undefined && definition.mode !== "text")) {
        return requestedModel;
    }

    return preferredModel;
};

/** A persisted user message's content: plain text or AI SDK parts. */
type MessageContent = string | ReadonlyArray<{ text?: unknown; type?: unknown }> | null | undefined;

/**
 * Find the skill command in what the user TYPED. `message.text` is not that:
 * `/chat/start` puts extracted attachment text in front of the typed text, so
 * `/<slug>` is no longer at its start. In order of trust:
 *
 * 1. the raw composer text from the start payload, when the run has it;
 * 2. the message's text parts — attachment parts always open with a
 *    `[Document: …]` label, so only the typed part can start with `/<slug>`;
 * 3. the concatenated text, for a message with neither.
 */
export const findSkillCommand = (typedPrompt: string | undefined, content: MessageContent, fallbackText: string): SkillCommand | null => {
    if (typedPrompt !== undefined) {
        return parseSkillCommand(typedPrompt);
    }

    if (typeof content === "string") {
        return parseSkillCommand(content);
    }

    if (Array.isArray(content)) {
        for (const part of content) {
            const command = part.type === "text" && typeof part.text === "string" ? parseSkillCommand(part.text) : null;

            if (command) {
                return command;
            }
        }

        return null;
    }

    return parseSkillCommand(fallbackText);
};

/**
 * The reasoning effort a run uses. Without an invoked skill this is the existing
 * rule (the thread's stored setting, else the message's). With one, the user's
 * explicit per-message choice still wins, and the skill's default beats only the
 * thread's stored setting. Whether the model supports reasoning at all is
 * decided later, by `buildReasoningProviderOptions`.
 */
export const resolveReasoningEffort = ({
    messageEffort,
    skillEffort,
    threadEffort,
}: {
    messageEffort?: number;
    skillEffort?: number;
    threadEffort?: number;
}): number | undefined => {
    if (skillEffort === undefined) {
        return threadEffort ?? messageEffort;
    }

    return messageEffort ?? skillEffort;
};
