/**
 * The `userSettings` fields a chat's system prompt carries as the user's own words (`chat/lib/get-agent.ts`). One that an
 * admin acting as the user changes marks the row (`personalizationByImpersonator`), and the mark stays: those words are
 * not the user's, so a run with them gets no saved login (`vault/site-login-turn.ts`).
 */
export const PERSONALIZATION_FIELDS = ["aboutMe", "customInstructions", "language", "location", "nickname", "profession"] as const;

/** Whether `next` changes any personalization field of `stored`: a field it leaves out, or sends unchanged, changes nothing. */
export const changesPersonalization = (stored: Readonly<Record<string, unknown>> | null, next: Readonly<Record<string, unknown>>): boolean =>
    PERSONALIZATION_FIELDS.some((field) => Object.hasOwn(next, field) && (next[field] ?? "") !== (stored?.[field] ?? ""));
