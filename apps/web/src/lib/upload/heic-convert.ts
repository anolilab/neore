import { isSafariUserAgent } from "@/features/local-models/lib/local-errors";

import { heicToJpegBlob } from "./heic-decode";

/**
 * HEIC and HEIF photos are re-encoded as JPEG before upload, because the upload route takes JPEG, not HEIC. Only Safari
 * decodes HEIC in the browser, so only the WebKit browsers (desktop Safari and every browser on iOS) convert: any other browser
 * keeps the file as it is, and the server refuses it.
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

/** The name a converted photo is uploaded under: the name without its extension, with a `.jpg` one. */
export const jpegNameFor = (name: string): string => `${name.replace(EXTENSION_RE, "")}.jpg`;

/** iPhone, iPad and iPod: every browser on them runs WebKit (the platform requires it), and WebKit decodes HEIC from iOS 11. */
const IOS_DEVICE_RE = /\b(?:iPhone|iPad|iPod)\b/u;
/** iPadOS 13 and later report a desktop Macintosh user agent; a touch screen is what tells them apart from a Mac. */
const MACINTOSH_RE = /\bMacintosh\b/u;

/**
 * Whether a browser decodes HEIC itself: desktop Safari, or any browser on iOS and iPadOS. Chromium and Firefox on a computer
 * or on Android do not, so they keep the file and the server refuses it. The user agent does not name the engine, so an
 * iOS browser that runs another engine would be told to convert; its decode then fails and the photo is refused, never sent as HEIC.
 */
export const decodesHeic = (userAgent: string | undefined, touchPoints = 0): boolean => {
    if (!userAgent) {
        return false;
    }

    if (IOS_DEVICE_RE.test(userAgent) || (MACINTOSH_RE.test(userAgent) && touchPoints > 1)) {
        return true;
    }

    return isSafariUserAgent(userAgent);
};

/** Whether this browser decodes HEIC, which makes it the one that converts it here. */
export const canConvertHeic = (): boolean => decodesHeic(globalThis.navigator?.userAgent, globalThis.navigator?.maxTouchPoints);

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
