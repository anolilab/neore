/**
 * Display URLs for workflow images kept by file reference (`imageFileId`).
 *
 * The stored content names the file and never a URL, because a signed URL expires. On
 * read, each such node gets a fresh `imageUrl` — but only when the workflow's OWNER holds
 * a grant for the file. A viewer of a shared or gallery workflow therefore sees exactly
 * what the author could see: no grant is written for anyone else, and unpublishing the
 * workflow ends the viewer's access with it.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { displayUrlExpiresInSeconds } from "../lib/storage-ref";

interface ImageNode {
    data?: { imageFileId?: unknown; imageUrl?: unknown };
}

const isImageNodeList = (nodes: unknown): nodes is ImageNode[] => Array.isArray(nodes);

export const signWorkflowImages = async <T>(context: Pick<QueryCtx, "db" | "storage">, ownerId: string | undefined, content: T): Promise<T> => {
    const nodes = (content as { nodes?: unknown } | null)?.nodes;

    if (!ownerId || !isImageNodeList(nodes)) {
        return content;
    }

    const fileIds = [...new Set(nodes.map((node) => node.data?.imageFileId).filter((id): id is string => typeof id === "string"))];

    if (fileIds.length === 0) {
        return content;
    }

    const expiresInSeconds = displayUrlExpiresInSeconds();
    const urls = new Map<string, string>();

    for (const fileId of fileIds) {
        const grant = await context.db.chatFileAccess.findFirst({ where: { fileId: fileId as Id<"chatFiles">, userId: ownerId } });

        if (!grant) {
            continue;
        }

        const file = await context.db.chatFiles.findFirst({ where: { _id: fileId as Id<"chatFiles"> } });

        if (file) {
            urls.set(fileId, await context.storage.getSignedUrl(file.storageId, { expiresInSeconds }));
        }
    }

    return {
        ...content,
        nodes: nodes.map((node) => {
            const url = typeof node.data?.imageFileId === "string" ? urls.get(node.data.imageFileId) : undefined;

            return url && node.data ? { ...node, data: { ...node.data, imageUrl: url } } : node;
        }),
    } as T;
};
