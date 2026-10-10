/**
 * Which title/category LLM jobs `/chat/start` schedules for a prompt.
 *
 * Both are paid model calls. A TEXT prompt has already been charged to the
 * daily message quota by then; a MEDIA prompt has not — it is charged at
 * `/chat/media`, per generation — so scheduling them for media made
 * `/chat/start` an uncharged way to buy two LLM calls per request. Media
 * threads get a title cut from the prompt instead, and no category.
 */
export type StartTitleJob = "category" | "title";

export const startTitleJobs = (contentType: "image" | "text" | "video", isNewThread: boolean): StartTitleJob[] => {
    if (contentType !== "text") {
        return [];
    }

    return isNewThread ? ["title", "category"] : ["title"];
};

const MEDIA_TITLE_MAX_LENGTH = 60;

/** A thread title for a media prompt, without a model call. `undefined` keeps the default. */
export const mediaThreadTitle = (prompt: string | undefined): string | undefined => {
    const text = prompt?.replaceAll(/\s+/gu, " ").trim();

    if (!text) {
        return undefined;
    }

    return text.length > MEDIA_TITLE_MAX_LENGTH ? `${text.slice(0, MEDIA_TITLE_MAX_LENGTH - 1).trimEnd()}…` : text;
};
