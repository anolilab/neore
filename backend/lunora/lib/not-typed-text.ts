/**
 * The mark on a user row's text that the owner did not type, though it reaches the row as their own: a draft the composer
 * was filled with from outside (a prompt link, the desktop shell, a saved prompt someone else wrote) and anything written
 * while an admin acts as the owner. Saved on the text part as `providerOptions.neore.notTyped`; the mark only ever
 * restricts (`vault/site-login-turn.ts` refuses a turn that holds one). An edit keeps the mark of the row it replaces.
 * No imports: the web app reads the mark too (`@neore/backend/not-typed-text`); the validator is `not-typed-text-validator.ts`.
 */
/** Where a composer draft the owner did not type came from. The web client names it when it sends (`draft-origin.ts`). */
export const NOT_TYPED_DRAFTS = ["promptLink", "shellLink", "sharedPrompt"] as const;

export type NotTypedDraft = (typeof NOT_TYPED_DRAFTS)[number];

export type NotTypedMarks = { draft?: NotTypedDraft; impersonated?: true };

const isNotTypedDraft = (value: unknown): value is NotTypedDraft => (NOT_TYPED_DRAFTS as ReadonlyArray<unknown>).includes(value);

/** A request's `draftFrom`: `undefined` when it names none, `null` when it names something unknown (refused). */
export const parseNotTypedDraft = (value: unknown): NotTypedDraft | null | undefined => {
    if (value === undefined) {
        return undefined;
    }

    return isNotTypedDraft(value) ? value : null;
};

export const hasNotTypedMarks = (marks: NotTypedMarks): boolean => marks.draft !== undefined || marks.impersonated === true;

/** Both marks, the first draft named winning; either one marks. */
export const mergeNotTypedMarks = (...all: ReadonlyArray<NotTypedMarks>): NotTypedMarks => {
    const draft = all.find((marks) => marks.draft !== undefined)?.draft;

    return {
        ...(draft !== undefined && { draft }),
        ...(all.some((marks) => marks.impersonated === true) && { impersonated: true as const }),
    };
};

/** The marks on one part. Anything there that is not a known mark still reads as marked (`impersonated`): fail closed. */
export const notTypedMarksOfPart = (part: { providerOptions?: unknown }): NotTypedMarks => {
    const mark = (part.providerOptions as { neore?: { notTyped?: unknown } } | undefined)?.neore?.notTyped;

    if (mark === undefined) {
        return {};
    }

    if (typeof mark !== "object" || mark === null) {
        return { impersonated: true };
    }

    const { draft, impersonated } = mark as { draft?: unknown; impersonated?: unknown };
    const known: NotTypedMarks = { ...(isNotTypedDraft(draft) && { draft }), ...(impersonated === true && { impersonated: true as const }) };

    return hasNotTypedMarks(known) ? known : { impersonated: true };
};

/** The marks of a stored user message, over all its parts, so an edit of it keeps them. */
export const notTypedMarksOfMessage = (message: { content?: unknown; role?: unknown } | undefined): NotTypedMarks => {
    if (message?.role !== "user" || !Array.isArray(message.content)) {
        return {};
    }

    return mergeNotTypedMarks(...(message.content as ReadonlyArray<{ providerOptions?: unknown }>).map((part) => notTypedMarksOfPart(part)));
};

/** `part` with the marks added to what its `providerOptions.neore` already holds (a guest or outside-agent mark stays); unchanged without marks. */
export const withNotTypedMarks = <P extends object>(part: P, marks: NotTypedMarks): P => {
    if (!hasNotTypedMarks(marks)) {
        return part;
    }

    const options = ((part as { providerOptions?: unknown }).providerOptions ?? {}) as Record<string, Record<string, unknown>>;

    return { ...part, providerOptions: { ...options, neore: { ...options.neore, notTyped: marks } } };
};

type MarkedTextPart = { providerOptions?: Record<string, Record<string, unknown>>; text: string; type: "text" };

/** A user message's content for `text`: the plain string the owner typed, or one marked text part. */
export const userTextContent = (text: string, marks: NotTypedMarks): string | MarkedTextPart[] =>
    hasNotTypedMarks(marks) ? [withNotTypedMarks<MarkedTextPart>({ text, type: "text" }, marks)] : text;
