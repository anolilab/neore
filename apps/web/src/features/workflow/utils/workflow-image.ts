import { uploadChatAttachment } from "@/features/chat/core/adapters/lunora-attachment-adapter";
import type { LunoraReactClient as LunoraClient } from "@/lib/lunora/crpc";

/** Uploads an image that is too large to inline in the workflow save, through the chat attachment path. Resolves to its `chatFiles` id. */
export const storeWorkflowImage = async (lunora: LunoraClient, file: File): Promise<string> => {
    const { fileId } = await uploadChatAttachment(lunora, file);

    return fileId;
};

const imageSelections = new Map<string, number>();

/** Marks a new image choice on a node; an earlier choice still loading must then be dropped. */
export const startImageSelection = (nodeId: string): number => {
    const token = (imageSelections.get(nodeId) ?? 0) + 1;

    imageSelections.set(nodeId, token);

    return token;
};

export const isCurrentImageSelection = (nodeId: string, token: number): boolean => imageSelections.get(nodeId) === token;
