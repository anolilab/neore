/**
 * Which project a new thread's draft points at, from what is already loaded: the project titles and the
 * titles of the person's own threads. No model call; the caller passes the lists it already has.
 *
 * A project matches when its title is in the draft (every title word appears in it), or when at least two
 * draft words (one, for a one-word draft) appear in a recent, active thread's title that sits in the project.
 * The best match is the one with the most draft words hit, so a title beats a loose thread.
 */

export interface HintProject {
    _id: string;
    projectType?: string;
    title: string;
}

export interface HintThread {
    projectId?: string;
    status?: string;
    title?: string;
}

/** Common words that say nothing about a project. */
const STOP_WORDS = new Set([
    "about",
    "all",
    "and",
    "any",
    "are",
    "can",
    "for",
    "from",
    "have",
    "help",
    "how",
    "into",
    "just",
    "make",
    "need",
    "new",
    "not",
    "our",
    "please",
    "that",
    "the",
    "this",
    "use",
    "what",
    "with",
    "you",
    "your",
]);

/** Shorter draft words are too common to tell projects apart ("an", "to", "ai" in "aid"). */
const MIN_DRAFT_WORD_LENGTH = 3;

const NON_WORD_CHARACTERS = /[^\p{L}\p{N}]+/u;

const wordsOf = (text: string): string[] => {
    const words = text
        .toLowerCase()
        .split(NON_WORD_CHARACTERS)
        .filter((word) => word.length > 0 && !STOP_WORDS.has(word));

    return [...new Set(words)];
};

/** A draft word hits a title word when the title word starts with it ("invoice" finds "invoices"). */
const hitsWord = (draftWord: string, titleWords: ReadonlyArray<string>): boolean => titleWords.some((titleWord) => titleWord.startsWith(draftWord));

/** Every word of a project title appears in the draft: "Billing" in "billing export", "Client Portal" in "portal client bug". */
const titleInDraft = (titleWords: ReadonlyArray<string>, draftWords: ReadonlyArray<string>): boolean =>
    titleWords.some((titleWord) => titleWord.length >= MIN_DRAFT_WORD_LENGTH) &&
    titleWords.every((titleWord) => {
        // A short title word ("AI" in "AI Research") is matched only as the draft's own word, as the draft drops short words.
        if (titleWord.length < MIN_DRAFT_WORD_LENGTH) {
            return draftWords.includes(titleWord);
        }

        return draftWords.some((draftWord) => draftWord === titleWord || draftWord.startsWith(titleWord));
    });

/**
 * The project the draft points at, or null. `threads` are the person's loaded thread rows; archived ones and threads
 * outside a project are ignored. Workflow projects are not chat projects, so they never match.
 */
export const matchProjectHint = <P extends HintProject>(draft: string, projects: ReadonlyArray<P>, threads: ReadonlyArray<HintThread>): P | null => {
    const draftWords = wordsOf(draft).filter((word) => word.length >= MIN_DRAFT_WORD_LENGTH);

    if (draftWords.length === 0) {
        return null;
    }

    const requiredThreadHits = Math.min(2, draftWords.length);
    let best: { hits: number; project: P } | null = null;

    for (const project of projects) {
        if (project.projectType === "workflow") {
            continue;
        }

        const titleWords = wordsOf(project.title);
        const nameMatches = titleInDraft(titleWords, draftWords);
        const nameHits = draftWords.filter((word) => hitsWord(word, titleWords)).length;

        let threadHits = 0;

        for (const thread of threads) {
            if (thread.projectId !== project._id || thread.status === "archived") {
                continue;
            }

            const hits = draftWords.filter((word) => hitsWord(word, wordsOf(thread.title ?? ""))).length;

            threadHits = Math.max(threadHits, hits);
        }

        if (!nameMatches && threadHits < requiredThreadHits) {
            continue;
        }

        const hits = Math.max(nameHits, threadHits);

        if (best === null || hits > best.hits) {
            best = { hits, project };
        }
    }

    return best?.project ?? null;
};
