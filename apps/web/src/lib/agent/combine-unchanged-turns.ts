import type { UIMessage } from "@neore/backend/agent/ui-messages";
import { combineUIMessages } from "@neore/backend/agent/ui-messages";

/** One assistant turn's steps as they came in, and the message combining them made. */
interface CombinedTurn {
    output: UIMessage;
    steps: ReadonlyArray<UIMessage>;
}

/** What the last combine made, by the turn's first step. Holds only the turns of the last result. */
export type CombineCache = Map<string, CombinedTurn>;

/** Whether `message` continues the turn `first` started; the same rule `combineUIMessages` merges by. */
const continuesTurn = (first: UIMessage, message: UIMessage): boolean =>
    message.order === first.order && message.role === first.role && message.role === "assistant";

const sameSteps = (a: ReadonlyArray<UIMessage>, b: ReadonlyArray<UIMessage>): boolean => a.length === b.length && a.every((step, index) => step === b[index]);

/**
 * `combineUIMessages` for a live page, recombining only the turns whose steps changed.
 *
 * A live push writes its page through the query cache's structural sharing, so the steps it did not
 * change keep their identity. Combining a multi-step turn still builds a new message every time, which
 * also makes every turn look changed to `shareUnchangedMessages`. A turn whose step objects are the
 * same ones as last time reuses last time's message instead, so a push into one turn of a long agent
 * thread combines that turn alone. `messages` must be sorted (`sorted`); the cache is replaced in place.
 */
export const combineUnchangedTurns = (
    messages: ReadonlyArray<UIMessage>,
    cache: CombineCache,
    combine: (steps: UIMessage[]) => UIMessage[] = combineUIMessages,
): UIMessage[] => {
    const result: UIMessage[] = [];
    const next: CombineCache = new Map();

    let index = 0;

    while (index < messages.length) {
        const first = messages[index]!;
        let end = index + 1;

        while (end < messages.length && continuesTurn(first, messages[end]!)) {
            end += 1;
        }

        if (end - index === 1) {
            // A lone step is its own message.
            result.push(first);
        } else {
            const steps = messages.slice(index, end);
            const previous = cache.get(first.id);
            const output = previous && sameSteps(previous.steps, steps) ? previous.output : combine(steps)[0]!;

            next.set(first.id, { output, steps });
            result.push(output);
        }

        index = end;
    }

    cache.clear();

    for (const [id, turn] of next) {
        cache.set(id, turn);
    }

    return result;
};
