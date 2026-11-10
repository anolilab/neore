import { LunoraError } from "lunorash/server";

/** One page of `collectProjectRepositoriesForExport`: its rows, and where the next page starts (`null` after the last). */
interface RepositoriesPage {
    cursor?: string | null;
    projectRepositories?: { projectId: string }[];
}

/** What `collectProjectDetailsForExport` gives back for one project. */
interface ProjectDetails {
    project: { sharingEnabled: boolean; title: string } | null;
    readBytes: number;
}

/** A project's details as the export shows them next to a repository. */
type ExportedProject = { detailsOmitted: true } | { sharingEnabled: boolean; title: string } | null;

const utf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * The user's repository rows for the export file, each with its project's details (`project`), and what reading them
 * cost (`readBytes`). The rows are walked one page per query and reported only after the last page; a row is never
 * left out: past `maxBytes` (UTF-8) the walk stops with PAYLOAD_TOO_LARGE rather than return a cut list.
 *
 * Each project is then read once. A project row may be large (its `context`, its workflow), so once the reads pass
 * `maxBytes` the remaining projects are not read: their repositories say so (`{ detailsOmitted: true }`), and the
 * export still completes. A project that is gone shows as `null`.
 */
export const collectAllRepositories = async (
    readPage: (cursor: string | null) => Promise<unknown>,
    readProject: (projectId: string) => Promise<ProjectDetails>,
    maxBytes: number,
): Promise<{ projectRepositories: unknown[]; readBytes: number }> => {
    const rows: { projectId: string }[] = [];
    let cursor: string | null = null;
    let readBytes = 0;

    for (;;) {
        const result = (await readPage(cursor)) as RepositoriesPage;

        readBytes += utf8Bytes(result);

        if (readBytes > maxBytes) {
            throw new LunoraError("PAYLOAD_TOO_LARGE", "The project repositories are larger than the export limit");
        }

        rows.push(...(result.projectRepositories ?? []));

        if (!result.cursor) {
            break;
        }

        cursor = result.cursor;
    }

    const projects = new Map<string, ExportedProject>();
    const projectIds = new Set(rows.map((row) => row.projectId));

    for (const projectId of projectIds) {
        if (readBytes >= maxBytes) {
            projects.set(projectId, { detailsOmitted: true });

            continue;
        }

        const details = await readProject(projectId);

        readBytes += details.readBytes;
        projects.set(projectId, details.project);
    }

    return {
        projectRepositories: rows.map((row) => {
            return { ...row, project: projects.get(row.projectId) ?? null };
        }),
        readBytes,
    };
};
