/* eslint-disable no-bitwise -- byte-level PNG/JPEG/CRC work is bitwise by nature */
/* eslint-disable unicorn/prefer-https, sonarjs/no-clear-text-protocols -- the IPTC and XMP identifiers are http URIs that readers match byte for byte */

/**
 * Machine-readable marking for AI-generated still images (EU AI Act Art. 50(2)).
 *
 * Writes an IPTC `DigitalSourceType` = `trainedAlgorithmicMedia` into the file's
 * XMP packet: an `iTXt` chunk in PNG, an `APP1` segment in JPEG. Byte-level only,
 * no re-encoding, so the pixels are untouched.
 *
 * Skipped on purpose:
 * - Files that already carry a C2PA manifest (PNG `caBX`, JPEG `APP11` JUMBF).
 *   C2PA's hard binding hashes the file bytes, so any insertion breaks it.
 *   Those bytes pass through unchanged.
 * - Formats we don't handle (WebP, GIF). Returned unchanged; see the notes in
 *   docs/ before claiming coverage for them.
 */

const DIGITAL_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Adobe's XMP namespace identifier.
const XAP_NAMESPACE = "http://ns.adobe.com/xap/1.0/";
const XAP_HEADER = `${XAP_NAMESPACE}\0`;

// The PNG iTXt keyword under which XMP is stored.
const XMP_KEYWORD = "XML:com.adobe.xmp";

const DIGITAL_SOURCE_TYPE_ATTRIBUTE = /Iptc4xmpExt:DigitalSourceType="([^"]*)"/;

/**
 * True only when the XMP already declares OUR source type. An unrelated text chunk
 * that merely mentions the URI, or a camera's own source type, does not count.
 */
const xmpAlreadyMarked = (xmp: string): boolean => DIGITAL_SOURCE_TYPE_ATTRIBUTE.exec(xmp)?.[1] === DIGITAL_SOURCE_TYPE;

const XMP_PACKET = [
    `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">`,
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`,
    `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"`,
    ` Iptc4xmpExt:DigitalSourceType="${DIGITAL_SOURCE_TYPE}"/>`,
    `</rdf:RDF></x:xmpmeta>`,
    `<?xpacket end="w"?>`,
].join("");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ponytail: table CRC-32 instead of a dependency; Workers have no zlib.crc32.
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let n = 0; n < 256; n += 1) {
        let c = n;

        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
        }

        table[n] = c >>> 0;
    }

    return table;
})();

const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xff_ff_ff_ff;

    for (const byte of bytes) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }

    return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;

    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }

    return out;
};

const readU32 = (bytes: Uint8Array, offset: number): number =>
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;

const writeU32 = (value: number): Uint8Array => new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);

const isPng = (bytes: Uint8Array): boolean => PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

const isJpeg = (bytes: Uint8Array): boolean => bytes[0] === 0xff && bytes[1] === 0xd8;

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
    const typeBytes = encoder.encode(type);
    const body = concat([typeBytes, data]);

    return concat([writeU32(data.byteLength), body, writeU32(crc32(body))]);
};

/** The `iTXt` payload carrying the XMP packet under its reserved keyword. */
const pngXmpChunk = (): Uint8Array => {
    const keyword = encoder.encode("XML:com.adobe.xmp");
    const nul = new Uint8Array([0]);
    // keyword, NUL, compression flag 0, compression method 0, empty language tag, NUL, empty translated keyword, NUL, text
    const data = concat([keyword, nul, new Uint8Array([0, 0]), nul, nul, encoder.encode(XMP_PACKET)]);

    return pngChunk("iTXt", data);
};

const markPng = (bytes: Uint8Array): Uint8Array => {
    const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
    let offset = 8;
    let inserted = false;

    while (offset + 12 <= bytes.byteLength) {
        const length = readU32(bytes, offset);
        const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));

        // Refuse to touch a C2PA-signed file: the manifest hashes these bytes.
        if (type === "caBX") {
            return bytes;
        }

        // Already marked by an upstream that wrote the same field: nothing to add.
        if (type === "iTXt") {
            const data = bytes.subarray(offset + 8, offset + 8 + length);
            const keywordEnd = data.indexOf(0);

            if (keywordEnd > 0 && decoder.decode(data.subarray(0, keywordEnd)) === XMP_KEYWORD && xmpAlreadyMarked(decoder.decode(data))) {
                return bytes;
            }
        }

        const end = offset + 12 + length;

        // Before the first IDAT so the XMP sits in the header, where readers look for it.
        if (type === "IDAT" && !inserted) {
            chunks.push(pngXmpChunk());
            inserted = true;
        }

        chunks.push(bytes.subarray(offset, end));
        offset = end;

        if (type === "IEND") {
            break;
        }
    }

    // A PNG with no IDAT is not an image we can meaningfully mark; leave it be.
    if (!inserted) {
        return bytes;
    }

    // Keep anything after IEND byte for byte: the marker only adds a chunk.
    chunks.push(bytes.subarray(offset));

    return concat(chunks);
};

