/**
 * What the "Needs you" card may show of what its reads say about the caller's access to the chat, by one fail-closed
 * rule. The card keeps the latest moment any answer said access had ended: a denial's server time, or a grant's end
 * (`accessUntil`, the value itself) that a read's newest answer names, once the server's clock is known to be past it
 * (an older answer's end is not: the subscription's last push keeps naming a grant renewed since). It shows the site and page only
 * once the browser status has answered, and the ask too when the card reads one, and only while the newest answer of each
 * read is from strictly after that moment and says the caller reads the chat: a read not answered yet (a card on screen
 * through an account switch, its cache gone) shows nothing. It offers an answer only when, on top of that, the ask's
 * newest answer says `canResolve`. Two reads may see different replicas of a grant, so one read's later answer never
 * undoes another's denial: both must answer after it.
 */

/** One answer as the rule reads it. */
export interface AccessAnswer {
    /** A grantee's grant end as the answer saw it, on the server's clock. */
    accessUntil?: number;
    /** On an ask's answer: whether it says the caller may answer the ask now. */
    canResolve?: boolean;
    /** The server's time of the answer. */
    now: number;
    /** It says the caller reads the chat in full now (a status `running` or `none`, an ask `found` or `elsewhere`). */
    reads: boolean;
}

/** One read's answers: its live subscription's and its one-shot read's, each `undefined` while it has none. */
export type AccessRead = ReadonlyArray<AccessAnswer | undefined>;

/** What the card keeps across answers, since an answer that said access ended may since have left the cache. */
export interface AccessMemory {
    /** The latest moment an answer said access had ended, on the server's clock. */
    end?: number;
    /** The latest grant end the server's clock is known to have passed. */
    grantEnd?: number;
    /** Why the card went hidden, kept while it stays so: a later answer that still denies says nothing new. */
    hiddenBy?: "ended" | "unreadable";
}

export interface AccessInput {
    /** The ask's read; `undefined` when the card reads no ask. */
    ask?: AccessRead;
    memory: AccessMemory;
    /** The server's clock is known to be past this moment (the card's timer reached a grant end). */
    serverPast?: number;
    /** The browser status's read; `undefined` when the card reads none. */
    status?: AccessRead;
}

export interface CardAccess {
    /** A read says the caller reads the chat after the end and another does not yet: that one is worth reading again. */
    behind: boolean;

    /**
     * Why the card shows nothing of the site: a grant ended (`ended`), an answer denied (`unreadable`), or a read it needs
     * has not answered yet (`pending`, never kept in the memory: an answer decides).
     */
    hidden?: "ended" | "pending" | "unreadable";
    /** Whether the card may offer an answer, as far as access goes. */
    mayAnswer: boolean;
    memory: AccessMemory;
}

const answersOf = (read: AccessRead | undefined): AccessAnswer[] | undefined =>
    read?.filter((answer: AccessAnswer | undefined): answer is AccessAnswer => answer !== undefined);

const maxOf = (values: ReadonlyArray<number | undefined>): number | undefined => {
    let max: number | undefined;

    for (const value of values) {
        if (value !== undefined && (max === undefined || value > max)) {
            max = value;
        }
    }

    return max;
};

/** The answers of a read from its newest server time: on a tie, every one of them must say what the read says. */
const newestOf = (answers: ReadonlyArray<AccessAnswer>): AccessAnswer[] => {
    const newest = maxOf(answers.map((answer: AccessAnswer) => answer.now));

    return answers.filter((answer: AccessAnswer) => answer.now === newest);
};

/** The reads the card makes, each with its answers. */
const readsOf = (status: AccessRead | undefined, ask: AccessRead | undefined): AccessAnswer[][] =>
    [answersOf(status), answersOf(ask)].filter((read: AccessAnswer[] | undefined): read is AccessAnswer[] => read !== undefined);

/** The grant ends the reads' newest answers name. */
const namedEnds = (reads: ReadonlyArray<ReadonlyArray<AccessAnswer>>): number[] =>
    reads
        .flatMap((read: ReadonlyArray<AccessAnswer>) => newestOf(read))
        .map((answer: AccessAnswer) => answer.accessUntil)
        .filter((until: number | undefined): until is number => until !== undefined);

/**
 * The next grant end the card's timer waits for: the earliest `accessUntil` a read's newest answer names that the
 * server's clock is not yet known to have passed.
 */
export const upcomingGrantEnd = ({ ask, memory, status }: Omit<AccessInput, "serverPast">): number | undefined => {
    const reads = readsOf(status, ask);
    const known = maxOf([memory.grantEnd, ...reads.flat().map((answer: AccessAnswer) => answer.now)]);
    let next: number | undefined;

    for (const accessUntil of namedEnds(reads)) {
        if ((known === undefined || accessUntil > known) && (next === undefined || accessUntil < next)) {
            next = accessUntil;
        }
    }

    return next;
};

export const cardAccess = ({ ask, memory, serverPast, status }: AccessInput): CardAccess => {
    const reads = readsOf(status, ask);
    const answers = reads.flat();
    // Every answer's own time is a moment the server's clock has reached.
    const known = maxOf([serverPast, ...answers.map((answer: AccessAnswer) => answer.now)]);
    const grantEnd = maxOf([memory.grantEnd, ...namedEnds(reads).filter((until: number) => known !== undefined && until <= known)]);
    const end = maxOf([memory.end, grantEnd, ...answers.map((answer: AccessAnswer) => (answer.reads ? undefined : answer.now))]);
    // A read affirms when its newest answers all say the caller reads the chat, are from after the end, and name no
    // grant end the server's clock has passed.
    const affirms = (read: ReadonlyArray<AccessAnswer>): boolean =>
        read.length > 0 &&
        newestOf(read).every(
            (answer: AccessAnswer) =>
                answer.reads &&
                (end === undefined || answer.now > end) &&
                (answer.accessUntil === undefined || known === undefined || answer.accessUntil > known),
        );
    // Whether no read says access ended or was denied: one not answered yet says nothing until an end was seen; after
    // one, it must answer since.
    const open = reads.every((read: ReadonlyArray<AccessAnswer>) => (read.length === 0 ? end === undefined : affirms(read)));
    // Fail closed: the card shows the site only once the status, and the ask it reads, have answered and affirm.
    const visible = status !== undefined && reads.every((read: ReadonlyArray<AccessAnswer>) => affirms(read));
    const askAnswers = answersOf(ask);
    const mayAnswer =
        visible && askAnswers !== undefined && affirms(askAnswers) && newestOf(askAnswers).every((answer: AccessAnswer) => answer.canResolve === true);
    let hidden: CardAccess["hidden"];

    if (!open) {
        // As it goes hidden: a grant's end when one just became known or is the latest end, else a denial.
        hidden = memory.hiddenBy ?? (grantEnd !== undefined && (grantEnd !== memory.grantEnd || grantEnd === end) ? "ended" : "unreadable");
    } else if (!visible) {
        hidden = "pending";
    }

    const next: AccessMemory = {
        ...(end !== undefined && { end }),
        ...(grantEnd !== undefined && { grantEnd }),
        ...(hidden !== undefined && hidden !== "pending" && { hiddenBy: hidden }),
    };

    // Only a read that said access ended or was denied puts another behind: one still loading is read anyway.
    return { behind: !open && reads.some((read: ReadonlyArray<AccessAnswer>) => affirms(read)), hidden, mayAnswer, memory: next };
};

/** Whether two memories hold the same. */
export const sameMemory = (a: AccessMemory, b: AccessMemory): boolean => a.end === b.end && a.grantEnd === b.grantEnd && a.hiddenBy === b.hiddenBy;
