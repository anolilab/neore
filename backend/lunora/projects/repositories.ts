/**
 * A project's repositories (`projectRepositories`): what a coding-agent run
 * picker offers for the project. Pure rules for one entry and for the list a
 * reader sees; the procedures in `functions.ts` write one row at a time.
 *
 * URLs are stored as `parseRepoUrl(..).cloneUrl`, the same normal form a run's
 * `repoUrl` takes, so a run and a project entry compare equal.
 */
import { isValidBranchName, parseRepoUrl } from "../coding-agents/commands";

/** The URL of the row that marks a project delete in progress (`deletingAt`); no repository normalises to it. */
export const DELETION_MARKER_URL = "";

/** The URL of a project's default counter row: the last `defaultAt` stamp handed out (`stampDefault`). */
export const DEFAULT_COUNTER_URL = "#default";

/** Whether a stored row is a repository, not a delete's marker or the default counter. */
export const isRepoRow = (row: { deletingAt?: number; url: string }): boolean => row.deletingAt === undefined && row.url !== DEFAULT_COUNTER_URL;

/** How long a delete's marker refuses adds: one left by a delete that failed stops counting after this. */
export const DELETION_MARKER_TTL_MS = 10 * 60 * 1000;

/** Repositories one project lists, at most. */
export const MAX_PROJECT_REPOSITORIES = 20;

/** The longest stored URL, after normalisation (which percent-encodes, so it can lengthen a URL). */
export const MAX_PROJECT_REPO_URL = 2048;

/** Why an entry was refused; the client words it in the person's language. */
type ProjectRepoRefusal = "duplicate" | "invalidBranch" | "invalidUrl" | "limit" | "urlTooLong";

/** A refused entry, naming the field the person must correct and why. */
export class ProjectRepoError extends Error {
    public constructor(
        public readonly field: "defaultBranch" | "url",
        public readonly reason: ProjectRepoRefusal,
        message: string,
    ) {
        super(message);
    }
}

/** The URL to store: normalised, and refused with a message fit for the person when it is not a usable repository. */
export const normalizeRepoUrl = (raw: string): string => {
    let url: string;

    try {
        url = parseRepoUrl(raw).cloneUrl;
    } catch (error) {
        throw new ProjectRepoError("url", "invalidUrl", error instanceof Error ? error.message : "Invalid repository URL");
    }

    if (url.length > MAX_PROJECT_REPO_URL) {
        throw new ProjectRepoError("url", "urlTooLong", `A repository URL can be at most ${String(MAX_PROJECT_REPO_URL)} characters`);
    }

    return url;
};

/** The branch to store, `undefined` for a blank one. */
export const normalizeBranch = (raw: string | undefined): string | undefined => {
    const branch = raw?.trim();

    if (branch && !isValidBranchName(branch)) {
        throw new ProjectRepoError("defaultBranch", "invalidBranch", `"${branch}" is not a valid branch name`);
    }

    return branch || undefined;
};

interface StoredRepo {
    _creationTime: number;
    _id: string;
    branchRevision?: number;
    defaultAt?: number;
    defaultBranch?: string;
    url: string;
}

/**
 * The list as a run picker and the settings show it: oldest first, with exactly one `isDefault` once there are any.
 * The default is the entry picked last (`defaultAt`), else the first added, so choosing a default writes one row.
 * A cleared default branch is stored as "" and left out here.
 */
export const withDefault = (rows: ReadonlyArray<StoredRepo>): { defaultBranch?: string; id: string; isDefault: boolean; revision: number; url: string }[] => {
    const ordered = rows.toSorted((left, right) => left._creationTime - right._creationTime || left._id.localeCompare(right._id));
    let picked: StoredRepo | undefined;

    for (const row of ordered) {
        // Stamps are claimed one at a time from the project's counter row, so they are distinct; the id only keeps this total.
        if (
            row.defaultAt !== undefined &&
            (picked?.defaultAt === undefined || row.defaultAt > picked.defaultAt || (row.defaultAt === picked.defaultAt && row._id > picked._id))
        ) {
            picked = row;
        }
    }

    const defaultId = (picked ?? ordered[0])?._id;

    return ordered.map((row) => {
        return {
            id: row._id,
            isDefault: row._id === defaultId,
            revision: row.branchRevision ?? 0,
            url: row.url,
            ...(row.defaultBranch && { defaultBranch: row.defaultBranch }),
        };
    });
};
