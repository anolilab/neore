/**
 * Re-encodes a photo that is too heavy for a model provider before it is
 * uploaded, so the provider does not answer the send with a 400.
 *
 * The repo declares no per-provider image cap, so the number comes from the
 * providers' own docs. The tightest one we route to is Bedrock's, 5 MB
 * BASE64-encoded per image
 * (https://platform.claude.com/docs/en/build-with-claude/vision#request-limits);
 * Anthropic's own API takes 10 MB base64, Gemini limits the request (20 MB inline)
 * rather than the image, and OpenAI's page states no per-image size. Base64 adds a
 * third, so 5 MB is about 3.75 MB of file; {@link TARGET_IMAGE_BYTES} keeps a margin.
 * The server's own cap for an image (`uploadLimitFor`, 20 MB) is far above this.
 */

const MEGABYTE = 1024 * 1024;

/** The size an image is brought under: Bedrock's 5 MB base64 cap as file bytes (3.75 MB), less a margin. */
export const TARGET_IMAGE_BYTES = Math.floor(3.4 * MEGABYTE);

/**
 * The longest side after re-encoding. Providers downscale to roughly this
 * anyway (and Anthropic rejects more than 8000 px), so it costs no detail the
 * model would have seen.
 */
export const MAX_IMAGE_EDGE = 2048;

/** Attempts at the target size before the smallest result is uploaded as it is: three qualities, then shrinking three times. */
export const MAX_ATTEMPTS = 6;

const FIRST_QUALITY = 0.85;
const MIN_QUALITY = 0.6;
const QUALITY_STEP = 0.15;
const SHRINK_MARGIN = 0.92;

/** What gets re-encoded. GIF (animation), SVG (vector) and icons are left alone, and so are transparent or animated PNGs, transparent or animated WebPs and 32-bit BMPs. */
const REENCODABLE_TYPES: ReadonlySet<string> = new Set(["image/bmp", "image/jpeg", "image/png", "image/webp"]);

/** The one type every re-encoded photo has: its leading bytes pass the server's sniff and it is on the allowlist. */
const REENCODED_TYPE = "image/jpeg";

export interface EncodeAttempt {
    height: number;
    /** JPEG quality, 0–1. */
    quality: number;
    width: number;
}

/** Whether a file of this type and size is re-encoded at all. A PNG, WebP or BMP that a JPEG would flatten is a further check, on its bytes. */
export const isOversizedImage = (file: { size: number; type: string }): boolean => REENCODABLE_TYPES.has(file.type) && file.size > TARGET_IMAGE_BYTES;

/** The first encode of an image of `width` × `height`: the long edge clamped to {@link MAX_IMAGE_EDGE}. */
export const firstAttempt = (width: number, height: number): EncodeAttempt => {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));

    return { height: Math.max(1, Math.round(height * scale)), quality: FIRST_QUALITY, width: Math.max(1, Math.round(width * scale)) };
};

/**
 * The attempt after `previous` came out `outputBytes` large, or `undefined`
 * when it fits. JPEG size is not predictable from the pixels, so it is a
 * feedback loop: quality gives way first, down to {@link MIN_QUALITY}, then the
 * dimensions shrink by the square root of the overshoot (size follows area).
 */
export const nextAttempt = (previous: EncodeAttempt, outputBytes: number): EncodeAttempt | undefined => {
    if (outputBytes <= TARGET_IMAGE_BYTES) {
        return undefined;
    }

    if (previous.quality > MIN_QUALITY) {
        return { ...previous, quality: Math.max(MIN_QUALITY, previous.quality - QUALITY_STEP) };
    }

    const scale = Math.sqrt(TARGET_IMAGE_BYTES / outputBytes) * SHRINK_MARGIN;

    return { height: Math.max(1, Math.floor(previous.height * scale)), quality: previous.quality, width: Math.max(1, Math.floor(previous.width * scale)) };
};

/** Bytes of a file's head to read for {@link bmpHasAlpha} and {@link webpIsAnimatedOrTransparent}: both keep their flags before the image data. */
const HEAD_BYTES = 256 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_COLOR_TYPE_OFFSET = 25;
const IHDR_END_OFFSET = 33;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_OVERHEAD_BYTES = 12;

