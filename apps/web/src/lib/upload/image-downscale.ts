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

/** Attempts at the target size before the smallest result is uploaded as it is. */
export const MAX_ATTEMPTS = 4;

const FIRST_QUALITY = 0.85;
const MIN_QUALITY = 0.6;
const QUALITY_STEP = 0.15;
const SHRINK_MARGIN = 0.92;

/** What gets re-encoded. GIF (animation), SVG (vector) and icons are left alone, and so are transparent PNGs and transparent or animated WebPs. */
const REENCODABLE_TYPES: ReadonlySet<string> = new Set(["image/bmp", "image/jpeg", "image/png", "image/webp"]);

/** The one type every re-encoded photo has: its leading bytes pass the server's sniff and it is on the allowlist. */
const REENCODED_TYPE = "image/jpeg";

export interface EncodeAttempt {
    height: number;
    /** JPEG quality, 0–1. */
    quality: number;
    width: number;
}

/** Whether a file of this type and size is re-encoded at all. A PNG or WebP with alpha, or an animated WebP, is a further check, on its bytes. */
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

/** Bytes of a PNG's or WebP's head to read for {@link pngHasAlpha} and {@link webpIsAnimatedOrTransparent}: both keep their flags before the image data. */
const HEAD_BYTES = 256 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_COLOR_TYPE_OFFSET = 25;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_OVERHEAD_BYTES = 12;

const ascii = (bytes: Uint8Array, offset: number, length: number): string => String.fromCodePoint(...bytes.subarray(offset, offset + length));

/**
 * Whether a PNG can carry transparency: a colour type with an alpha channel (4
 * greyscale+alpha, 6 RGBA), or a `tRNS` chunk on a palette/greyscale/RGB image.
 * Read from the head alone. When the head ends before the image data starts
 * (or is not a PNG) the answer is "yes", so the file is left as it is.
 */
export const pngHasAlpha = (head: Uint8Array): boolean => {
    if (head.length <= IHDR_COLOR_TYPE_OFFSET || PNG_SIGNATURE.some((byte, index) => head[index] !== byte)) {
        return true;
    }

    const colorType = head[IHDR_COLOR_TYPE_OFFSET];

    if (colorType === 4 || colorType === 6) {
        return true;
    }

    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let offset = PNG_SIGNATURE.length;

    while (offset + CHUNK_HEADER_BYTES <= head.length) {
        const type = ascii(head, offset + 4, 4);

        if (type === "tRNS") {
            return true;
        }

        if (type === "IDAT" || type === "IEND") {
            return false;
        }

        offset += view.getUint32(offset) + CHUNK_OVERHEAD_BYTES;
    }

    return true;
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

const EXTENSION = /\.[^./\\]+$/;

const jpegName = (name: string): string => `${name.replace(EXTENSION, "")}.jpg`;

/**
 * The file to upload for `file`: itself, unless it is a photo over
 * {@link TARGET_IMAGE_BYTES}, in which case a JPEG (named `.jpg`, EXIF
 * orientation applied, metadata dropped) re-encoded until it fits or
 * {@link MAX_ATTEMPTS} runs out, when the smallest result is used. Any failure
 * (no decoder, a canvas that cannot encode JPEG) answers the original, which the
 * server then accepts or refuses as before.
 */
export const downscaleOversizedImage = async (file: File): Promise<File> => {
    if (!isOversizedImage(file) || typeof createImageBitmap !== "function") {
        return file;
    }

    try {
        if (file.type === "image/png" || file.type === "image/webp") {
            const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());

            if (file.type === "image/png" ? pngHasAlpha(head) : webpIsAnimatedOrTransparent(head)) {
                return file;
            }
        }

        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });

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