const markJpeg = (bytes: Uint8Array): Uint8Array => {
    let offset = 2;
    // Right after the leading APP0/APP1 run (JFIF must stay first, Exif is usually second).
    let insertAt = 2;
    let leading = true;
    let reachedScan = false;

    while (offset + 2 <= bytes.byteLength) {
        // Not a marker where one must be: a malformed header, so leave the file alone.
        if (bytes[offset] !== 0xff) {
            return bytes;
        }

        // Fill bytes (a run of 0xFF) may precede a marker code.
        if (bytes[offset + 1] === 0xff) {
            offset += 1;
            continue;
        }

        const marker = bytes[offset + 1]!;

        // Start of scan: entropy-coded data follows, no more header segments.
        if (marker === 0xda || marker === 0xd9) {
            reachedScan = true;
            break;
        }

        // A C2PA manifest lives in JUMBF boxes: APP11 whose payload starts with "JP".
        // Other APP11 segments are not C2PA and must not block marking.
        if (marker === 0xeb && bytes[offset + 4] === 0x4a && bytes[offset + 5] === 0x50) {
            return bytes;
        }

        // A header segment needs its two length bytes.
        if (offset + 4 > bytes.byteLength) {
            return bytes;
        }

        const next = offset + 2 + ((bytes[offset + 2]! << 8) | bytes[offset + 3]!);

        // Already marked: our source type is in an XMP APP1 segment.
        if (marker === 0xe1) {
            const payload = decoder.decode(bytes.subarray(offset + 4, next));

            if (payload.startsWith(XAP_HEADER) && xmpAlreadyMarked(payload)) {
                return bytes;
            }
        }

        if (leading && (marker === 0xe0 || marker === 0xe1)) {
            insertAt = next;
        } else {
            leading = false;
        }

        offset = next;
    }

    // Never reached the scan data: the header is truncated or unreadable.
    if (!reachedScan) {
        return bytes;
    }

    // ponytail: a provider's own XMP packet without this field gets a second packet; merging into it is the upgrade path.
    const payload = concat([encoder.encode(XAP_HEADER), encoder.encode(XMP_PACKET)]);
    const length = payload.byteLength + 2;

    if (length > 0xff_ff) {
        return bytes;
    }

    const segment = concat([new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff]), payload]);

    return concat([bytes.subarray(0, insertAt), segment, bytes.subarray(insertAt)]);
};

/**
 * The image format of the bytes, from their magic numbers. Providers and the
 * backend's fallback get the declared type wrong, so trust the bytes.
 */
export const sniffImageMediaType = (bytes: Uint8Array): string | undefined => {
    if (isPng(bytes)) {
        return "image/png";
    }

    if (isJpeg(bytes)) {
        return "image/jpeg";
    }

    if (decoder.decode(bytes.subarray(0, 4)) === "RIFF" && decoder.decode(bytes.subarray(8, 12)) === "WEBP") {
        return "image/webp";
    }

    if (decoder.decode(bytes.subarray(0, 4)) === "GIF8") {
        return "image/gif";
    }

    return undefined;
};

/**
 * Returns the image with its AI-generated marker, or the input unchanged when
 * the bytes are not PNG or JPEG (sniffed from magic bytes, not the declared
 * type, which providers and the backend's fallback get wrong) or the file
 * already carries a C2PA manifest. Applying it twice is a no-op.
 */
export const markAiGeneratedImage = (bytes: Uint8Array): Uint8Array => {
    if (isPng(bytes)) {
        return markPng(bytes);
    }

    if (isJpeg(bytes)) {
        return markJpeg(bytes);
    }

    return bytes;
};
