/**
 * Sends one imported session to the backend (`POST /hosts/ingest`, plans/acp-agent-host.md S6): `import_open` first,
 * which makes the thread or finds the one that is already there; then the turns in batches, each claimed by its
 * position (`firstSeq`), as a live turn's events are; then `import_end`.
 *
 * - **The backend decides what is new.** An open that finds a finished import (or a session that ran here) answers
 * `ended`: nothing is sent. An open that finds an unfinished one answers where it stands (`next`), and the turns
 * before that are not sent again.
 * - **A gap is answered with where to resume**, and a post the backend refuses ends the import: a resend of the same
 * batch would be refused again.
 * - **Posts go one after another**, so turns are written in order. Any other failure is retried, with the jittered
 * backoff the turn posts use, and gives up after {@link MAX_ATTEMPTS}: an import is something the user is waiting
 * on and can start again, unlike a turn's output, which is kept until it gets through.
 */
import type { HostSessionInfo, PostResult } from "./host-events";
import { jitteredBackoff, wireBytes } from "./host-events";
import type { ReplayedTurn } from "./replay";

/** The backend's `MAX_IMPORT_TURNS_PER_POST`. */
const TURNS_PER_POST = 25;
/** What one post's events may add up to, in UTF-8 bytes on the wire; the backend's cap is 256 KiB for the whole body. */
const BATCH_BYTES = 150_000;
const MAX_ATTEMPTS = 6;

export interface ImportTarget extends HostSessionInfo {
    nativeSessionId: string;
    /** What the agent called the session; the thread is named after it. */
    title?: string;
}

export interface ImportIo {
    deviceId: () => string | undefined;
    now: () => number;
    random: () => number;
    request: (payload: string) => Promise<PostResult>;
    sleep?: (ms: number) => Promise<void>;
}

export type ImportOutcome
    /** The thread was already there and complete (imported before, or the session ran here): nothing was sent. */
    = | { status: "already" }
        | { status: "imported"; turns: number };

const delay = async (ms: number): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

const importTurnEvent = (turn: ReplayedTurn) => {
    return { kind: "import_turn", text: turn.text, user: turn.user, ...turn.reasoning !== "" && { reasoning: turn.reasoning } };
};

/** The turns from `from`, as many as one post takes. */
const batchFrom = (turns: ReplayedTurn[], from: number): object[] => {
    const events: object[] = [];
    const wanted = turns.slice(from, from + TURNS_PER_POST);
    let bytes = 0;

    for (const turn of wanted) {
        const event = importTurnEvent(turn);
        const size = wireBytes(event);

        // A batch's first turn is always taken: `capImportTurn` made it fit alone.
        if (events.length > 0 && bytes + size > BATCH_BYTES) {
            break;
        }

        events.push(event);
        bytes += size;
    }

    return events;
};

const FIELDS = ["user", "text", "reasoning"] as const;

const longestField = (turn: ReplayedTurn): (typeof FIELDS)[number] => {
    let longest: (typeof FIELDS)[number] = "user";

    for (const name of FIELDS) {
        if (turn[name].length > turn[longest].length) {
            longest = name;
        }
    }

    return longest;
};

/**
 * A turn that cannot ride a post alone is shortened until it can (a script that takes three bytes a character).
 * Mostly a no-op: the caps in `replay.ts` already hold a turn to a fraction of a post.
 */
export const capImportTurn = (turn: ReplayedTurn): ReplayedTurn => {
    const kept = { ...turn };

    while (wireBytes(importTurnEvent(kept)) > BATCH_BYTES) {
        const field = longestField(kept);

        kept[field] = kept[field].slice(0, Math.floor(kept[field].length * 0.8));
    }

    return kept;
};

type Answer = Extract<PostResult, { kind: "gap" | "ok" }>;

/** One post, tried again while the backend cannot be reached. A refusal, and running out of tries, end the import. */
const postWithRetry = async (io: ImportIo, hostSessionId: string, events: object[], position: { firstSeq: number; threadId: string } | undefined): Promise<Answer> => {
    const sleep = io.sleep ?? delay;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const deviceId = io.deviceId();

        if (deviceId === undefined) {
            throw new Error("this computer is not paired, so nothing can be imported");
        }

        const payload = JSON.stringify({ deviceId, events, issuedAt: io.now(), kind: "turn", sessionId: hostSessionId, v: 1, ...position });
        let result: PostResult;

        try {
            // eslint-disable-next-line no-await-in-loop -- one post after another, in order
            result = await io.request(payload);
        } catch {
            result = { kind: "retry" };
        }

        if (result.kind === "refused") {
            throw new Error("Neore refused this import");
        }

        if (result.kind !== "retry") {
            return result;
        }

        // eslint-disable-next-line no-await-in-loop -- the wait is the point
        await sleep(jitteredBackoff(attempt, io.random));
    }

    throw new Error("could not reach Neore to save the import; try again");
};

/** Sends the turns from `next` on, each batch after the one before, and the end with the last. */
const sendTurns = async (io: ImportIo, hostSessionId: string, threadId: string, turns: ReplayedTurn[], start: number): Promise<void> => {
    let next = start;

    for (;;) {
        const events = batchFrom(turns, next);
        const finishing = next + events.length >= turns.length;
        // eslint-disable-next-line no-await-in-loop -- in order
        const result = await postWithRetry(io, hostSessionId, finishing ? [...events, { kind: "import_end" }] : events, { firstSeq: next, threadId });

        if (finishing && result.kind === "ok") {
            if (!result.ended) {
                throw new Error("Neore did not accept the end of this import");
            }

            return;
        }

        // A gap means the backend holds fewer turns than this host thought, so it must move back; an accepted batch must move on. Anything else would loop.
        const moved = result.kind === "gap" ? result.next < next : result.next > next;

        if (!moved) {
            throw new Error("Neore did not accept this import");
        }

        next = result.next;
    }
};

export const postImport = async (io: ImportIo, hostSessionId: string, target: ImportTarget, replayed: ReplayedTurn[]): Promise<ImportOutcome> => {
    const turns = replayed.map((turn) => capImportTurn(turn));
    const { title, ...info } = target;
    const opened = await postWithRetry(io, hostSessionId, [{ ...info, kind: "import_open", ...title !== undefined && title !== "" && { title: title.slice(0, 200) } }], undefined);

    if (opened.kind !== "ok" || opened.threadId === undefined) {
        throw new Error("Neore did not accept this import");
    }

    if (opened.ended) {
        return { status: "already" };
    }

    await sendTurns(io, hostSessionId, opened.threadId, turns, opened.next);

    return { status: "imported", turns: turns.length };
};
