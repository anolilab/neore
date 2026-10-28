/**
 * Collects the history an agent replays while it loads one of its saved sessions (`session/load`): a
 * `session/update` for every message it kept. Each user message starts a turn; the agent's text and reasoning that
 * follow belong to it. Tool calls, plans and the rest are not kept, as for a turn that ran here: a reply row holds
 * text and reasoning.
 *
 * Everything in a transcript came from the agent. It is cut to the sizes the backend takes, masked with the values
 * the user asked to hide (`scrub`), and bounded in memory: a session cannot grow it past the caps.
 */

/** One prompt and the reply to it. Either side may be empty (a transcript can open with the agent), never both. */
export interface ReplayedTurn {
    reasoning: string;
    text: string;
    user: string;
}

// The backend's limits on one `import_turn` (`backend/lunora/acp/validators.ts`).
export const MAX_IMPORT_USER_CHARS = 100_000;
export const MAX_IMPORT_TEXT_CHARS = 65_536;
export const MAX_IMPORT_REASONING_CHARS = 65_536;
/** The backend's `MAX_IMPORT_TURNS`: the first turns are kept. */
export const MAX_IMPORTED_TURNS = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The text of a content block; anything that is not text shows as its type, in brackets (as the live transcript does). */
const contentText = (content: unknown): string => {
    if (!isRecord(content)) {
        return "";
    }

    if (content.type === "text") {
        return typeof content.text === "string" ? content.text : "";
    }

    return `[${typeof content.type === "string" ? content.type : "content"}]`;
};

type Field = keyof ReplayedTurn;

const LIMITS: Record<Field, number> = { reasoning: MAX_IMPORT_REASONING_CHARS, text: MAX_IMPORT_TEXT_CHARS, user: MAX_IMPORT_USER_CHARS };

interface Open extends ReplayedTurn {
    cut: Set<Field>;
    /** The agent has answered: the next user message is a new turn. */
    spoke: boolean;
    /** The agent's id of the user message being collected; a different one starts the next turn. */
    userMessageId: string | undefined;
}

export interface Replay {
    /** Turns past the cap that were dropped. */
    droppedTurns: number;
    /** Turns with a field cut to its limit. */
    shortenedTurns: number;
    turns: ReplayedTurn[];
}

/** The turn with each field cut to its limit, and whether any needed it. */
const cutToLimits = (turn: ReplayedTurn): { cut: boolean; kept: ReplayedTurn } => {
    return {
        cut: turn.reasoning.length > LIMITS.reasoning || turn.text.length > LIMITS.text || turn.user.length > LIMITS.user,
        kept: { reasoning: turn.reasoning.slice(0, LIMITS.reasoning), text: turn.text.slice(0, LIMITS.text), user: turn.user.slice(0, LIMITS.user) },
    };
};

export class ReplayCollector {
    private current: Open | undefined;

    private droppedTurns = 0;

    private readonly open: Open[] = [];

    public constructor(
        private readonly nativeSessionId: string,
        private readonly scrub: (text: string) => string = (text) => text,
    ) {}

    /** The `params` of one `session/update`. Anything but the loading session's history is ignored. */
    public update(params: unknown): void {
        if (!isRecord(params) || params.sessionId !== this.nativeSessionId || !isRecord(params.update)) {
            return;
        }

        const { update } = params;
        const text = contentText(update.content);

        switch (update.sessionUpdate) {
            case "agent_message_chunk": {
                this.current ??= this.begin(undefined);
                this.current.spoke = true;
                this.append("text", text);
                break;
            }
            case "agent_thought_chunk": {
                this.current ??= this.begin(undefined);
                this.current.spoke = true;
                this.append("reasoning", text);
                break;
            }
            case "user_message_chunk": {
                const messageId = typeof update.messageId === "string" ? update.messageId : undefined;

                // The same message carries on; a new one, or the first after the agent spoke, is a new turn.
                if (this.current === undefined || this.current.spoke || (messageId !== undefined && messageId !== this.current.userMessageId)) {
                    this.begin(messageId);
                }

                this.append("user", text);
                break;
            }
            default: {
                break;
            }
        }
    }

    public result(): Replay {
        const turns: ReplayedTurn[] = [];
        let shortenedTurns = 0;

        for (const turn of this.open) {
            // Masking can shorten a field, so the cut is applied once more after it.
            const { cut, kept } = cutToLimits({ reasoning: this.scrub(turn.reasoning), text: this.scrub(turn.text), user: this.scrub(turn.user) });

            if (kept.user.trim() === "" && kept.text.trim() === "" && kept.reasoning.trim() === "") {
                continue;
            }

            if (cut || turn.cut.size > 0) {
                shortenedTurns += 1;
            }

            turns.push(kept);
        }

        return { droppedTurns: this.droppedTurns, shortenedTurns, turns };
    }

    private begin(userMessageId: string | undefined): Open {
        const turn: Open = { cut: new Set(), reasoning: "", spoke: false, text: "", user: "", userMessageId };

        if (this.open.length >= MAX_IMPORTED_TURNS) {
            // Counted, and collected into nothing: the turn after it still ends this one.
            this.droppedTurns += 1;
            this.current = turn;

            return turn;
        }

        this.open.push(turn);
        this.current = turn;

        return turn;
    }

    private append(field: Field, chunk: string): void {
        const turn = this.current;

        if (turn === undefined || chunk === "" || this.open.at(-1) !== turn) {
            return;
        }

        const limit = LIMITS[field];

        if (turn.cut.has(field)) {
            return;
        }

        const next = turn[field] + chunk;

        if (next.length <= limit) {
            turn[field] = next;

            return;
        }

        // Masked before it is cut: a value that straddles the cut would otherwise leave its first half readable.
        turn.cut.add(field);
        turn[field] = this.scrub(next).slice(0, limit);
    }
}
