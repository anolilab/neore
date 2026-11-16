/**
 * The "@" menu puts what belongs to the current chat's project first. A thread row carries its `projectId`, a vault
 * file the `chatId` it was uploaded in, so both are placed by the chats the client already holds; a file from a chat
 * outside them is listed with the rest.
 */

interface ProjectThreadRow {
    _id: string;
    projectId?: null | string;
}

/** Ids of the chats in the current chat's project, the current chat included; empty when it has no project or is not in `rows`. */
export const projectThreadIds = (rows: ReadonlyArray<ProjectThreadRow>, currentThreadId?: string): ReadonlySet<string> => {
    const projectId = currentThreadId ? rows.find((row) => row._id === currentThreadId)?.projectId : undefined;

    if (!projectId) {
        return new Set();
    }

    return new Set(rows.filter((row) => row.projectId === projectId).map((row) => row._id));
};

/** Splits `items` into those in the project and the rest, each keeping its order. */
export const partitionByProject = <T>(items: ReadonlyArray<T>, inProject: (item: T) => boolean): { inProject: T[]; rest: T[] } => {
    const result: { inProject: T[]; rest: T[] } = { inProject: [], rest: [] };

    for (const item of items) {
        (inProject(item) ? result.inProject : result.rest).push(item);
    }

    return result;
};
