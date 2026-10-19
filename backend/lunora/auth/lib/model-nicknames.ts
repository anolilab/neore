/**
 * The user's own names for models (`userSettings.modelNicknames`, model id →
 * nickname). The settings write (`auth/functions.ts`) normalises with
 * `normalizeModelNicknames`; pinned by `model-nicknames.test.ts`.
 */

/** Nicknames the user may keep; each is a short label, so this is generous. */
export const MAX_MODEL_NICKNAMES = 200;

/** A nickname is a label in a picker row, not a description. */
export const MAX_MODEL_NICKNAME_LENGTH = 60;

const WHITESPACE_RE = /\s+/g;

/**
 * Collapses whitespace runs (newlines and tabs included) to single spaces and
 * trims. An entry left empty drops, which is how a client clears a nickname.
 */
export const normalizeModelNicknames = (nicknames: Readonly<Record<string, string>>): Record<string, string> => {
    const normalised: Record<string, string> = {};

    for (const [modelId, nickname] of Object.entries(nicknames)) {
        // Keys are looked up by exact model id, so a padded key must be stored trimmed or it can never be shown or cleared.
        const id = modelId.trim();
        const cleaned = nickname.replaceAll(WHITESPACE_RE, " ").trim();

        if (cleaned !== "" && id !== "") {
            normalised[id] = cleaned;
        }
    }

    return normalised;
};
