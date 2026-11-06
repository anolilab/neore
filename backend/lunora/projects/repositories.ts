/**
 * A project's repositories (`projects.repositories`): what a coding-agent run
 * picker offers for the project. Pure — the mutation in `functions.ts` writes
 * the result; pinned by `repositories.test.ts`.
 *
 * URLs are stored as `parseRepoUrl(..).cloneUrl`, the same normal form a run's
 * `repoUrl` takes, so a run and a project entry compare equal. Each entry keeps
 * a stable `id` across edits; exactly one is the default once there are any.
 */
import { isValidBranchName, parseRepoUrl } from "../coding-agents/commands";

/** Repositories one project lists, at most. */
export const MAX_PROJECT_REPOSITORIES = 20;

export interface ProjectRepo {
    defaultBranch?: string;
    id: string;
    isDefault?: boolean;
    url: string;
}

/** What a caller sends: an entry without `id` is new. */
export interface ProjectRepoInput {
    defaultBranch?: string;
    id?: string;
    isDefault?: boolean;
    url: string;
}

export class ProjectRepoError extends Error {}

const ID_PATTERN = /^repo_[\da-z]{1,40}$/u;

/**
 * The list to store: URLs normalised, blank branches dropped, duplicates
 * refused, new entries given an id from `now`, and exactly one default (the
 * first, when none or several are marked). Throws {@link ProjectRepoError}
 * with a message fit for the user.
 */
export const normalizeProjectRepositories = (input: ReadonlyArray<ProjectRepoInput>, now: number): ProjectRepo[] => {
    if (input.length > MAX_PROJECT_REPOSITORIES) {
        throw new ProjectRepoError(`A project can list at most ${String(MAX_PROJECT_REPOSITORIES)} repositories`);
    }

    const seenUrls = new Set<string>();
    const seenIds = new Set<string>();
    const defaultIndex = Math.max(
        0,
        input.findIndex((entry) => entry.isDefault === true),
    );

    return input.map((entry, index): ProjectRepo => {
        let url: string;

        try {
            url = parseRepoUrl(entry.url).cloneUrl;
        } catch (error) {
            throw new ProjectRepoError(error instanceof Error ? error.message : "Invalid repository URL");
        }

        if (seenUrls.has(url)) {
            throw new ProjectRepoError("The same repository is listed twice");
        }

        seenUrls.add(url);

        const branch = entry.defaultBranch?.trim();

        if (branch && !isValidBranchName(branch)) {
            throw new ProjectRepoError(`"${branch}" is not a valid branch name`);
        }

        const id = entry.id !== undefined && ID_PATTERN.test(entry.id) && !seenIds.has(entry.id) ? entry.id : `repo_${now.toString(36)}${index.toString(36)}`;

        seenIds.add(id);

        return { id, url, ...(branch && { defaultBranch: branch }), ...(index === defaultIndex && { isDefault: true }) };
    });
};

/** The repository a run picker preselects: the marked default, else the first. */
export const defaultProjectRepo = (repositories: ReadonlyArray<ProjectRepo> | undefined): ProjectRepo | undefined =>
    repositories?.find((repo) => repo.isDefault === true) ?? repositories?.[0];
