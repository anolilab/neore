const GIT_SUFFIX = /\.git$/u;

/** `value` without leading and trailing slashes, without a backtracking regex. */
const trimSlashes = (value: string): string => {
    let start = 0;
    let end = value.length;

    while (start < end && value[start] === "/") {
        start += 1;
    }

    while (end > start && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(start, end);
};

/** A repo URL as people read it: `https://github.com/acme/api.git` → `acme/api`. Never throws. */
export const repoLabel = (repoUrl: string): string => {
    try {
        const path = trimSlashes(new URL(repoUrl).pathname.replace(GIT_SUFFIX, ""));

        return path || repoUrl;
    } catch {
        return repoUrl;
    }
};
