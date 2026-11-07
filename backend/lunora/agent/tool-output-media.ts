/**
 * Inline media in a tool result, moved to storage before the result is saved.
 *
 * A tool returns an image as base64 inside its output: an MCP server's `image`,
 * `audio` and `resource` blob items, the browser tool's `screenshot`, the code
 * tool's image `results`. Saved as is, the bytes sit in the message row (a full
 * page screenshot is megabytes, and a shard row holds at most 2 MB, so the step
 * save fails) and later turns hand them to the model again as JSON text. Past
 * {@link MAX_FILE_SIZE} decoded bytes the base64 is replaced by a `storage:<key>`
 * reference to a stored chat file, the same reference generated `file` parts
 * get (`agent/mapping.ts`).
 *
 * Nothing new is trusted on the way back: `agent/stored-media.ts` signs a
 * reference inside a tool result only when the message's owner owns the key, so
 * a tool that writes a `storage:` look-alike of a key its user does not own gets
 * an empty string, never a link. Only real base64 in the known fields is moved:
 * a string that merely looks like a reference or a URL is never stored. Like SVG
 * markup, it stays as the tool wrote it while the row's share for small media
 * lasts, and is dropped (and counted) past it.
 *
 * The browser and code tools' media moves to a field of its own (`screenshotUrl`,
 * a result's `url`) that only this module writes, so the transcript loads an image
 * from a URL only when the server put one there, never from a string a tool chose.
 */
import { storageLogger } from "../lib/logger";
import { STORAGE_REF_PREFIX, toStorageRef } from "../lib/storage-ref";
import { isRecord } from "../lib/storage-sign";
import { MAX_FILE_SIZE, STORE_MAX_BYTES } from "./client/files";

/**
 * Stores base64 media as a chat file owned by the run's user; returns its file id and storage key. Given the same
 * base64 twice, it must return the same file: two stores of one object at once would each count it.
 */
export type StoreToolMedia = (base64: string, mediaType: string) => Promise<{ fileId: string; storageId: string }>;

/** The tool names whose own output shapes are known here. MCP tools are always named `mcp_<server>__<tool>`. */
export const BROWSER_TOOL = "browser";
export const CODE_TOOL = "codeExecution";

/**
 * When storing fails, blobs stay inline as before while the base64 kept in one step's row stays within this many
 * characters (a row holds at most 2 MB); past it they are dropped and the output's {@link UNSAVED_MEDIA_FIELD} counts them.
 */
export const INLINE_FALLBACK_CHARS = 1024 * 1024;

/**
 * Base64 under the per-field budget a step's row keeps inline in total. Many small images (a few dozen charts, a page
 * of thumbnails) would fill the row as surely as one large one, so past this they are stored too.
 */
export const SMALL_INLINE_CHARS = 512 * 1024;

/** What one step's row has left: every tool result of a step is saved in the same row. */
export interface InlineBudget {
    /** For blobs kept inline because storing them failed. */
    fallbackChars: number;
    /** For blobs under the per-field budget, kept inline without storing. */
    smallChars: number;
}

export const stepInlineBudget = (): InlineBudget => {
    return { fallbackChars: INLINE_FALLBACK_CHARS, smallChars: SMALL_INLINE_CHARS };
};

/** Without `key`: a field this module writes must never arrive from the tool. */
const without = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
    key in record ? Object.fromEntries(Object.entries(record).filter(([name]) => name !== key)) : record;

/** How many media fields could be neither stored nor kept: the model and the transcript see that something is missing. */
export const UNSAVED_MEDIA_FIELD = "unsavedMedia";

const BASE64 = /^[\d+/A-Za-z]+={0,2}$/u;

/** A `data:` URL's head, which some tools put in front of the base64. */
const DATA_URL_HEAD = /^data:[\w.+-]{1,64}\/[\w.+-]{1,64};base64,/u;

const WHITESPACE = /\s+/gu;

/** `value` as plain base64, without a `data:` head or MIME line breaks; `undefined` when it is not base64 at all. */
const plainBase64 = (value: string): string | undefined => {
    const body = value.replace(DATA_URL_HEAD, "").replaceAll(WHITESPACE, "");

    return BASE64.test(body) ? body : undefined;
};