const ascii = (bytes: Uint8Array, offset: number, length: number): string => String.fromCodePoint(...bytes.subarray(offset, offset + length));

/** Chunk headers read while looking for `IDAT`, and the file bytes they may skip over; past either the PNG is left as it is. */
const MAX_PNG_CHUNKS = 256;
const MAX_PNG_WALK_BYTES = 64 * MEGABYTE;

const readBytes = async (blob: Blob, start: number, end: number): Promise<Uint8Array> => new Uint8Array(await blob.slice(start, end).arrayBuffer());

/**
 * Whether a PNG can carry transparency or animation: a colour type with an
 * alpha channel (4 greyscale+alpha, 6 RGBA), or a `tRNS` or `acTL` chunk before
 * the image data. The chunks are walked header by header with small reads,
 * skipping each payload, so a large ICC profile or text chunk does not hide the
 * answer. When the structure cannot be verified (not a PNG, truncated, too many
 * chunks) the answer is "yes", so the file is left as it is.
 */
export const pngHasAlpha = async (file: Blob): Promise<boolean> => {
    const start = await readBytes(file, 0, IHDR_END_OFFSET);

    if (start.length < IHDR_END_OFFSET || PNG_SIGNATURE.some((byte, index) => start[index] !== byte)) {
        return true;
    }

    const colorType = start[IHDR_COLOR_TYPE_OFFSET];

    if (colorType === 4 || colorType === 6) {
        return true;
    }

    let offset = IHDR_END_OFFSET;

    for (let chunks = 0; chunks < MAX_PNG_CHUNKS && offset < MAX_PNG_WALK_BYTES; chunks += 1) {
        const header = await readBytes(file, offset, offset + CHUNK_HEADER_BYTES);

        if (header.length < CHUNK_HEADER_BYTES) {
            return true;
        }

        const type = ascii(header, 4, 4);

        // tRNS: transparency. acTL: an animated PNG, whose frames a JPEG would drop.
        if (type === "tRNS" || type === "acTL") {
            return true;
        }

        if (type === "IDAT" || type === "IEND") {
            return false;
        }

        offset += new DataView(header.buffer).getUint32(0) + CHUNK_OVERHEAD_BYTES;
    }

    return true;
};

const BMP_DIB_SIZE_OFFSET = 14;
const BMP_CORE_HEADER_BYTES = 12;
const BMP_INFO_HEADER_BYTES = 40;
const BMP_BITS_PER_PIXEL_OFFSET = 28;
const BMP_HEADER_BYTES = 30;
const BMP_ALPHA_BITS_PER_PIXEL = 32;

/**
 * Whether a BMP can carry transparency: only a 32-bit-per-pixel one has an
 * alpha channel (browsers decode it as such). Bytes that are not a BMP answer
 * "yes", so the file is left as it is.
 */
export const bmpHasAlpha = (head: Uint8Array): boolean => {
    if (head.length < BMP_HEADER_BYTES || head[0] !== 0x42 || head[1] !== 0x4d) {
        return true;
    }

    const headerSize = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(BMP_DIB_SIZE_OFFSET, true);

    // The OS/2 core header has no alpha; a Windows one (40 bytes or more) says in its bit count.
    if (headerSize === BMP_CORE_HEADER_BYTES) {
        return false;
    }

    return (
        headerSize < BMP_INFO_HEADER_BYTES ||
        new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(BMP_BITS_PER_PIXEL_OFFSET, true) === BMP_ALPHA_BITS_PER_PIXEL
    );
};

/* eslint-disable no-bitwise -- WebP flags are bits of one byte */
const WEBP_FLAGS_OFFSET = 20;
const WEBP_VP8L_ALPHA_OFFSET = 24;
const WEBP_VP8X_ANIMATION_AND_ALPHA = 0x12;
const WEBP_VP8L_ALPHA = 0x10;

