/**
 * Finalize a reference-media upload (`purpose=reference-media`, see
 * `lib/upload-route.ts`): a workflow's video or audio, checked and stored as a
 * chat file so a media node can point at it by `fileId`.
 *
 * It is the streaming sibling of `takeStagedUpload` in `lib/chat-upload.ts`,
 * because a 50 MB video cannot take that path. `storeFile` buffers the whole
 * object and `ctx.storage.store` caps a stream at 16 MiB, so the bytes are
 * read in ranges: one pass hashes them through a counting stream, and the
 * content-addressed object is then written as an R2 multipart upload, one
 * range per part. Memory stays at one part, however large the file.
 *
 * Shares what matters with the chat path: the content key is
 * `agent-files/<sha256>`, identical bytes dedupe through
 * `agent.files.useExistingFile` / `addFile`, and the caller gets a
 * `chatFileAccess` grant. The file's `refcount` counts a saved workflow that
 * names it (`workflow/images.ts` counts a file node's `fileId` only for
 * video or audio: this purpose is the only way a workflow gets one, so a
 * workflow saved before it can never have added a count it would later release),
 * so an upload no workflow names is swept after a day, as an unattached chat file is. The
 * staging object is deleted whatever the outcome. Extraction is not scheduled:
 * media is not a document.
 *
 * It reads only the reference-media staging key, and refuses an object whose
 * `purpose` stamp is not `reference-media` (`lib/upload-route.ts`).
 */
