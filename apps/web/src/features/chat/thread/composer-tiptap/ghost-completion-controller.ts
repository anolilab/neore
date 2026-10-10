/**
 * Composer ghost text — the framework-free part: when a completion may be
 * requested, the debounce, stale-response handling and the clean-up of what
 * comes back. The tiptap extension (`extensions/ghost-completion.ts`) only
 * draws and accepts; `composer-tiptap-editor.tsx` feeds this controller.
 *
 * Every change of the draft cancels what is pending: the timer, and the
 * request in flight (its answer is dropped by sequence number, and its
 * `AbortSignal` fires). So a suggestion is only ever shown for the exact text
 * it was asked for.
 */

/** Pause in typing before a completion is requested. */
export const GHOST_DEBOUNCE_MS = 500;

/** Shorter drafts give the model too little to go on (the backend refuses them too). */
export const GHOST_MIN_CHARS = 12;

/** Only the tail of the draft is sent; the backend keeps the same amount. */
export const GHOST_MAX_CONTEXT_CHARS = 1500;

/** The live-region announcement is repeated at most this often. */
export const GHOST_ANNOUNCE_INTERVAL_MS = 60_000;

const LINE_BREAK = /\r?\n/u;
const TRAILING_WHITESPACE = /\s$/u;
const WHITESPACE = /\s/u;

/** An unfinished `@mention`, `/command` or `{{variable` at the end of the draft. */
const endsInTrigger = (text: string): boolean => {
    if (text.lastIndexOf("{{") > text.lastIndexOf("}}")) {
        return true;
    }

    let start = text.length;

    while (start > 0 && !WHITESPACE.test(text[start - 1] ?? "")) {
        start -= 1;
    }

    const lastToken = text.slice(start);

    return lastToken.startsWith("@") || lastToken.startsWith("/");
};

export interface GhostEligibility {
    /** The caret is collapsed at the very end of the draft. */
    caretAtEnd: boolean;
    disabled: boolean;
    /** The editor has focus. */
    focused: boolean;
    isStreaming: boolean;
    /** A slash-command, @-mention or variable popup is open. */
    popupOpen: boolean;
    text: string;
}

/** Whether the draft, as it stands, may get a ghost suggestion. */
export const isGhostEligible = ({ caretAtEnd, disabled, focused, isStreaming, popupOpen, text }: GhostEligibility): boolean => {
    if (disabled || isStreaming || popupOpen || !focused || !caretAtEnd) {
        return false;
    }

    if (text.trim().length < GHOST_MIN_CHARS) {
        return false;
    }

    // Slash commands own the whole draft; mentions and variables own its end.
    return !text.trimStart().startsWith("/") && !endsInTrigger(text);
};

/** The part of the draft that is sent. */
export const ghostContext = (text: string): string => (text.length > GHOST_MAX_CONTEXT_CHARS ? text.slice(-GHOST_MAX_CONTEXT_CHARS) : text);

/**
 * A completion reduced to what may be shown after `text`, or `null`. The
 * backend already cleans it; this is the client's own guarantee of one line
 * and no doubled space.
 */
export const normalizeGhost = (text: string, completion: string | null | undefined): string | null => {
    if (!completion) {
        return null;
    }

    let ghost = completion.split(LINE_BREAK)[0] ?? "";

    if (TRAILING_WHITESPACE.test(text)) {
        ghost = ghost.trimStart();
    }

    ghost = ghost.trimEnd();

    return ghost.trim() === "" ? null : ghost;
};

/** Whether the "suggestion available" announcement should be spoken now. */
export const shouldAnnounceGhost = (lastAnnouncedAt: number | null, now: number): boolean =>
    lastAnnouncedAt === null || now - lastAnnouncedAt >= GHOST_ANNOUNCE_INTERVAL_MS;

export type GhostRequest = (text: string, signal: AbortSignal) => Promise<string | null>;

export interface GhostControllerOptions {
    debounceMs?: number;
    /** Current draft, read when a response arrives to reject a stale one. */
    getText: () => string;
    /** A new suggestion (`string`) or none (`null`) for the draft as it stands. */
    onSuggestion: (suggestion: string | null) => void;
    request: GhostRequest;
}

export interface GhostController {
    dispose: () => void;
    /** Report the draft's current state; clears any ghost and (re)schedules a request. */
    update: (state: GhostEligibility) => void;
}

export const createGhostController = ({ debounceMs = GHOST_DEBOUNCE_MS, getText, onSuggestion, request }: GhostControllerOptions): GhostController => {
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | undefined;
    let disposed = false;

    const cancel = () => {
        sequence += 1;

        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }

        inFlight?.abort();
        inFlight = undefined;
    };

    const run = async (text: string, id: number) => {
        // The draft can change without an update (a programmatic clear after
        // submit): never spend a call on text that is already gone.
        if (getText() !== text) {
            return;
        }

        const controller = new AbortController();

        inFlight = controller;

        let completion: string | null;

        try {
            completion = await request(ghostContext(text), controller.signal);
        } catch {
            // A failed suggestion is simply no suggestion.
            completion = null;
        }

        if (disposed || id !== sequence || controller.signal.aborted || getText() !== text) {
            return;
        }

        inFlight = undefined;
        onSuggestion(normalizeGhost(text, completion));
    };

    return {
        dispose: () => {
            disposed = true;
            cancel();
        },
        update: (state) => {
            // Any change — a keystroke, a caret move, focus — drops the ghost and
            // what is pending: the ghost belongs to this text with the caret at its end.
            cancel();
            onSuggestion(null);

            if (disposed || !isGhostEligible(state)) {
                return;
            }

            const id = sequence;

            timer = setTimeout(() => {
                timer = undefined;
                void run(state.text, id);
            }, debounceMs);
        },
    };
};
