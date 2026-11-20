import { LunoraError } from "lunorash/server";

import { isLegacyContextFile, projectRuleFiles, type RuleFile } from "./rule-files";

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

/** One page of `collectOwnedProjectsForExport`: its projects, where the next page starts, and what reading them cost. */
interface OwnedProjectsPage {
    cursor?: string | null;
    projects?: { context?: string; projectId: string }[];
    readBytes?: number;
}

/**
 * Every project the user owns, one page per query, reported only after the last page. A project is never left out:
 * every page is read, each costing its whole rows (`findProjectRowsMeasured`), and a page that takes the reads past
 * `maxBytes` has its projects' sharing flag dropped and marked `{ detailsOmitted: true }`, the same way the
 * repositories' project details are. The id, title, machine and folder stay on every row. A project's legacy `context`
 * is not one of its exported fields: it comes back apart (`contexts`, by project id), for {@link attachProjectRuleFiles},
 * which decides how much of it is exported.
 */
export const collectAllOwnedProjects = async (
    readPage: (cursor: string | null) => Promise<unknown>,
    maxBytes: number,
): Promise<{ contexts: Map<string, string>; projects: unknown[]; readBytes: number }> => {
    const contexts = new Map<string, string>();
    const projects: unknown[] = [];
    let cursor: string | null = null;
    let readBytes = 0;

    for (;;) {
        const result = (await readPage(cursor)) as OwnedProjectsPage;

        readBytes += result.readBytes ?? 0;

        const pageProjects = result.projects ?? [];

        for (const { context, ...project } of pageProjects) {
            if (context) {
                contexts.set(project.projectId, context);
            }

            if (readBytes > maxBytes) {
                const kept: Record<string, unknown> = { ...project, detailsOmitted: true };

                delete kept.sharingEnabled;
                projects.push(kept);
            } else {
                projects.push(project);
            }
        }

        if (!result.cursor) {
            break;
        }

        cursor = result.cursor;
    }

    return { contexts, projects, readBytes };
};

/** What `collectProjectRuleFilesForExport` gives back for up to {@link PROJECTS_PER_DETAILS_READ} projects: their saved rows. */
interface RuleFilesPage {
    projects: { carriedContext?: string; files: RuleFile[]; projectId: string }[];
    readBytes: number;
}

/**
 * The user's projects from {@link collectAllOwnedProjects}, each with its rule files (`ruleFiles`), a legacy `context`
 * first (`projectRuleFiles`, from `contexts`, the project rows already read), the saved rows read
 * {@link PROJECTS_PER_DETAILS_READ} projects to a query. Once the reads reach `maxBytes` the remaining projects' files are
 * not read and the project says so (`ruleFilesOmitted: true`), still with its legacy `context`, which costs no read.
 * The legacy contexts exported share `contextMaxBytes` of the export's output (as JSON, UTF-8), in project order; one
 * that does not fit is left out and its project marked the same way. A `context` the saved list carries already is
 * neither exported nor counted. The export still completes. A project without rule files gets no `ruleFiles`.
 */
export const attachProjectRuleFiles = async (
    projects: object[],
    contexts: ReadonlyMap<string, string>,
    readRuleFiles: (projectIds: string[]) => Promise<RuleFilesPage>,
    maxBytes: number,
    contextMaxBytes: number,
): Promise<{ projects: object[]; readBytes: number }> => {
    const projectIds = projects.map((project) => (project as { projectId: string }).projectId);
    const rows = new Map<string, RuleFilesPage["projects"][number] | undefined>();
    let contextBytes = 0;
    let readBytes = 0;

    for (let index = 0; index < projectIds.length && readBytes < maxBytes; index += PROJECTS_PER_DETAILS_READ) {
        const batch = projectIds.slice(index, index + PROJECTS_PER_DETAILS_READ);
        const page = await readRuleFiles(batch);
        const read = new Map(page.projects.map((row) => [row.projectId, row] as const));

        readBytes += page.readBytes;

        for (const projectId of batch) {
            rows.set(projectId, read.get(projectId));
        }
    }

    return {
        projects: projects.map((project) => {
            const { projectId } = project as { projectId: string };
            // A project in no batch read had its files left out; `rows` holds `undefined` for one read without a row.
            const unread = !rows.has(projectId);
            const row = rows.get(projectId);
            let files = projectRuleFiles({ carriedContext: row?.carriedContext, context: contexts.get(projectId), ruleFiles: row?.files });
            let contextOmitted = false;

            if (files[0] && isLegacyContextFile(files[0])) {
                const bytes = utf8Bytes(files[0].content);

                if (contextBytes + bytes <= contextMaxBytes) {
                    contextBytes += bytes;
                } else {
                    files = files.slice(1);
                    contextOmitted = true;
                }
            }

            return {
                ...project,
                ...(files.length > 0 && { ruleFiles: files }),
                ...((unread || contextOmitted) && { ruleFilesOmitted: true }),
            };
        }),
        readBytes,
    };
};
