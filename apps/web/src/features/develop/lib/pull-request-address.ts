/** The most pull requests one attach call takes. The backend refuses more; the dialog says so before a call is made. */
export const MAX_PULL_REQUESTS_PER_ATTACH = 10;

export interface PullRequestAddressInput {
    number: number;
    repository: string;
}

// The owner starts with a letter or digit, as the host's own names do; a repository name may not be `.` or `..`.
const SEPARATOR = /[\s,]+/u;
const SHORTHAND = /^([A-Za-z0-9][\w-]{0,38}\/(?!\.{1,2}(?![\w.-]))[\w.-]{1,100})#(\d{1,12})$/u;

/**
 * Reads what the person typed: `owner/name#123` entries, separated by spaces, commas or line breaks. Only that form is read: a
 * pasted address could name another host's repository, and the host this page reads is the only one a number can mean.
 * Returns `null` when any token is not one of those, so nothing is sent for a half-understood list.
 */
export const parsePullRequestAddresses = (input: string): PullRequestAddressInput[] | null => {
    const tokens = input
        .split(SEPARATOR)
        .map((token) => token.trim())
        .filter((token) => token !== "");

    if (tokens.length === 0) {
        return [];
    }

    const addresses: PullRequestAddressInput[] = [];

    for (const token of tokens) {
        const match = SHORTHAND.exec(token);

        if (match === null) {
            return null;
        }

        const [, repo, raw] = match;
        const number = Number(raw);

        // A number from 1: `#0` is not a pull request, and the backend refuses it, so the dialog says so here instead.
        if (repo === undefined || raw === undefined || !Number.isSafeInteger(number) || number < 1) {
            return null;
        }

        addresses.push({ number, repository: repo });
    }

    return addresses;
};