import { R2_PART_SIZE } from "@lunora/storage/upload";
import { LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { CHAT_UPLOAD_CONTENT_MISMATCH, CHAT_UPLOAD_EXPIRED, CHAT_UPLOAD_TOO_LARGE, CHAT_UPLOAD_UNSUPPORTED_TYPE } from "./chat-upload-codes";
import { isUploadId, stagedPurposeIs, stagingKeyFor } from "./chat-upload-staging";
import { normalizeContentType } from "./chat-upload";
import { referenceMediaLimitFor } from "./document-limits";
import { storageLogger } from "./logger";
import { signedReadUrl } from "./storage-read";

/** The leading bytes the type check reads: the brand and the WAVE form sit at 8-11, the MPEG header is 4 bytes. */
const HEAD_BYTES = 16;

/**
 * The major brands an MP4 may declare (bytes 8-11): ISO base media (`iso2`-`iso9`, matched by
 * {@link ISO_BASE_BRAND}), the MP4 profiles, the 3GPP and 3GPP2 forms, Sony's XAVC, Adobe's F4V and the
 * DASH forms. HEIC/HEIX/HEVC/MIF1/MSF1 (images), AVIF/AVIS (AV1 images) and M4A (audio) are deliberately absent.
 * Only the major brand is read: compatible brands sit past the head this check reads, and a HEIF or M4A file
 * lists MP4 brands among its compatible ones, so they are no evidence of a video.
 */
const MP4_BRANDS: ReadonlySet<string> = new Set([
    "3g2a",
    "3g2b",
    "3g2c",
    "3gp4",
    "3gp5",
    "3gp6",
    "avc1",
    "dash",
    "f4v ",
    "isom",
    "M4V ",
    "M4VP",
    "mmp4",
    "mp41",
    "mp42",
    "mp71",
    "MSNV",
    "XAVC",
]);

/** The ISO base media brands `iso2` to `iso9` (`isom` is in {@link MP4_BRANDS}). */
const ISO_BASE_BRAND = /^iso[2-9]$/u;

const isMp4Brand = (brand: string): boolean => MP4_BRANDS.has(brand) || ISO_BASE_BRAND.test(brand);

/** How far past the start of the audio (after any ID3 tag) the first MPEG frame header may sit: zero padding and a short run of junk, never a whole file. */
export const MPEG_SCAN_BYTES = 4096;

/** The QuickTime major brand, `qt` and two spaces. */
const QUICKTIME_BRAND = "qt  ";

const ascii = (text: string): number[] => [...text].map((character) => character.codePointAt(0) ?? 0);

const at = (head: Uint8Array, offset: number, text: string): boolean => {
    const bytes = ascii(text);

    return head.length >= offset + bytes.length && bytes.every((byte, index) => head[offset + index] === byte);
};

/** The four bytes at `offset` as text, or "" when the head is too short to hold them. */
const brandAt = (head: Uint8Array, offset: number): string => (head.length >= offset + 4 ? new TextDecoder().decode(head.subarray(offset, offset + 4)) : "");

/**
 * A valid MPEG audio frame header: the sync word, a version other than the
 * reserved one, Layer III, a bitrate index that is not the "bad" value and a
 * sample rate that is not reserved. The bytes `FF Ex` alone match far too much.
 */
export const isMpegFrameHeader = (bytes: Uint8Array): boolean => {
    if (bytes.length < 4) {
        return false;
    }

    const [first = 0, second = 0, third = 0] = bytes;
    const version = (second >> 3) & 0b11;
    const layer = (second >> 1) & 0b11;
    const bitrate = (third >> 4) & 0b1111;
    const sampleRate = (third >> 2) & 0b11;

    return first === 0xff && (second & 0xe0) === 0xe0 && version !== 0b01 && layer === 0b01 && bitrate !== 0b1111 && sampleRate !== 0b11;
};

/** The index of the first valid MPEG frame header in `bytes`, or `-1`. */
export const findMpegFrame = (bytes: Uint8Array): number => {
    for (let index = 0; index + 4 <= bytes.length; index += 1) {
        if (isMpegFrameHeader(bytes.subarray(index, index + 4))) {
            return index;
        }
    }

    return -1;
};

/**
 * Where the audio of a file starts: after an ID3v2 tag when it has one. The tag's size is a syncsafe integer in bytes 6-9, and a footer
 * (flag 0x10) adds ten more bytes.
 */
export const mpegFrameOffset = (head: Uint8Array): number => {
    if (!at(head, 0, "ID3") || head.length < 10) {
        return 0;
    }

    const flags = head[5] ?? 0;
    const size = ((head[6] ?? 0) & 0x7f) * 2 ** 21 + ((head[7] ?? 0) & 0x7f) * 2 ** 14 + ((head[8] ?? 0) & 0x7f) * 2 ** 7 + ((head[9] ?? 0) & 0x7f);

    return 10 + size + ((flags & 0x10) === 0 ? 0 : 10);
};

/**
 * Whether the leading bytes are a `contentType` this path accepts. A container
 * or stream signature, not a parser. MP4 has `ftyp` at 4 and an MP4 major brand
 * at 8; QuickTime has `ftyp` at 4 and `qt  ` at 8 (a QuickTime file that starts
 * with `moov` is refused, which the upload form says). MP3 needs a valid MPEG
 * frame header within {@link MPEG_SCAN_BYTES} of the audio's start, passed in as
 * `mpegWindow`: the bytes from {@link mpegFrameOffset} on (see {@link findMpegFrame}).
 * WAV is `RIFF` at 0 and `WAVE` at 8.
 */
export const referenceMediaMatches = (head: Uint8Array, contentType: string, mpegWindow?: Uint8Array): boolean => {
    switch (contentType) {
        case "audio/mpeg": {
            return mpegWindow !== undefined && findMpegFrame(mpegWindow) !== -1;
        }
        case "audio/wav":
        case "audio/x-wav": {
            return at(head, 0, "RIFF") && at(head, 8, "WAVE");
        }
        case "video/mp4": {
            return at(head, 4, "ftyp") && isMp4Brand(brandAt(head, 8));
        }
        case "video/quicktime": {
            return at(head, 4, "ftyp") && brandAt(head, 8) === QUICKTIME_BRAND;
        }
        default: {
            return false;
        }
    }
};

const tooLarge = (maxBytes: number): LunoraError =>
    new LunoraError("PAYLOAD_TOO_LARGE", `Files of this type can be at most ${String(Math.floor(maxBytes / (1024 * 1024)))} MB.`, {
        data: { code: CHAT_UPLOAD_TOO_LARGE, maxBytes },
    });

const expired = (): LunoraError =>
    new LunoraError("NOT_FOUND", "The upload expired or was never completed. Please attach the file again.", { data: { code: CHAT_UPLOAD_EXPIRED } });

const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The object's bytes in `range`, as a buffer. The staging object is read a range at a time, never whole. */
const readRange = async (ctx: Pick<ActionCtx, "storage">, key: string, offset: number, length: number): Promise<Uint8Array> => {
    const object = await ctx.storage.download(key, { range: { length, offset } });

    if (!object?.body) {
        throw expired();
    }

    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());

    if (bytes.byteLength !== length) {
        throw expired();
    }

    return bytes;
};

/**
 * SHA-256 of the whole staging object, streamed. Counts the bytes it reads too,
 * so a stored object that disagrees with its own metadata (or grows past its
 * cap) is refused rather than hashed.
 */
const digestOf = async (ctx: Pick<ActionCtx, "storage">, key: string, size: number, maxBytes: number): Promise<string> => {
    const object = await ctx.storage.download(key);

    if (!object?.body) {
        throw expired();
    }

    let seen = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            seen += chunk.byteLength;

            if (seen > maxBytes) {
                controller.error(tooLarge(maxBytes));

                return;
            }

            controller.enqueue(chunk);
        },
    });
    const digest = new crypto.DigestStream("SHA-256");

    await object.body.pipeThrough(counter).pipeTo(digest);

    if (seen !== size) {
        throw expired();
    }

    return hex(await digest.digest);
};

