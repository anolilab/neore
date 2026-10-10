/**
 * End-of-utterance detection on top of a dictation engine's events.
 *
 * Both engines already segment on pauses: Scribe commits with
 * `commit_strategy=vad`, the Web Speech API marks results `isFinal`. A commit
 * alone is too eager — a speaker taking a breath mid-sentence gets cut off —
 * so a commit starts a short GRACE timer, and any further speech (a new
 * partial or another commit) restarts it. When the timer runs out the
 * collected segments are one utterance.
 *
 * The timer functions are injectable so the timing is testable without a
 * browser.
 */

export const DEFAULT_UTTERANCE_GRACE_MS = 1200;

export interface UtteranceDetectorOptions {
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
    /** How long to wait after a commit for more speech. */
    graceMs?: number;
    /** The live transcript, for showing in the composer while the user speaks. */
    onTranscript?: (text: string) => void;
    /** Fired once, with the whole utterance. */
    onUtterance: (text: string) => void;
    setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

export interface UtteranceDetector {
    /** A segment was finalised by the engine. */
    commit: (text: string) => void;
    /** Stops the timer; no utterance fires after this. */
    dispose: () => void;
    /** Ends the utterance now with whatever was heard (e.g. the engine ended its session). */
    flush: () => void;
    /** The in-progress text changed. */
    partial: (text: string) => void;
}

const joinSegments = (segments: ReadonlyArray<string>): string =>
    segments
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join(" ");

export const createUtteranceDetector = ({
    clearTimer = clearTimeout,
    graceMs = DEFAULT_UTTERANCE_GRACE_MS,
    onTranscript,
    onUtterance,
    setTimer = setTimeout,
}: UtteranceDetectorOptions): UtteranceDetector => {
    const committed: string[] = [];
    let partial = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const cancelTimer = () => {
        if (timer === undefined) {
            return;
        }

        clearTimer(timer);
        timer = undefined;
    };

    const current = () => joinSegments([...committed, partial]);

    const finish = () => {
        if (done) {
            return;
        }

        const text = current();

        // Nothing heard yet: keep listening rather than ending an empty utterance.
        if (!text) {
            return;
        }

        done = true;
        cancelTimer();
        onUtterance(text);
    };

    const armTimer = () => {
        cancelTimer();

        if (committed.length > 0) {
            timer = setTimer(finish, graceMs);
        }
    };

    return {
        commit: (text) => {
            if (done) {
                return;
            }

            if (text.trim()) {
                committed.push(text);
            }

            partial = "";
            onTranscript?.(current());
            armTimer();
        },
        dispose: () => {
            done = true;
            cancelTimer();
        },
        flush: finish,
        partial: (text) => {
            if (done) {
                return;
            }

            partial = text;
            onTranscript?.(current());

            // Still talking: hold the utterance open.
            if (text.trim()) {
                cancelTimer();
            } else {
                armTimer();
            }
        },
    };
};
