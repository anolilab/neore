/**
 * The files an answer to an `askUser` question carries (`chat/ask-user.ts`),
 * read for the one continuation that answers it.
 *
 * Each id is checked the way every client file id is: `agent.files.getFileForUser`
 * as the thread owner (the run's user). A file the owner may not use, a file
 * that is not an allowed type, or one over the size cap is LEFT OUT, not
 * an error — so an answer never reveals that someone else's file id exists.
 * The bytes are read here only and handed to the model in that call's result;
 * they are never stored on the message.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import { readStoredObject } from "../../lib/storage-read";
import type { AskUserFile } from "../tools/ask-user-constants";
import { ASK_USER_FILE_MAX_BYTES, ASK_USER_FILE_TYPES, ASK_USER_MAX_FILES } from "../tools/ask-user-constants";

/** The error codes that mean "leave this file out" rather than "the read failed". */
const SKIP_CODES: ReadonlySet<string> = new Set(["NOT_FOUND", "PAYLOAD_TOO_LARGE"]);

/** Bytes converted per `String.fromCodePoint` call: a call with the whole file spread into it overflows the stack. */
const CHUNK_BYTES = 32_768;

const toBase64 = (bytes: ArrayBuffer): string => {
    const view = new Uint8Array(bytes);
    let binary = "";

    for (let offset = 0; offset < view.length; offset += CHUNK_BYTES) {
        binary += String.fromCodePoint(...view.subarray(offset, offset + CHUNK_BYTES));
    }

    return btoa(binary);
};

export const loadAskUserFiles = async (
    ctx: Pick<ActionCtx, "runQuery" | "storage">,
    args: { fileIds: ReadonlyArray<string>; threadId: string; userId: string },
): Promise<AskUserFile[]> => {
    const files: AskUserFile[] = [];
    const ids = [...new Set(args.fileIds)].slice(0, ASK_USER_MAX_FILES);

    for (const fileId of ids) {
        const file = await ctx.runQuery(internal.agent.files.getFileForUser, {
            fileId: fileId as Id<"chatFiles">,
            threadId: args.threadId as Id<"threads">,
            userId: args.userId,
        });

        if (!file || !ASK_USER_FILE_TYPES.includes(file.mediaType)) {
            continue;
        }

        try {
            const { bytes } = await readStoredObject(ctx.storage, file.storageId, { maxBytes: ASK_USER_FILE_MAX_BYTES });

            files.push({ data: toBase64(bytes), filename: file.filename ?? "file", mediaType: file.mediaType });
        } catch (error) {
            // Only "gone" and "too big" are the file's fault; a failed read is the run's, and it fails as one.
            if (error instanceof LunoraError && SKIP_CODES.has(error.code)) {
                continue;
            }

            throw error;
        }
    }

    return files;
};
