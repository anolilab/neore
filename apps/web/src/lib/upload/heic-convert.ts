import { isSafariUserAgent } from "@/features/local-models/lib/local-errors";

import { heicToJpegBlob } from "./heic-decode";

/**
 * HEIC and HEIF photos are re-encoded as JPEG before upload, because the upload route takes JPEG, not HEIC. Only Safari
 * decodes HEIC in the browser, so only Safari converts: any other browser keeps the file as it is, and the server refuses it.
 * A sequence (several frames in one file) is not a photo to convert: one JPEG would keep one frame, so it keeps its type too.
 */
const HEIC_TYPES: ReadonlySet<string> = new Set(["image/heic", "image/heif"]);
const HEIC_NAME_RE = /\.(?:heic|heif)$/iu;
const EXTENSION_RE = /\.[^./\\]+$/u;
const JPEG_QUALITY = 0.92;

/**
 * A HEIC or HEIF file: by its declared type, or, where the browser gives none, by its name. A file that declares another
 * type keeps it even if its name ends in `.heic`, so a renamed text file is not mistaken for a photo.
 */
export const isHeicFile = (file: Pick<File, "name" | "type">): boolean => {
    const type = file.type.toLowerCase();

    return type === "" ? HEIC_NAME_RE.test(file.name) : HEIC_TYPES.has(type);
};

/** The name a converted photo is uploaded under: the same name with a `.jpg` extension. */
/** The name a converted photo is uploaded under: the name without its extension, with a `.jpg` one. */
export const jpegNameFor = (name: string): string => `${name.replace(EXTENSION_RE, "")}.jpg`;

/** Whether this browser decodes HEIC, which makes it the one that converts it here. */
export const canConvertHeic = (): boolean => isSafariUserAgent(globalThis.navigator?.userAgent);

/** Whether `convertHeicToJpeg` will convert this file: a HEIC or HEIF file in a browser that decodes it. */
export const willConvertHeic = (file: Pick<File, "name" | "type">): boolean => isHeicFile(file) && canConvertHeic();

/**
 * The file as JPEG. A HEIC or HEIF file is converted where the browser can decode it; any other file comes back as it is.
 * A file the decoder cannot read rejects, so the caller can refuse it with a message.
 */
export const convertHeicToJpeg = async (file: File): Promise<File> => {
    if (!willConvertHeic(file)) {
        return file;
    }

    const blob = await heicToJpegBlob(file, JPEG_QUALITY);

    return new File([blob], jpegNameFor(file.name), { lastModified: file.lastModified, type: "image/jpeg" });
};
