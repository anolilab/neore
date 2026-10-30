/** The first line of a commit message: its subject. */
export const commitSubject = (message: string): string => message.split("\n", 1)[0] ?? "";

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** A link from a host, kept only when it is a plain https address; anything else is shown as text. */
export const safeExternalUrl = (url: string | null | undefined): string | undefined => {
    if (!url) {
        return undefined;
    }

    try {
        return new URL(url).protocol === "https:" ? url : undefined;
    } catch {
        return undefined;
    }
};
