/**
 * A blocked request inside the artifact preview violates TWO policies at once —
 * the shell's response CSP and the artifact's own `<meta>` CSP — and the
 * browser fires one `securitypolicyviolation` per policy. The console bridge
 * formats both into the same text (directive + blocked URI), so an identical
 * violation seen again within a short window is the same block, reported twice.
 */

/** Must match the prefix `BRIDGE_SCRIPT` in `preview-srcdoc.ts` writes for a violation. */
const VIOLATION_PREFIX = "Blocked by preview policy (";

/** Both policy reports arrive in the same task; anything later is a genuinely new block. */
export const VIOLATION_DEDUPE_WINDOW_MS = 1000;

/**
 * Returns a predicate that answers `true` for a violation message already seen
 * within the window. Non-violation messages always pass — a console error
 * repeated in a loop is information, not a duplicate report.
 */
export const createViolationDeduper = (windowMs: number = VIOLATION_DEDUPE_WINDOW_MS): ((message: string, now?: number) => boolean) => {
    const lastSeen = new Map<string, number>();

    return (message: string, now: number = Date.now()): boolean => {
        if (!message.startsWith(VIOLATION_PREFIX)) {
            return false;
        }

        const previous = lastSeen.get(message);

        lastSeen.set(message, now);

        return previous !== undefined && now - previous < windowMs;
    };
};