/** Passive types storage may serve inline (`lib/signed-storage.ts`); anything else is kept as opaque bytes. */
const STORED_MEDIA_TYPE = /^(?:image\/(?:png|jpeg|gif|webp|avif)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/u;

/** Formats the browser and code tools report for a raster image. SVG is markup, not base64: it is never stored. */
const RASTER_FORMAT = /^(?:png|jpe?g|webp|gif)$/u;

/** Bytes `base64` decodes to: three per four characters, less its `=` padding. */
const decodedSize = (base64: string): number => {
    let padding = 0;

    while (padding < 2 && base64.at(-1 - padding) === "=") {
        padding += 1;
    }

    return Math.floor((base64.length * 3) / 4) - padding;
};

const storedMediaType = (value: unknown): string => {
    const mediaType = typeof value === "string" ? value.toLowerCase() : "";

    return STORED_MEDIA_TYPE.test(mediaType) ? mediaType : "application/octet-stream";
};

const rasterMediaType = (format: string): string => `image/${format === "jpg" ? "jpeg" : format}`;

/** What became of one field: left as it was, stored (its reference), or dropped because it could not be stored. */
type Moved = { kind: "dropped" } | { kind: "kept" } | { kind: "stored"; ref: string };

/** `items` mapped one at a time, so a step's stores and its inline budget are taken in order. */
const mapInOrder = async <T>(items: ReadonlyArray<T>, map: (item: T) => Promise<T>): Promise<T[]> => {
    const mapped: T[] = [];

    for (const item of items) {
        mapped.push(await map(item));
    }

    return mapped;
};

/**
 * `output` with every oversized inline media field replaced by a storage
 * reference, and the chat files those references name. An output with nothing
 * to move comes back as the same value.
 */
export const offloadToolOutputMedia = async (
    toolName: string,
    output: unknown,
    store: StoreToolMedia,
    inline: InlineBudget = stepInlineBudget(),
    budgetBytes: number = MAX_FILE_SIZE,
): Promise<{ fileIds: string[]; output: unknown }> => {
    if (!isRecord(output)) {
        return { fileIds: [], output };
    }

    const fileIds: string[] = [];
    let unsaved = 0;

    /** Media that cannot be stored (markup, or text that is not plain base64): kept while the row's share lasts. */
    const keepInline = (value: string): Moved => {
        if (value.length <= inline.smallChars) {
            inline.smallChars -= value.length;

            return { kind: "kept" };
        }

        unsaved += 1;

        return { kind: "dropped" };
    };

    const move = async (value: unknown, mediaType: string): Promise<Moved> => {
        if (typeof value !== "string") {
            return { kind: "kept" };
        }

        // A reference (a tool may echo one) is never stored or decoded again, but it takes room in the row like any text.
        const base64 = value.startsWith(STORAGE_REF_PREFIX) ? undefined : plainBase64(value);

        if (base64 === undefined) {
            return keepInline(value);
        }

        const size = decodedSize(base64);

        if (size <= budgetBytes && value.length <= inline.smallChars) {
            inline.smallChars -= value.length;

            return { kind: "kept" };
        }

        if (size > STORE_MAX_BYTES) {
            // Storage refuses it anyway, and decoding and hashing it first would only spend the Worker's memory.
            unsaved += 1;

            return { kind: "dropped" };
        }

        try {
            const { fileId, storageId } = await store(base64, mediaType);

            fileIds.push(fileId);

            return { kind: "stored", ref: toStorageRef(storageId) };
        } catch (error) {
            // The step must still save: a thrown save leaves its row pending for good.
            storageLogger.warn("tool_output_media.store_failed", { error: error instanceof Error ? error.message : String(error), size, toolName });

            if (value.length <= inline.fallbackChars) {
                inline.fallbackChars -= value.length;

                return { kind: "kept" };
            }

            unsaved += 1;

            return { kind: "dropped" };
        }
    };

    let next: Record<string, unknown> = output;

    // MCP `CallToolResult`: `content` items carry `data` (image, audio) or `resource.blob`.
    if (Array.isArray(output["content"])) {
        const items = output["content"] as unknown[];
        const content = await mapInOrder(items, async (item) => {
            if (!isRecord(item)) {
                return item;
            }

            if (item["type"] === "image" || item["type"] === "audio") {
                const moved = await move(item["data"], storedMediaType(item["mimeType"]));

                return moved.kind === "kept" ? item : { ...item, data: moved.kind === "stored" ? moved.ref : "" };
            }

            const { resource } = item;

            if (item["type"] === "resource" && isRecord(resource)) {
                const moved = await move(resource["blob"], storedMediaType(resource["mimeType"]));

                return moved.kind === "kept" ? item : { ...item, resource: { ...resource, blob: moved.kind === "stored" ? moved.ref : "" } };
            }

            return item;
        });

        if (content.some((item, index) => item !== items[index])) {
            next = { ...next, content };
        }
    }

    const format = output["screenshotFormat"];

    if (toolName === BROWSER_TOOL) {
        next = without(next, "screenshotUrl");

        if (typeof format === "string" && RASTER_FORMAT.test(format)) {
            const moved = await move(output["screenshot"], rasterMediaType(format));

            if (moved.kind !== "kept") {
                const rest = without(next, "screenshot");

                next = moved.kind === "stored" ? { ...rest, screenshotUrl: moved.ref } : rest;
            }
        }
    }

    if (toolName === CODE_TOOL && Array.isArray(output["results"])) {
        const items = output["results"] as unknown[];
        const results = await mapInOrder(items, async (item) => {
            if (!isRecord(item)) {
                return item;
            }

            const own = without(item, "url");

            if (own["type"] !== "image" || typeof own["format"] !== "string") {
                return own;
            }

            if (!RASTER_FORMAT.test(own["format"])) {
                // SVG markup: nothing to store, but it fills the row like any other image.
                return typeof own["value"] === "string" && keepInline(own["value"]).kind === "dropped" ? { ...own, value: "" } : own;
            }

            const moved = await move(own["value"], rasterMediaType(own["format"]));

            if (moved.kind === "kept") {
                return own;
            }

            return moved.kind === "stored" ? { ...own, url: moved.ref, value: "" } : { ...own, value: "" };
        });

        if (results.some((item, index) => item !== items[index])) {
            next = { ...next, results };
        }
    }

    if (unsaved > 0) {
        next = { ...next, [UNSAVED_MEDIA_FIELD]: unsaved };
    }

    return { fileIds, output: next };
};
