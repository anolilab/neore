import { api } from "@neore/backend/api";

import type { LunoraReactClient as LunoraClient } from "@/lib/lunora/crpc";
import { uploadFile } from "@/lib/upload/upload-file";

/** Uploads an image that is too large to inline in the workflow save. Resolves to its `chatFiles` id. */
export const storeWorkflowImage = async (lunora: LunoraClient, file: File): Promise<string> => {
    const uploadId = await uploadFile(file, { contentType: file.type });
    const { fileId } = await lunora.action(api.file.finalizeChatUpload, { filename: file.name, uploadId });

    return fileId;
};