/**
 * Whether a WebP is animated or can carry transparency, either of which a JPEG
 * would flatten. A lossy still (`VP8 `), an extended file whose flags set neither,
 * or a lossless one without its alpha bit is plain; a head that is not a WebP
 * answers "yes", so the file is left as it is.
 */
export const webpIsAnimatedOrTransparent = (head: Uint8Array): boolean => {
    if (head.length <= WEBP_VP8L_ALPHA_OFFSET || ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WEBP") {
        return true;
    }

    switch (ascii(head, 12, 4)) {
        case "VP8 ": {
            return false;
        }
        case "VP8L": {
            return ((head[WEBP_VP8L_ALPHA_OFFSET] ?? 0) & WEBP_VP8L_ALPHA) !== 0;
        }
        case "VP8X": {
            return ((head[WEBP_FLAGS_OFFSET] ?? 0) & WEBP_VP8X_ANIMATION_AND_ALPHA) !== 0;
        }
        default: {
            return true;
        }
    }
};
/* eslint-enable no-bitwise */

/** The most pixels (width × height) that are decoded; a heavier image is left as it is, since decoding it could exhaust the browser's memory. */
export const MAX_DECODE_PIXELS = 50_000_000;

/** How far into a JPEG the frame header is looked for, and a cap on reads for a header made of tiny segments. Payloads are skipped by their length. */
const MAX_JPEG_SCAN_BYTES = 1024 * 1024;
const MAX_JPEG_SCAN_STEPS = 8192;
const JPEG_WINDOW_BYTES = 16;
const JPEG_SOF_HEADER_BYTES = 9;

export interface ImageSize {
    height: number;
    /** EXIF orientation 1-8 of a JPEG; 0 when it has an EXIF block whose orientation cannot be read. Absent means upright. */
    orientation?: number;
    width: number;
}

const EXIF_READ_BYTES = 2048;
const EXIF_ORIENTATION_TAG = 0x01_12;
const MAX_EXIF_ENTRIES = 64;

/** The orientation in an APP1 payload (`Exif\0\0`, a TIFF header, IFD0), 0 when it is not there within the bytes read. */
const exifOrientation = (payload: Uint8Array): number => {
    if (ascii(payload, 0, 4) !== "Exif" || payload.length < 14) {
        return 0;
    }

    const view = new DataView(payload.buffer);
    const little = payload[6] === 0x49;
    const entries = 6 + view.getUint32(10, little);

    if (entries + 2 > payload.length) {
        return 0;
    }

    const count = Math.min(view.getUint16(entries, little), MAX_EXIF_ENTRIES);

    for (let index = 0; index < count; index += 1) {
        const entry = entries + 2 + index * 12;

        if (entry + 10 > payload.length) {
            return 0;
        }

        if (view.getUint16(entry, little) === EXIF_ORIENTATION_TAG) {
            return view.getUint16(entry + 8, little);
        }
    }

    return 0;
};

const jpegSize = async (file: Blob): Promise<ImageSize | undefined> => {
    const soi = await readBytes(file, 0, 2);

    if (soi[0] !== 0xff || soi[1] !== 0xd8) {
        return undefined;
    }

    let offset = 2;
    let orientation: number | undefined;

    for (let steps = 0; offset < MAX_JPEG_SCAN_BYTES && steps < MAX_JPEG_SCAN_STEPS; steps += 1) {
        const window = await readBytes(file, offset, offset + JPEG_WINDOW_BYTES);
        let fill = 0;

        // Any number of 0xFF fill bytes may come before a marker's code byte.
        while (window[fill] === 0xff) {
            fill += 1;
        }

        if (fill === 0 || window.length < 2) {
            return undefined;
        }

        const marker = window[fill];

        if (marker === undefined) {
            // Nothing but fill in this window: read on from its last 0xFF.
            offset += window.length - 1;
            continue;
        }

        // Standalone markers carry no length: TEM (01), RST0-7 (D0-D7), SOI (D8).
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
            offset += fill + 1;
            continue;
        }

        // A 0xFF 0x00 pair is byte stuffing inside entropy-coded data, never a marker here.
        if ([0x00, 0xd9, 0xda].includes(marker)) {
            return undefined;
        }

        // Re-read from the last fill byte so the segment starts at its own 0xFF.
        if (fill > 1) {
            offset += fill - 1;
            continue;
        }

        const segment = window.length >= JPEG_SOF_HEADER_BYTES ? window : await readBytes(file, offset, offset + JPEG_SOF_HEADER_BYTES);

        // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC) hold the frame size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            if (segment.length < JPEG_SOF_HEADER_BYTES) {
                return undefined;
            }

            const view = new DataView(segment.buffer);

            return { height: view.getUint16(5), ...(orientation !== undefined && { orientation }), width: view.getUint16(7) };
        }

        if (segment.length < 4) {
            return undefined;
        }

        const length = new DataView(segment.buffer).getUint16(2);

        if (marker === 0xe1 && orientation === undefined) {
            const payload = await readBytes(file, offset + 4, offset + 2 + Math.min(length, EXIF_READ_BYTES));

            if (ascii(payload, 0, 4) === "Exif") {
                orientation = exifOrientation(payload);
            }
        }

        offset += 2 + length;
    }

    return undefined;
};

