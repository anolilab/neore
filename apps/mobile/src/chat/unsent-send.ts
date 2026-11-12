/**
 * The composer after a send the server never accepted: the prompt goes back, ahead of anything typed since, so a
 * failed token request or a refused start never loses it.
 */
export const draftAfterUnsent = (current: string, prompt: string): string => {
    if (current.trim() === "") {
        return prompt;
    }

    return `${prompt}\n\n${current}`;
};

/** The rows after a send the server never accepted: its local prompt and reply rows go, since no read will ever confirm them. */
export const withoutUnsentRows = <T extends { id: string }>(rows: T[], ids: ReadonlyArray<string>): T[] => rows.filter((row) => !ids.includes(row.id));
