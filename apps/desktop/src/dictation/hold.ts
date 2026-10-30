/** The shortcut that starts a dictation (temporary, with the `NEORE_DICTATION` flag). It is held down while speaking. */
// eslint-disable-next-line no-secrets/no-secrets -- a keyboard accelerator, not a credential
export const DICTATION_SHORTCUT = "CommandOrControl+Shift+D";

/** The keys of the chord, as `KeyboardEvent.key` values lower-cased. Letting go of any of them is the release. */
const CHORD_KEYS = new Set(["control", "d", "meta", "shift"]);

export interface InputLike {
    key: string;
    type: string;
}

/** Called for every key the focused dictation window sees (`before-input-event`). */
export const isChordRelease = (input: InputLike): boolean => input.type === "keyUp" && CHORD_KEYS.has(input.key.toLowerCase());

export const isCancel = (input: InputLike): boolean => input.type === "keyDown" && input.key === "Escape";
