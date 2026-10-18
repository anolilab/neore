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
 * frames) or by a file node's `fileId`. A file node counts only when its file is reference
 * video or audio: that upload purpose (`lib/reference-media-upload.ts`) is newer than
 * the workflows saved before it, which could name only a document, and a document was
 * never counted, so counting one now would release a reference that was never added.
 * A fork is granted the same set, never a document.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { insertChatFileAccess } from "../agent/table-writes";
import { displayUrlExpiresInSeconds } from "../lib/storage-ref";

interface ImageNode {
    data?: { fileId?: unknown; frameFileIds?: unknown; imageFileId?: unknown; imageUrl?: unknown };
}

type Database = Pick<QueryCtx, "db">["db"];

const nodesOf = (content: unknown): ImageNode[] => {
    const nodes = (content as { nodes?: unknown } | null | undefined)?.nodes;

    return Array.isArray(nodes) ? (nodes as ImageNode[]) : [];
};

const distinctFileIds = (values: unknown[]): Id<"chatFiles">[] =>
    [...new Set(values.filter((id): id is string => typeof id === "string"))] as Id<"chatFiles">[];

/** The distinct stored-file ids an image node names: `imageFileId`, and the frames a video node captured. */
export const imageFileIdsOf = (content: unknown): Id<"chatFiles">[] =>
    distinctFileIds(
        nodesOf(content).flatMap((node) => {
            const frames = node?.data?.frameFileIds;

            return [node?.data?.imageFileId, ...(typeof frames === "object" && frames !== null ? Object.values(frames) : [])];
        }),
    );

/** The distinct stored-file ids a file node names by `fileId`. */
export const fileNodeFileIdsOf = (content: unknown): Id<"chatFiles">[] => distinctFileIds(nodesOf(content).map((node) => node?.data?.fileId));

/** Every distinct stored-file id a workflow's nodes name: the candidates {@link countedWorkflowFileIds} filters. */
export const workflowFileIds = (content: unknown): Id<"chatFiles">[] => distinctFileIds([...imageFileIdsOf(content), ...fileNodeFileIdsOf(content)]);

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

type GrantedFile = { _id: string; mediaType: string };

/** A reference video or audio clip: the only file-node media a workflow counts, and a fork is granted. */
const isReferenceMedia = (mediaType: string): boolean => mediaType.startsWith("video/") || mediaType.startsWith("audio/");

/**
 * The ids of `files` that `content` counts: its image files and captured frames, and its file
 * nodes' files only when those are reference media. Membership comes from this content alone, so
 * a file that moved from an image node to a document node counts on the side that still names it as an image.
 */
const countedIdsOf = (content: unknown, files: GrantedFile[]): Set<string> => {
    const images = new Set<string>(imageFileIdsOf(content));
    const clips = new Set<string>(fileNodeFileIdsOf(content));

    return new Set(files.filter((file) => images.has(file._id) || (clips.has(file._id) && isReferenceMedia(file.mediaType))).map((file) => file._id));
};

/**
 * The files a workflow write should count before and after it, for
 * `changeRefcount(previous, next)`: only files the owner holds a grant for (a node
 * naming someone else's file retains nothing), and a file node's file only when it is
 * reference media ({@link countedIdsOf}).
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
    const countedPrevious = countedIdsOf(previousContent, files);
    const countedNext = countedIdsOf(nextContent, files);

    return { next: next.filter((id) => countedNext.has(id)), previous: previous.filter((id) => countedPrevious.has(id)) };
};

/**
 * Grant `toUserId` the files of `content` that `fromUserId` (a fork's source author)
 * holds a grant for and the workflow counts ({@link countedIdsOf}): image and frame files,
 * and reference media. A document is never granted: its extracted text would reach the
 * forker's prompts through `/chat/start`. An id the author holds no grant for is never granted.
 */
export const grantWorkflowFiles = async (db: MutationCtx["db"], fromUserId: string, toUserId: string, content: unknown): Promise<void> => {
    const files = await grantedFiles(db, fromUserId, workflowFileIds(content));
    const fileIds = [...countedIdsOf(content, files)] as Id<"chatFiles">[];

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

/**
 * Signs the image files the owner holds a grant for. Only an `imageFileId` gets a URL
 * (`imageUrl`), so only those are signed: a file node's file is played or read by id.
 */
export const signWorkflowImages = async <T>(context: Pick<QueryCtx, "db" | "storage">, ownerId: string | undefined, content: T): Promise<T> => {
    const fileIds = imageFileIdsOf(content);

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
