/**
 * Reading the backend's stale-revision refusal (`backend/lunora/pages/
 * functions.ts#assertFreshRevision`): a CONFLICT whose `data` carries the page
 * as it is now. Any other error is not one.
 */

export const PAGE_REVISION_CONFLICT = "PAGE_REVISION_CONFLICT";

export interface RevisionConflict {
    content: string;
    contentJson: unknown;
    revision: number;
    title: string;
}

export const readRevisionConflict = (error: unknown): RevisionConflict | null => {
    const data = (error as { data?: Record<string, unknown> } | null)?.data;

    if (!data || data.code !== PAGE_REVISION_CONFLICT || typeof data.revision !== "number") {
        return null;
    }

    return {
        content: typeof data.content === "string" ? data.content : "",
        contentJson: data.contentJson ?? null,
        revision: data.revision,
        title: typeof data.title === "string" ? data.title : "",
    };
};