/**
 * Write `size` bytes from the staging object to `storageKey` as one multipart
 * upload, a range per part, while a second digest checks them against `hash`.
 * The upload is only completed when the bytes match, so the content-addressed
 * key never holds bytes that differ from its name; otherwise it is aborted.
 */
const storeContentAddressed = async (
    ctx: ActionCtx,
    stagingKey: string,
    storageKey: string,
    { contentType, hash, size }: { contentType: string; hash: string; size: number },
): Promise<void> => {
    const upload = await ctx.storage.createMultipartUpload(storageKey, { contentType });

    try {
        const digest = new crypto.DigestStream("SHA-256");
        const writer = digest.getWriter();
        const parts: { etag: string; partNumber: number }[] = [];

        for (let offset = 0, partNumber = 1; offset < size; offset += R2_PART_SIZE, partNumber += 1) {
            const length = Math.min(R2_PART_SIZE, size - offset);
            const bytes = await readRange(ctx, stagingKey, offset, length);

            await writer.write(bytes);
            parts.push(await upload.uploadPart(partNumber, bytes));
        }

        await writer.close();

        if (hex(await digest.digest) !== hash) {
            throw expired();
        }

        await upload.complete(parts);
    } catch (error) {
        await upload.abort().catch((abortError: unknown) => {
            storageLogger.warn(`Failed to abort reference-media upload ${storageKey}`, abortError);
        });

        throw error;
    }
};

/**
 * Turn `userId`'s staged `uploadId` into a reference-media chat file: checked
 * against {@link referenceMediaLimitFor} and its own type's leading bytes,
 * stored content-addressed with a grant for `userId`. The staging object is
 * deleted whatever the outcome.
 */
export const finalizeStagedReferenceMedia = async (
    ctx: ActionCtx,
    userId: string,
    args: { filename: string; uploadId: string },
): Promise<{ fileId: Id<"chatFiles">; url: string }> => {
    if (!isUploadId(args.uploadId)) {
        throw expired();
    }

    const key = stagingKeyFor(userId, args.uploadId, "reference-media");

    try {
        const metadata = await ctx.storage.getMetadata(key);

        if (!metadata) {
            throw expired();
        }

        if (!stagedPurposeIs(metadata.customMetadata, "reference-media")) {
            throw new LunoraError("BAD_REQUEST", "This upload was not made as reference media.", { data: { code: CHAT_UPLOAD_UNSUPPORTED_TYPE } });
        }

        const contentType = normalizeContentType(metadata.contentType ?? "");
        const maxBytes = referenceMediaLimitFor(contentType);

        if (maxBytes === undefined) {
            throw new LunoraError("BAD_REQUEST", "This file type cannot be used as reference media.", { data: { code: CHAT_UPLOAD_UNSUPPORTED_TYPE } });
        }

        if (metadata.size > maxBytes) {
            throw tooLarge(maxBytes);
        }

        if (metadata.size === 0) {
            throw new LunoraError("BAD_REQUEST", "The file is empty.");
        }

        const head = await readRange(ctx, key, 0, Math.min(HEAD_BYTES, metadata.size));
        // Only an MP3 needs its frames: one more range, from the audio's start, bounded
        // to the scan window, and only when the file holds a frame header there at all.
        const audioOffset = mpegFrameOffset(head);
        const windowLength = Math.min(MPEG_SCAN_BYTES + 4, metadata.size - audioOffset);
        const mpegWindow = contentType === "audio/mpeg" && windowLength >= 4 ? await readRange(ctx, key, audioOffset, windowLength) : undefined;

        if (!referenceMediaMatches(head, contentType, mpegWindow)) {
            throw new LunoraError("BAD_REQUEST", "The file's contents do not match its type.", { data: { code: CHAT_UPLOAD_CONTENT_MISMATCH } });
        }

        const hash = await digestOf(ctx, key, metadata.size, maxBytes);
        const reused = await ctx.runMutation(internal.agent.files.useExistingFile, { filename: args.filename, hash, userId });

        if (reused) {
            return { fileId: reused.fileId as Id<"chatFiles">, url: await signedReadUrl(ctx.storage, reused.storageId) };
        }

        const storageKey = `agent-files/${hash}`;

        await storeContentAddressed(ctx, key, storageKey, { contentType, hash, size: metadata.size });

        const { fileId, storageId } = await ctx.runMutation(internal.agent.files.addFile, {
            filename: args.filename,
            hash,
            mediaType: contentType,
            storageId: storageKey,
            userId,
        });

        return { fileId: fileId as Id<"chatFiles">, url: await signedReadUrl(ctx.storage, storageId) };
    } finally {
        await ctx.storage.delete(key).catch((error: unknown) => {
            storageLogger.warn(`Failed to delete staged reference media ${key}`, error);
        });
    }
};
