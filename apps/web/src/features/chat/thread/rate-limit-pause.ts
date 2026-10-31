/**
 * What the chat shows while a run waits out a provider's rate limit
 * (`backend/lunora/chat/lib/rate-limit-pause.ts`): the countdown text and who limited it.
 */
import { MODEL_REGISTRY } from "@neore/ai/models";

const INTERNAL_PREFIX = /^internal-/;
/** The announced time moves in steps of this many seconds, so a screen reader is not read every tick. */
const ANNOUNCE_STEP_SECONDS = 30;

/** `42_000` as `0:42`, `600_000` as `10:00`. Anything at or below zero is `0:00`. */
export const formatCountdown = (ms: number): string => {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));

    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
};

/**
 * The wait to read aloud: rounded UP to the next {@link ANNOUNCE_STEP_SECONDS}, so the text a polite live region holds
 * changes twice a minute instead of every second. Zero once the wait is over.
 */
export const announcedWaitMs = (remainingMs: number): number =>
    remainingMs <= 0 ? 0 : Math.ceil(remainingMs / (ANNOUNCE_STEP_SECONDS * 1000)) * ANNOUNCE_STEP_SECONDS * 1000;

const displayNames = new Map<string, string>();

for (const model of MODEL_REGISTRY) {
    const key = model.provider.replace(INTERNAL_PREFIX, "");

    if (model.displayProvider && !displayNames.has(key)) {
        displayNames.set(key, model.displayProvider);
    }
}

/** A provider key (`anthropic`) as people know it (`Anthropic`); the key itself, capitalised, for one the registry does not name. */
export const providerLabel = (provider: string | undefined): string | undefined => {
    if (!provider) {
        return undefined;
    }

    return displayNames.get(provider) ?? `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}`;
};