/* eslint-disable no-bitwise -- WebP sizes are packed bit fields */
const webpSize = async (file: Blob): Promise<ImageSize | undefined> => {
    const head = await readBytes(file, 0, 30);

    if (head.length < 30 || ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WEBP") {
        return undefined;
    }

    const view = new DataView(head.buffer);

    switch (ascii(head, 12, 4)) {
        case "VP8 ": {
            return { height: view.getUint16(28, true) & 0x3f_ff, width: view.getUint16(26, true) & 0x3f_ff };
        }
        case "VP8L": {
            const bits = view.getUint32(21, true);

            return { height: ((bits >>> 14) & 0x3f_ff) + 1, width: (bits & 0x3f_ff) + 1 };
        }
        case "VP8X": {
            return { height: 1 + (view.getUint16(27, true) | ((head[29] ?? 0) << 16)), width: 1 + (view.getUint16(24, true) | ((head[26] ?? 0) << 16)) };
        }
        default: {
            return undefined;
        }
    }
};
/* eslint-enable no-bitwise */

const pngSize = async (file: Blob): Promise<ImageSize | undefined> => {
    const head = await readBytes(file, 0, IHDR_END_OFFSET);

    if (head.length < IHDR_END_OFFSET) {
        return undefined;
    }

    const view = new DataView(head.buffer);

    return { height: view.getUint32(20), width: view.getUint32(16) };
};

const bmpSize = async (file: Blob): Promise<ImageSize | undefined> => {
    const head = await readBytes(file, 0, BMP_HEADER_BYTES);

    if (head.length < BMP_HEADER_BYTES || head[0] !== 0x42 || head[1] !== 0x4d) {
        return undefined;
    }

    const view = new DataView(head.buffer);
    const headerSize = view.getUint32(BMP_DIB_SIZE_OFFSET, true);

    // OS/2 core header: unsigned 16-bit sizes.
    if (headerSize === BMP_CORE_HEADER_BYTES) {
        return { height: view.getUint16(20, true), width: view.getUint16(18, true) };
    }

    if (headerSize < BMP_INFO_HEADER_BYTES) {
        return undefined;
    }

    // Signed 32-bit sizes; a negative height is a top-down bitmap.
    return { height: Math.abs(view.getInt32(22, true)), width: Math.abs(view.getInt32(18, true)) };
};

const SIZE_READERS: Readonly<Record<string, ((file: Blob) => Promise<ImageSize | undefined>) | undefined>> = {
    "image/bmp": bmpSize,
    "image/jpeg": jpegSize,
    "image/png": pngSize,
    "image/webp": webpSize,
};

/**
 * The pixel size an image declares in its header, read with a few small slices
 * and without decoding it. `undefined` when the header cannot be read.
 */
export const readImageSize = async (file: Blob & { type: string }): Promise<ImageSize | undefined> => {
    const size = await SIZE_READERS[file.type]?.(file);

    return size && size.width > 0 && size.height > 0 ? size : undefined;
};

