/**
 * A cheap check that an uploaded object's bytes are what its declared type says.
 *
 * The type of an upload is what the CLIENT declared on the upload route
 * (`lib/upload-route.ts`) and the object was stored with. The allowlist bounds which types
 * can be served back, and every download is `nosniff` + sandboxed; this adds
 * that a file declared as a PDF, an image or an Office document actually starts
 * like one, and that a "text" file is not binary. It is not a parser: a type
 * with no signature here passes.
 */

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0): boolean =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): number[] => [...text].map((character) => character.codePointAt(0) ?? 0);

const PDF = ascii("%PDF-");
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF = ascii("GIF8");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const BMP = ascii("BM");
const ICO = [0x00, 0x00, 0x01, 0x00];
/** Office Open XML (docx/xlsx/pptx) and every other zip. */
const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** Legacy Office (doc/xls/ppt): an OLE2 compound file. */
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const UTF16_LE = [0xff, 0xfe];
const UTF16_BE = [0xfe, 0xff];

/** How many leading bytes the check looks at. */
export const SNIFF_BYTES = 1024;

const isTextual = (type: string): boolean =>
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/javascript" ||
    type === "application/typescript" ||
    type === "image/svg+xml";

/**
 * Whether `head` (the object's first bytes, {@link SNIFF_BYTES} is plenty) is
 * consistent with `contentType`. `true` for a type this has no rule for.
 */
export const contentMatchesType = (head: Uint8Array, contentType: string): boolean => {
    const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

    switch (type) {
        case "application/msword":
        case "application/vnd.ms-excel":
        case "application/vnd.ms-powerpoint": {
            return startsWith(head, OLE);
        }
        case "application/pdf": {
            return startsWith(head, PDF);
        }
        case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        case "application/zip": {
            return startsWith(head, ZIP);
        }
        case "image/bmp": {
            return startsWith(head, BMP);
        }
        case "image/gif": {
            return startsWith(head, GIF);
        }
        case "image/jpeg": {
            return startsWith(head, JPEG);
        }
        case "image/png": {
            return startsWith(head, PNG);
        }
        case "image/webp": {
            return startsWith(head, RIFF) && startsWith(head, WEBP, 8);
        }
        case "image/x-icon": {
            return startsWith(head, ICO);
        }
        default: {
            if (!isTextual(type)) {
                return true;
            }

            // Text has no signature, but it has no NUL bytes either — unless it
            // is UTF-16, which announces itself with a byte-order mark.
            return startsWith(head, UTF16_LE) || startsWith(head, UTF16_BE) || !head.subarray(0, SNIFF_BYTES).includes(0);
        }
    }
};
