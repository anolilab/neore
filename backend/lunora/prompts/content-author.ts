/**
 * Who wrote a saved prompt's current words: its `content` and its variables' defaults (filled into the composer with it).
 * The composer marks a prompt as text the viewer did not type unless they wrote all of it
 * (`apps/web/src/features/chat/core/utils/draft-origin.ts#isOwnPromptContent`), and `userId` cannot say so: an
 * organization member may edit a teammate's prompt, and an admin acting as the user writes under the user's id.
 *
 * An edit can leave part of the earlier words in place, and which part cannot be told, so the record only grows:
 * `contentBy` is the last writer, `contentByOthers` is set once anyone else wrote part of the words, and
 * `contentByImpersonator` once any of them was written while impersonated. Nothing but a restore clears them, which
 * puts back a version's words with that version's record; a copy carries the record of the words it copies (unset on a
 * row from before the fields). Changing only a variable's name, description or requirement writes no words.
 */
import { compareStrings } from "../lib/collections";

export type PromptContentAuthor = { contentBy?: string; contentByImpersonator?: boolean; contentByOthers?: boolean };

type SessionWriter = { impersonatedBy?: string | null; userId: string };

/** The session's user as the sole writer of a new prompt's words; every field set, so nothing is read from elsewhere. */
export const contentAuthorOfSession = (user: SessionWriter): Required<PromptContentAuthor> => {
    return { contentBy: user.userId, contentByImpersonator: Boolean(user.impersonatedBy), contentByOthers: false };
};

/**
 * The record after the session's user changed some of `existing`'s words. A row from before the fields has an unknown
 * writer, taken as its owner only for a personal prompt (only its owner can edit one); an organization's is anyone's.
 */
export const contentAuthorAfterEdit = (
    existing: PromptContentAuthor & { organizationId?: string; userId: string },
    user: SessionWriter,
): Required<PromptContentAuthor> => {
    const editor = contentAuthorOfSession(user);
    const earlierWriter = existing.contentBy ?? (existing.organizationId ? undefined : existing.userId);

    return {
        contentBy: editor.contentBy,
        contentByImpersonator: editor.contentByImpersonator || existing.contentByImpersonator === true,
        contentByOthers: existing.contentByOthers === true || earlierWriter !== editor.contentBy,
    };
};

/** The record of a row whose words are copied into a new row, with an unset field left out. */
export const copiedContentAuthor = (row: PromptContentAuthor): PromptContentAuthor => {
    return {
        ...(row.contentBy !== undefined && { contentBy: row.contentBy }),
        ...(row.contentByImpersonator !== undefined && { contentByImpersonator: row.contentByImpersonator }),
        ...(row.contentByOthers !== undefined && { contentByOthers: row.contentByOthers }),
    };
};

/**
 * The variables' defaults, the words among them, in an order that a rename or a reorder does not change. So moving a
 * default to another variable is no new words: every word filled in is still one its writers typed.
 */
export const variableDefaults = (variables: ReadonlyArray<{ defaultValue?: string }> | undefined): string[] =>
    (variables ?? [])
        .map((variable) => variable.defaultValue ?? "")
        .filter((value) => value !== "")
        .toSorted(compareStrings);
