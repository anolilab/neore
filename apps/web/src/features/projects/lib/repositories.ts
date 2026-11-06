/**
 * A project's repositories (`projects.repositories`), as the project settings
 * and the coding-agent run picker show them. Pinned by `repositories.test.ts`.
 */

export interface ProjectRepo {
    defaultBranch?: string;
    id: string;
    isDefault?: boolean;
    url: string;
}

const DOT_GIT = /\.git$/u;

/** `path` without leading or trailing slashes. */
const trimSlashes = (path: string): string => {
    let start = 0;
    let end = path.length;

    while (start < end && path[start] === "/") {
        start += 1;
    }

    while (end > start && path[end - 1] === "/") {
        end -= 1;
    }

    return path.slice(start, end);
};

/** `owner/repo` for a GitHub URL, `host/path` for any other; the URL itself when it does not parse. */
export const repoLabel = (url: string): string => {
    try {
        const parsed = new URL(url);
        const path = trimSlashes(parsed.pathname.replace(DOT_GIT, ""));

        if (!path) {
            return url;
        }

        return parsed.hostname === "github.com" ? path : `${parsed.hostname}/${path}`;
    } catch {
        return url;
    }
};

/** The repository a run picker preselects: the marked default, else the first. */
export const defaultRepoOf = (repositories: ReadonlyArray<ProjectRepo> | undefined): ProjectRepo | undefined =>
    repositories?.find((repo) => repo.isDefault === true) ?? repositories?.[0];

/** The list with `id` as its only default — what `setProjectRepositories` takes. */
export const withDefault = (repositories: ReadonlyArray<ProjectRepo>, id: string): ProjectRepo[] =>
    repositories.map((repo) => {
        return {
            id: repo.id,
            url: repo.url,
            ...(repo.defaultBranch !== undefined && { defaultBranch: repo.defaultBranch }),
            ...(repo.id === id && { isDefault: true }),
        };
    });
