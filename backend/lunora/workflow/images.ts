/**
 * Display URLs for workflow images kept by file reference (`imageFileId`).
 *
 * The stored content names the file and never a URL, because a signed URL expires. On
 * read, each such node gets a fresh `imageUrl` — but only when the workflow's OWNER holds
 * a grant for the file. A viewer of a shared or gallery workflow therefore sees exactly
 * what the author could see: no grant is written for anyone else, and unpublishing the
 * workflow ends the viewer's access with it. A FORK is the one exception: the forker
 * becomes the copy's owner, so they are granted what the author held ({@link grantWorkflowFiles}).
 *
 * The same owner-granted files are counted in their `refcount` while a workflow
 * references them ({@link countedWorkflowFileIds}), or the unused-file sweep deletes them.
 * A workflow references a file by `imageFileId` (an image node, a video's captured
 * frames) or by a file node's `fileId` (a reference video or audio).
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { insertChatFileAccess } from "../agent/table-writes";
import { displayUrlExpiresInSeconds } from "../lib/storage-ref";

interface ImageNode {
    data?: { fileId?: unknown; frameFileIds?: unknown; imageFileId?: unknown; imageUrl?: unknown };
}

type Database = Pick<QueryCtx, "db">["db"];

/** The distinct stored-file ids on a workflow's nodes: image files, the frames a video node captured, and a file node's file. */
export const workflowFileIds = (content: unknown): Id<"chatFiles">[] => {
    const nodes = (content as { nodes?: unknown } | null | undefined)?.nodes;

    if (!Array.isArray(nodes)) {
        return [];
    }

    const ids = (nodes as ImageNode[]).flatMap((node) => {
        const frames = node?.data?.frameFileIds;

        return [node?.data?.imageFileId, node?.data?.fileId, ...(typeof frames === "object" && frames !== null ? Object.values(frames) : [])];
    });

    return [...new Set(ids.filter((id): id is string => typeof id === "string"))] as Id<"chatFiles">[];
};

/** The existing chat files among `fileIds` that `ownerId` holds a grant for: two reads. */
const grantedFiles = async (db: Database, ownerId: string, fileIds: Id<"chatFiles">[]) => {
    if (fileIds.length === 0) {
        return [];
    }

    const { page: grants } = await db.chatFileAccess.findMany({ where: { fileId: { in: fileIds }, userId: ownerId } });
    const granted = [...new Set(grants.map((grant) => grant.fileId as Id<"chatFiles">))];

    if (granted.length === 0) {
        return [];
    }

    const { page: files } = await db.chatFiles.findMany({ where: { _id: { in: granted } } });

    return files;
};

/**
 * The image files a workflow write should count before and after it, for
 * `changeRefcount(previous, next)`: only files the owner holds a grant for, so
 * a node naming someone else's file retains nothing.
 */
export const countedWorkflowFileIds = async (
    db: Database,
    ownerId: string,
    previousContent: unknown,
    nextContent: unknown,
): Promise<{ next: Id<"chatFiles">[]; previous: Id<"chatFiles">[] }> => {
    const previous = workflowFileIds(previousContent);
    const next = workflowFileIds(nextContent);
    const files = await grantedFiles(db, ownerId, [...new Set([...previous, ...next])]);
    const counted = new Set(files.map((file) => file._id as string));

    return { next: next.filter((id) => counted.has(id)), previous: previous.filter((id) => counted.has(id)) };
};

/**
 * Grant `toUserId` the image files on `content`'s nodes that `fromUserId` (a fork's
 * source author) holds a grant for. An id the author holds no grant for is never granted.
 */
export const grantWorkflowFiles = async (db: MutationCtx["db"], fromUserId: string, toUserId: string, content: unknown): Promise<void> => {
    const files = await grantedFiles(db, fromUserId, workflowFileIds(content));
    const fileIds = files.map((file) => file._id as Id<"chatFiles">);

    if (fileIds.length === 0) {
        return;
    }

    const { page: existing } = await db.chatFileAccess.findMany({ where: { fileId: { in: fileIds }, userId: toUserId } });
    const held = new Set(existing.map((grant) => grant.fileId as string));

    for (const fileId of fileIds) {
        if (!held.has(fileId)) {
            await insertChatFileAccess(db, fileId, toUserId);
        }
    }
};

export const signWorkflowImages = async <T>(context: Pick<QueryCtx, "db" | "storage">, ownerId: string | undefined, content: T): Promise<T> => {
    const fileIds = workflowFileIds(content);

    if (!ownerId || fileIds.length === 0) {
        return content;
    }

    const { nodes } = content as unknown as { nodes: ImageNode[] };
    const expiresInSeconds = displayUrlExpiresInSeconds();
    const files = await grantedFiles(context.db, ownerId, fileIds);
    const urls = new Map(
        await Promise.all(files.map(async (file) => [file._id as string, await context.storage.getSignedUrl(file.storageId, { expiresInSeconds })] as const)),
    );

    return {
        ...content,
        nodes: nodes.map((node) => {
            const url = typeof node.data?.imageFileId === "string" ? urls.get(node.data.imageFileId) : undefined;

            return url && node.data ? { ...node, data: { ...node.data, imageUrl: url } } : node;
        }),
    } as T;
};