/** Decodes straight at the target size where `createImageBitmap` can resize, so no full-size bitmap is allocated; a browser that cannot decodes it whole (the pixel budget bounds that). */
const decoded = async (file: File, target: EncodeAttempt, size: ImageSize): Promise<ImageBitmap> => {
    // Whether resizeWidth/resizeHeight apply before or after the EXIF rotation differs between browsers: a sideways photo is decoded whole (the pixel budget bounds that) and sized from the real bitmap.
    const sideways = size.orientation === 0 || (size.orientation ?? 1) >= 5;

    if (!sideways && target.width < size.width) {
        try {
            return await createImageBitmap(file, {
                imageOrientation: "from-image",
                resizeHeight: target.height,
                resizeQuality: "high",
                resizeWidth: target.width,
            });
        } catch {
            // fall through to the plain decode
        }
    }

    return await createImageBitmap(file, { imageOrientation: "from-image" });
};

const drawn = (bitmap: ImageBitmap, { height, width }: EncodeAttempt): HTMLCanvasElement => {
    const canvas = document.createElement("canvas");

    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");

    if (!context) {
        throw new Error("No 2D canvas context");
    }

    // JPEG has no alpha: a transparent pixel would come out black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    return canvas;
};

const encoded = async (canvas: HTMLCanvasElement, quality: number): Promise<Blob | undefined> =>
    await new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob ?? undefined), REENCODED_TYPE, quality);
    });

/** Per type, whether the file says a JPEG would lose something (alpha, animation). A type with no entry is always re-encoded. */
const JPEG_LOSES: Readonly<Record<string, ((file: File) => Promise<boolean>) | undefined>> = {
    "image/bmp": async (file) => bmpHasAlpha(await readBytes(file, 0, HEAD_BYTES)),
    "image/png": pngHasAlpha,
    "image/webp": async (file) => webpIsAnimatedOrTransparent(await readBytes(file, 0, HEAD_BYTES)),
};

const EXTENSION = /\.[^./\\]+$/;

const jpegName = (name: string): string => `${name.replace(EXTENSION, "")}.jpg`;

/**
 * The file to upload for `file`: itself, unless it is a photo over
 * {@link TARGET_IMAGE_BYTES}, in which case a JPEG (named `.jpg`, EXIF
 * orientation applied, metadata dropped) re-encoded until it fits or
 * {@link MAX_ATTEMPTS} runs out, when the smallest result is used: still smaller
 * than the original, and the server's own cap and the provider decide from there. Any failure
 * (no decoder, a canvas that cannot encode JPEG) answers the original, which the
 * server then accepts or refuses as before.
 */
export const downscaleOversizedImage = async (file: File): Promise<File> => {
    if (typeof createImageBitmap !== "function" || !isOversizedImage(file)) {
        return file;
    }

    try {
        const losesSomething = JPEG_LOSES[file.type];

        if (losesSomething && (await losesSomething(file))) {
            return file;
        }

        // Decoding allocates the full intrinsic size, so the header is read first: an unreadable one or too many pixels keeps the original.
        const size = await readImageSize(file);

        if (!size || size.width * size.height > MAX_DECODE_PIXELS) {
            return file;
        }

        const bitmap = await decoded(file, firstAttempt(size.width, size.height), size);

        try {
            let attempt: EncodeAttempt | undefined = firstAttempt(bitmap.width, bitmap.height);
            let smallest: Blob | undefined;

            for (let tries = 0; attempt && tries < MAX_ATTEMPTS; tries += 1) {
                const blob = await encoded(drawn(bitmap, attempt), attempt.quality);

                // A canvas that cannot encode JPEG answers PNG; those bytes would not match the declared type.
                if (blob?.type !== REENCODED_TYPE) {
                    return file;
                }

                if (!smallest || blob.size < smallest.size) {
                    smallest = blob;
                }

                attempt = nextAttempt(attempt, blob.size);
            }

            return smallest && smallest.size < file.size
                ? new File([smallest], jpegName(file.name), { lastModified: file.lastModified, type: REENCODED_TYPE })
                : file;
        } finally {
            bitmap.close();
        }
    } catch {
        return file;
    }
};
