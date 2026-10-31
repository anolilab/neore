/**
 * What an Enter chord does in the composer, from the user's `sendBehavior` preference.
 * Cmd/Ctrl+Enter sends in every mode.
 */
export type SendBehavior = "button" | "enter" | "shiftEnter";

export type EnterChord = "mod" | "plain" | "shift";

export type EnterAction = "newline" | "send";

export const resolveEnterAction = (behavior: SendBehavior, chord: EnterChord): EnterAction => {
    if (chord === "mod") {
        return "send";
    }

    if (chord === "plain") {
        return behavior === "enter" ? "send" : "newline";
    }

    return behavior === "shiftEnter" ? "send" : "newline";
};

/** The shortcut the Send button should advertise, or undefined when only the button sends. */
export const sendShortcutLabel = (behavior: SendBehavior): string | undefined => {
    if (behavior === "enter") {
        return "Enter";
    }

    return behavior === "shiftEnter" ? "Shift+Enter" : undefined;
};
