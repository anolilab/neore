import { LunoraError } from "lunorash/server";

/** One page of `collectProjectRepositoriesForExport`: its rows, and where the next page starts (`null` after the last). */
interface RepositoriesPage {
    cursor?: string | null;
    projectRepositories?: { projectId: string }[];
}

/**
 * Projects one details read takes. A project row holds at most 2 MB and is read whole, and counted as JSON, which can
 * double it (escaped quotes and newlines): a read that starts just under the budget passes it by at most 8 MB, the
 * export's margin (`READ_MARGIN_BYTES`, `gdpr/read-budget.ts`).
 */
export const PROJECTS_PER_DETAILS_READ = 2;

/** What `collectProjectDetailsForExport` gives back for up to {@link PROJECTS_PER_DETAILS_READ} projects. */
interface ProjectDetails {
    projects: { project: { sharingEnabled: boolean; title: string }; projectId: string }[];
    readBytes: number;
}

/** A project's details as the export shows them next to a repository. */
type ExportedProject = { detailsOmitted: true } | { sharingEnabled: boolean; title: string } | null;

const utf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * The user's repository rows for the export file, each with its project's details (`project`), and what reading them
 * cost (`readBytes`). The rows are walked one page per query and reported only after the last page; a row is never
 * left out: past `maxBytes` (UTF-8) the walk stops with PAYLOAD_TOO_LARGE rather than return a cut list. The details
 * have their own budget, `detailsMaxBytes`, counted with the rows' reads, because unlike the rows they can be left out.
 *
 * Each project is then read once, {@link PROJECTS_PER_DETAILS_READ} to a query. A project row may be large (its
 * `context`, its workflow), so once the reads reach `detailsMaxBytes` the remaining projects are not read: their repositories
 * say so (`{ detailsOmitted: true }`), and the export still completes. A project that is gone, or not the user's, shows
 * as `null`.
 */
export const collectAllRepositories = async (
    readPage: (cursor: string | null) => Promise<unknown>,
    readProjects: (projectIds: string[]) => Promise<ProjectDetails>,
    maxBytes: number,
    detailsMaxBytes = maxBytes,
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
    const projectIds = [...new Set(rows.map((row) => row.projectId))];

    for (let index = 0; index < projectIds.length; index += PROJECTS_PER_DETAILS_READ) {
        const batch = projectIds.slice(index, index + PROJECTS_PER_DETAILS_READ);

        if (readBytes >= detailsMaxBytes) {
            for (const projectId of batch) {
                projects.set(projectId, { detailsOmitted: true });
            }

            continue;
        }

        const details = await readProjects(batch);

        readBytes += details.readBytes;

        for (const { project, projectId } of details.projects) {
            projects.set(projectId, project);
        }
    }

    return {
        projectRepositories: rows.map((row) => {
            return { ...row, project: projects.get(row.projectId) ?? null };
        }),
        readBytes,
    };
};
