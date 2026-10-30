import { clampText, MAX_COMPOSE_CHARS } from "../site.js";

export interface InsertDependencies {
    /** Can the main window put text in its composer right now? False when it is closed or on a sign-in screen. */
    canTakeDraft: () => boolean;
    /** The existing draft channel: opens a new chat with the text in the composer and sends nothing. */
    handOffDraft: (text: string) => void;
    notify: (title: string, body: string) => void;
    writeClipboard: (text: string) => void;
}

/** The dictated text goes to the composer as a draft; where it cannot, it is copied and the person is told. */
export const insertDictation = (dependencies: InsertDependencies, text: string): "clipboard" | "composer" => {
    const clamped = clampText(text, MAX_COMPOSE_CHARS);

    if (dependencies.canTakeDraft()) {
        dependencies.handOffDraft(clamped);

        return "composer";
    }

    dependencies.writeClipboard(clamped);
    dependencies.notify("Dictation", "Neore has no chat open to put it in, so the text is on your clipboard.");

    return "clipboard";
};
