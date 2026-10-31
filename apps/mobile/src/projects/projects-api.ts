import type { LunoraClient, Unsubscribe } from "@lunora/client";
import { isRateLimitedError } from "@lunora/client";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";

import { DEFAULT_CHAT_MODEL } from "../lib/defaults";
import { checkProjectTitle } from "./project-title";

export interface ProjectRow {
    defaultModel?: string;
    description?: string;
    id: string;
    title: string;
}

export interface ProjectThreadRow {
    id: string;
    title: string;
}

/** The slice of the client this uses, so tests can fake it. */
export type ProjectsClient = Pick<LunoraClient, "mutation" | "subscribe">;

/** The first page of 100 projects or threads per live query. Longer lists are not paged in this slice. */
// eslint-disable-next-line unicorn/no-null -- the server's pagination options take `null` for "from the start"
const FIRST_PAGE = { cursor: null, numItems: 100 };

export class ProjectInputError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "ProjectInputError";
    }
}

/** Live: the callback fires with the current list and again on every change, from this phone or any other client. */
export const watchProjects = (client: ProjectsClient, onRows: (rows: ProjectRow[]) => void, onError: (message: string) => void): Unsubscribe =>
    client.subscribe(
        api.projects.functions.listProjects,
        { paginationOpts: FIRST_PAGE },
        (result) => {
            onRows(
                result.page.map((project) => {
                    // eslint-disable-next-line no-underscore-dangle -- `_id` is the Lunora document id, not a private field
                    return { defaultModel: project.defaultModel, description: project.description, id: project._id, title: project.title };
                }),
            );
        },
        { onError: (error) => onError(error.message) },
    );

export const watchProjectThreads = (
    client: ProjectsClient,
    projectId: string,
    onRows: (rows: ProjectThreadRow[]) => void,
    onError: (message: string) => void,
): Unsubscribe =>
    client.subscribe(
        api.projects.functions.listThreadsByProject,
        { paginationOpts: FIRST_PAGE, projectId: projectId as Id<"projects"> },
        (result) => {
            onRows(
                result.page.map((thread) => {
                    // eslint-disable-next-line no-underscore-dangle -- `_id` is the Lunora document id, not a private field
                    return { id: thread._id, title: thread.title || "Untitled" };
                }),
            );
        },
        { onError: (error) => onError(error.message) },
    );

/**
 * Creates a project with the trimmed name. `onlineOnly`: a write made while the
 * connection is down is refused, never queued for a later replay.
 */
export const createProject = async (client: ProjectsClient, rawName: string): Promise<{ id: string; title: string }> => {
    const checked = checkProjectTitle(rawName);

    if (!checked.ok) {
        throw new ProjectInputError(checked.message);
    }

    const id = await client.mutation(api.projects.functions.createProject, { title: checked.title }, { onlineOnly: true });

    return { id, title: checked.title };
};

/** A new, empty thread in the project, on the project's own model. The chat screen sends the first message into it. */
export const startProjectThread = async (client: ProjectsClient, project: { defaultModel?: string; id: string }): Promise<string> =>
    await client.mutation(
        api.chat.functions.createThread,
        { model: project.defaultModel ?? DEFAULT_CHAT_MODEL, projectId: project.id as Id<"projects"> },
        { onlineOnly: true },
    );

/** What to tell the person when a project write failed. */
export const writeErrorMessage = (error: unknown): string => {
    if (error instanceof ProjectInputError) {
        return error.message;
    }

    if (isRateLimitedError(error)) {
        return "You are doing that too often. Wait a minute and try again.";
    }

    return error instanceof Error ? error.message : "Could not save. Check your connection and try again.";
};
