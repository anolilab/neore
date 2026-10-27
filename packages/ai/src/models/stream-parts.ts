/**
 * Whether a model stream part carries something the user would see: text or reasoning with characters in it, a
 * tool call or its argument deltas, a file, or the end of the stream.
 *
 * This is the retry window of a backup model: until such a part has gone out, a failed call can still be moved to
 * another model, whatever structural parts (`stream-start`, `text-start`, ...) came first. The backend's fallback
 * wrapper (what it may swap) and the gateway proxy (what it may classify as retryable) both read it from here, so
 * the two cannot drift apart.
 */
export const isVisiblePart = (part: { delta?: unknown; type: string }): boolean => {
    switch (part.type) {
        case "file":
        case "finish":
        case "tool-call": {
            return true;
        }
        case "reasoning-delta":
        case "text-delta":
        case "tool-input-delta": {
            return typeof part.delta === "string" && part.delta.length > 0;
        }
        default: {
            return false;
        }
    }
};
