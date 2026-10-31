/** `MAX_LENGTH.long` in `backend/lunora/lib/validators.ts`, the cap on `createProject`'s `title`. `project-title.test.ts` pins that they agree. */
export const MAX_PROJECT_TITLE_LENGTH = 10_000;

export type ProjectTitleCheck = { message: string; ok: false } | { ok: true; title: string };

/** The server only caps the length; the web form also requires a name. The trimmed value is what is checked and what is sent. */
export const checkProjectTitle = (raw: string): ProjectTitleCheck => {
    const title = raw.trim();

    if (title === "") {
        return { message: "Enter a project name.", ok: false };
    }

    if (title.length > MAX_PROJECT_TITLE_LENGTH) {
        return { message: `Use at most ${MAX_PROJECT_TITLE_LENGTH.toLocaleString("en-US")} characters.`, ok: false };
    }

    return { ok: true, title };
};
