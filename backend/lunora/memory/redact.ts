import type { ReflectionOp } from "./reflection-logic";
import { REDACTED, redactSecrets } from "../lib/secret-redaction";

/** Words that only name a secret: "GitHub personal access token: «redacted»" says nothing once the token is gone. */
const SECRET_WORDS = new RegExp(
    String.raw`\b(?:${["api", "access", "auth", "bearer", "basic", "credentials?", "keys?", "pass", "password", "passphrase", "passwd", "personal", "pwd", "private", "secrets?", "tokens?"].join("|")})\b`,
    "giu",
);
/** Words that carry no fact of their own: "User's GitHub token is «redacted»" is only a secret. */
const FILLER_WORDS = new Set(["a", "an", "and", "are", "for", "her", "his", "is", "its", "my", "of", "the", "their", "to", "user", "user's", "was", "with"]);
const WORD = /[\p{L}']{2,}/gu;
const MIN_REMAINING_WORDS = 2;
/** A clause ends at punctuation, a line break or "and": "User is vegan, password: hunter2" is two. */
const CLAUSE_BREAK = /[.,;!?\n]+|\band\b/iu;
const COLON = ":";
/** A part before a secret's label states a fact when it is a clause ("User is vegan"), not a topic ("Netflix"). */
const LINKING_VERB = /\b(?:is|are|was|were|has|have|had)\b/iu;
/** A number states a fact only in a clause with a linking verb ("User is 42"); in a label ("API key 2") it does not. */
const NUMBER = /\d/u;

const isLinkedNumber = (part: string): boolean => NUMBER.test(part) && LINKING_VERB.test(part);

const contentWords = (clause: string): number =>
    (clause.replaceAll(REDACTED, " ").replaceAll(/[_-]/gu, " ").replaceAll(SECRET_WORDS, " ").match(WORD) ?? []).filter(
        (word) => !FILLER_WORDS.has(word.toLowerCase()),
    ).length;

/**
 * A clause without a secret states a fact with one content word ("User is vegan"); the label and value of a secret
 * need two. A colon splits a clause into parts: the part holding the marker and the label just before it ("GitHub
 * token: «redacted»") are the secret, and any other part ("User is vegan: password: «redacted»") is a fact of its own.
 */
const statesAFact = (clause: string): boolean => {
    if (!clause.includes(REDACTED)) {
        return contentWords(clause) >= 1 || isLinkedNumber(clause);
    }

    const parts = clause.split(COLON);
    const marked = parts.map((part, index) => {
        return { part, secret: part.includes(REDACTED) || parts[index + 1]?.trimStart().startsWith(REDACTED) === true };
    });
    const secretWords = contentWords(
        marked
            .filter(({ secret }) => secret)
            .map(({ part }) => part)
            .join(" "),
    );

    return (
        secretWords >= MIN_REMAINING_WORDS ||
        marked.some(
            ({ part, secret }) =>
                !secret && (contentWords(part) >= MIN_REMAINING_WORDS || (contentWords(part) >= 1 && LINKING_VERB.test(part)) || isLinkedNumber(part)),
        )
    );
};

const statesSomeFact = (text: string): boolean => text.split(CLAUSE_BREAK).some((clause) => statesAFact(clause));

/**
 * A memory's text with its secrets redacted, or `null` when nothing worth keeping is left once they are: such a fact is
 * dropped, not saved. Every write into `memories` (and every embedding of one) passes through this first.
 */
export const redactMemoryText = (text: string): string | null => {
    const redacted = redactSecrets(text);

    // A text the detector leaves alone is kept, unless it already holds a marker: `«redacted»` alone is no fact.
    if (redacted === text && !text.includes(REDACTED)) {
        return text;
    }

    return statesSomeFact(redacted) ? redacted : null;
};

/** How many facts one write redacted and dropped: counts only, never their text. */
// A type, not an interface: `ctx.log.event` takes an index-signature record, which an interface does not satisfy.
export type RedactionCounts = {
    dropped: number;
    redacted: number;
};

/** The facts with their secrets redacted, a fact that was nothing but a secret left out, and how many of each. */
export const redactMemoryFacts = <T extends { memory: string }>(facts: ReadonlyArray<T>): RedactionCounts & { facts: T[] } => {
    const kept: T[] = [];
    let dropped = 0;
    let redacted = 0;

    for (const fact of facts) {
        const memory = redactMemoryText(fact.memory);

        if (memory === null) {
            dropped += 1;
        } else {
            redacted += memory === fact.memory ? 0 : 1;
            kept.push({ ...fact, memory });
        }
    }

    return { dropped, facts: kept, redacted };
};

/** `text` cut to `maxChars` without leaving part of a marker behind. */
export const capMemoryText = (text: string, maxChars: number): string => {
    const cut = text.slice(0, maxChars);
    const open = cut.lastIndexOf(REDACTED.charAt(0));

    return open !== -1 && !cut.slice(open).startsWith(REDACTED) && text.slice(open).startsWith(REDACTED) ? cut.slice(0, open).trimEnd() : cut;
};

/**
 * `redacted` (a text `redactMemoryText` kept) after a cut, checked again, or `null`. A cut that removes every marker
 * must still leave a fact: "password: «redacted»; User likes tea" cut inside its marker is only the label, and filler
 * before a marker cut away is no fact either, though neither holds a secret any more.
 */
export const recheckCutMemoryText = (redacted: string, cut: string): string | null => {
    const memory = redactMemoryText(cut);

    return memory !== null && redacted.includes(REDACTED) && !memory.includes(REDACTED) && !statesSomeFact(memory) ? null : memory;
};

/** The digest's summary with its secrets redacted, then cut to `maxChars` without leaving part of a marker behind. */
export const redactDigestSummary = (summary: string, maxChars: number): string => capMemoryText(redactSecrets(summary.trim()), maxChars);

/**
 * Reflection's writes with their secrets redacted (before the cut to `maxChars`, so a cut never hides the end of a
 * secret from the detector). Only merge and promotion wording is cut: an op in `uncapped` (a belief revision's merged
 * text) is stored whole, as it was before redaction. A merge or revision wording that was nothing but a secret keeps
 * the row's old text, and the rows it would have absorbed stay active, since their detail went nowhere. Such a promotion is not made.
 */
export const redactReflectionOps = (
    ops: ReadonlyArray<ReflectionOp>,
    maxChars: number,
    uncapped: ReadonlySet<ReflectionOp> = new Set(),
): RedactionCounts & { ops: ReflectionOp[] } => {
    const lostWording = new Set<string>();
    let dropped = 0;
    let redacted = 0;

    const written = ops.flatMap((op): ReflectionOp[] => {
        if (op.kind === "supersede" || op.memory === undefined) {
            return [op];
        }

        const full = redactMemoryText(op.memory);
        // Checked again after the cut: a cut can leave nothing but the secret's label and marker.
        const memory = full === null || uncapped.has(op) ? full : recheckCutMemoryText(full, capMemoryText(full, maxChars));

        if (memory !== null) {
            redacted += full === op.memory ? 0 : 1;

            return [{ ...op, memory }];
        }

        dropped += 1;

        if (op.kind === "promote") {
            return [];
        }

        lostWording.add(op.memoryId);

        const { checkDates, confidence, lastConfirmedAt, memoryId } = op;

        // The planned dates stay checked: a refresh planned on dates the row no longer holds is not written.
        return [
            {
                kind: "patch",
                memoryId,
                ...(checkDates !== undefined && { checkDates }),
                ...(confidence !== undefined && { confidence }),
                ...(lastConfirmedAt !== undefined && { lastConfirmedAt }),
            },
        ];
    });

    return {
        dropped,
        ops: written.filter((op) => op.kind !== "supersede" || op.byMemoryId === op.memoryId || !lostWording.has(op.byMemoryId)),
        redacted,
    };
};

export const REDACTION_EVENT = "memory.secret_redaction";

/** One structured event per write that redacted or dropped a fact: which path and how many, never any text. */
export const logRedaction = (
    log: { event: (name: string, fields: RedactionCounts & { path: string }) => void },
    path: "compress" | "edit" | "extract" | "import" | "reflection",
    counts: RedactionCounts,
): void => {
    if (counts.dropped > 0 || counts.redacted > 0) {
        log.event(REDACTION_EVENT, { dropped: counts.dropped, path, redacted: counts.redacted });
    }
};
