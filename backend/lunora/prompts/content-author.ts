/**
 * Who wrote a saved prompt's current content. The composer marks a prompt as text the viewer did not type unless they wrote
 * it (`apps/web/src/features/chat/core/utils/draft-origin.ts#noteSavedPrompt`), and `userId` cannot say so: an organization
 * member may edit a teammate's prompt, and an admin acting as the user writes under the user's id. So every write of
 * `content` or of the variables' defaults (filled into the composer with it) records its writer from the session, on the prompt and on its history row, and a copy or a restore carries
 * the writer of the text it copies (unset on a row from before the field).
 */
export type PromptContentAuthor = { contentBy?: string; contentByImpersonator?: boolean };

/** The session's user as the writer of new content; always both fields, so a patch replaces an earlier impersonated mark. */
export const contentAuthorOfSession = (user: { impersonatedBy?: string | null; userId: string }): Required<PromptContentAuthor> => {
    return { contentBy: user.userId, contentByImpersonator: Boolean(user.impersonatedBy) };
};

/** The writer recorded on a row whose content is copied into a new row, with an unset field left out. */
export const copiedContentAuthor = (row: PromptContentAuthor): PromptContentAuthor => {
    return {
        ...(row.contentBy !== undefined && { contentBy: row.contentBy }),
        ...(row.contentByImpersonator !== undefined && { contentByImpersonator: row.contentByImpersonator }),
    };
};
