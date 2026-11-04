/**
 * The files an answer to an `askUser` question carries (`chat/ask-user.ts`),
 * read for the one continuation that answers it.
 *
 * Each id is checked the way every client file id is: `agent.files.getFileForUser`
 * as the thread owner (the run's user). A file the owner may not use, a file
 * that is not an allowed type, or one over the size cap is LEFT OUT, not
 * an error — so an answer never reveals that someone else's file id exists.
 * The bytes are read here only and handed to the model for that one call
 * (`answerFilesMessage`); they are never stored on a message.
 */
import { LunoraError } from "lunorash/server";
import type { ModelMessage } from "ai";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import { streamLogger } from "../../lib/logger";
import { readStoredObject } from "../../lib/storage-read";
import type { AskUserFile } from "../tools/ask-user-constants";
import type { BackupCapabilities } from "./backup-model";
import {
    ASK_USER_FILE_MAX_BYTES,
    ASK_USER_FILE_TYPES,
    ASK_USER_FILES_TOTAL_MAX_BYTES,
    ASK_USER_IMAGE_MAX_BYTES,
    ASK_USER_MAX_FILES,
} from "../tools/ask-user-constants";

/**
 * The readable answer files as one user message for the continuation's first model call. It is never saved: the answer's
 * stored output names the files and carries no bytes, so this message exists only in the model's input for that step.
 */
export const answerFilesMessage = (files: ReadonlyArray<AskUserFile>): ModelMessage | undefined => {
    if (files.length === 0) {
        return undefined;
    }

    return {
        content: [
            { text: "The files attached to the answer are below, in the order they were attached.", type: "text" },
            ...files.map((file) =>
                file.mediaType === "application/pdf"
                    ? { data: file.data, filename: file.filename, mediaType: file.mediaType, type: "file" as const }
                    : { image: file.data, mediaType: file.mediaType, type: "image" as const },
            ),
        ],
        role: "user",
    };
};

/** A file the answer does not carry, logged with its reason and no name or content, so a missing attachment can be traced. */
const skipped = (args: { threadId: string }, fileId: string, reason: string): void => {
    streamLogger.warn(`[AskUser] Answer file ${fileId} left out (${reason}) in thread ${args.threadId}`);
};

/**
 * The model input of one step with the answer's files at its end. A copy carried from an earlier step is taken out
 * first, so the carried messages never hold two; everything else (compression, steering) is kept as it is.
 */
export const withAnswerFiles = <T>(messages: ReadonlyArray<T>, files: T): T[] => [...messages.filter((message) => message !== files), files];

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

/**
 * The answer's files the run's model can read. The run keeps the model it started with, which Auto may have picked for a
 * turn without attachments, so a file the model cannot read is left out (its name still reaches the answer) rather than
 * failing the resumed call. A model the catalogue does not know reads none of them.
 */
export const filesTheModelReads = (files: ReadonlyArray<AskUserFile>, readable: BackupCapabilities | undefined): AskUserFile[] =>
    files.filter((file) => readable?.[file.mediaType.startsWith("image/") ? "images" : "files"] === true);

export const loadAskUserFiles = async (
    ctx: Pick<ActionCtx, "runQuery" | "storage">,
    args: { fileIds: ReadonlyArray<string>; threadId: string; userId: string },
): Promise<AskUserFile[]> => {
    const files: AskUserFile[] = [];
    const ids = [...new Set(args.fileIds)].slice(0, ASK_USER_MAX_FILES);
    let total = 0;

    for (const fileId of ids) {
        const file = await ctx.runQuery(internal.agent.files.getFileForUser, {
            fileId: fileId as Id<"chatFiles">,
            threadId: args.threadId as Id<"threads">,
            userId: args.userId,
        });

        if (!file || !ASK_USER_FILE_TYPES.includes(file.mediaType)) {
            skipped(args, fileId, file ? "type" : "unavailable");
            continue;
        }

        // What is left of the answer's budget: a file that would exceed it is left out like an oversized one.
        const remaining = ASK_USER_FILES_TOTAL_MAX_BYTES - total;

        if (remaining <= 0) {
            skipped(args, fileId, "budget");
            break;
        }

        try {
            const limit = file.mediaType.startsWith("image/") ? ASK_USER_IMAGE_MAX_BYTES : ASK_USER_FILE_MAX_BYTES;
            const { bytes } = await readStoredObject(ctx.storage, file.storageId, { maxBytes: Math.min(limit, remaining) });

            total += bytes.byteLength;
            files.push({ data: toBase64(bytes), filename: file.filename ?? "file", mediaType: file.mediaType });
        } catch (error) {
            // Only "gone" and "too big" are the file's fault; a failed read is the run's, and it fails as one.
            if (error instanceof LunoraError && SKIP_CODES.has(error.code)) {
                skipped(args, fileId, error.code === "PAYLOAD_TOO_LARGE" ? "too-large" : "missing");
                continue;
            }

            throw error;
        }
    }

    return files;
};
