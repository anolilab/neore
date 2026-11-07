import { firstAttempt, MAX_DECODE_PIXELS } from "./image-downscale";

export interface HeicSize {
    height: number;
    width: number;
}

const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;
const FULL_BOX_BYTES = 4;
/** A photo's `meta` box is a few kilobytes; a larger one is not read, so a hostile header is never copied whole into memory. */
const META_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Top-level boxes the scan may pass before `meta`. A box is passed by its length, so only headers are read; a photo has a
 * handful (`ftyp`, `meta`, `mdat`), and this budget stops a file of endless tiny boxes after as many small reads.
 */
const MAX_TOP_LEVEL_BOXES = 1024;
/** Boxes read from one container. A photo's property list holds tens; this stops a `meta` box packed with empty boxes. */
const MAX_CHILD_BOXES = 4096;

const ascii = (bytes: Uint8Array, offset: number): string => String.fromCodePoint(...bytes.subarray(offset, offset + 4));

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The `meta` box's body, found by reading only box headers: every other box is skipped by its length, never read. */
const metaBody = async (file: Blob): Promise<Uint8Array | undefined> => {
    let offset = 0;

    // Each box is at least a header long, so `offset` always advances and the walk ends at the end of the file or the budget.
    for (let scanned = 0; offset + BOX_HEADER_BYTES <= file.size && scanned < MAX_TOP_LEVEL_BOXES; scanned += 1) {
        const head = new Uint8Array(await file.slice(offset, offset + LARGE_BOX_HEADER_BYTES).arrayBuffer());
        const view = viewOf(head);

        let size = view.getUint32(0);
        let header = BOX_HEADER_BYTES;

        if (size === 1) {
            if (head.length < LARGE_BOX_HEADER_BYTES) {
                return undefined;
            }

            size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
            header = LARGE_BOX_HEADER_BYTES;
        } else if (size === 0) {
            size = file.size - offset;
        }

        if (size < header || offset + size > file.size) {
            return undefined;
        }

        if (ascii(head, 4) === "meta") {
            return size - header > META_MAX_BYTES ? undefined : new Uint8Array(await file.slice(offset + header, offset + size).arrayBuffer());
        }

        offset += size;
    }

    return undefined;
};

interface Box {
    body: Uint8Array;
    type: string;
}

/** The boxes laid end to end in `bytes`. A box that runs past the end ends the list, so a torn box leaves the ones before it. */
const boxesIn = (bytes: Uint8Array): Box[] => {
    const boxes: Box[] = [];
    const view = viewOf(bytes);
    let offset = 0;

    // Each box is at least a header long, so `offset` always advances; the list is bounded by its bytes and the box budget.
    while (offset + BOX_HEADER_BYTES <= bytes.length && boxes.length < MAX_CHILD_BOXES) {
        let size = view.getUint32(offset);
        let header = BOX_HEADER_BYTES;

        if (size === 1) {
            if (offset + LARGE_BOX_HEADER_BYTES > bytes.length) {
                break;
            }

            size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
            header = LARGE_BOX_HEADER_BYTES;
        } else if (size === 0) {
            size = bytes.length - offset;
        }

        if (size < header || offset + size > bytes.length) {
            break;
        }

        boxes.push({ body: bytes.subarray(offset + header, offset + size), type: ascii(bytes, offset + 4) });
        offset += size;
    }

    return boxes;
};

/* eslint-disable no-bitwise -- the ipma flags and property indexes are bit fields */
/** `count` property indexes from `offset`: 7 bits each, or 15 when the box is wide (flag bit 0). */
const readIndexes = (view: DataView, offset: number, count: number, wide: boolean): number[] =>
    Array.from({ length: count }, (_, index) => {
        const at = offset + index * (wide ? 2 : 1);

        return wide ? view.getUint16(at) & 0x7f_ff : view.getUint8(at) & 0x7f;
    });

/** The 1-based property indexes the `ipma` box associates with the item `itemId`. A torn entry ends the list. */
const associatedIndexes = (ipma: Uint8Array, itemId: number): number[] => {
    if (ipma.length < 8) {
        return [];
    }

    const view = viewOf(ipma);
    // Version 0 names items by 16 bits, later versions by 32.
    const idBytes = ipma[0] === 0 ? 2 : 4;
    const wide = ((ipma[3] ?? 0) & 1) === 1;
    const indexes: number[] = [];
    const count = view.getUint32(4);
    let offset = 8;

    for (let entry = 0; entry < count && offset + idBytes + 1 <= ipma.length; entry += 1) {
        const id = idBytes === 2 ? view.getUint16(offset) : view.getUint32(offset);
        const associations = ipma[offset + idBytes] ?? 0;
        const first = offset + idBytes + 1;
        const end = first + associations * (wide ? 2 : 1);

        if (end > ipma.length) {
            break;
        }

        if (id === itemId) {
            indexes.push(...readIndexes(view, first, associations, wide));
        }

        offset = end;
    }

    return indexes;
};
/* eslint-enable no-bitwise */

/** The `ispe` size of the primary item, from the `meta` box's body. */
const primarySize = (meta: Uint8Array): HeicSize | undefined => {
    const boxes = boxesIn(meta.subarray(FULL_BOX_BYTES));
    const pitm = boxes.find((box) => box.type === "pitm");
    const iprp = boxes.find((box) => box.type === "iprp");

    if (!pitm || !iprp) {
        return undefined;
    }

    // `pitm` is a full box: version 0 names the primary item in 16 bits, later versions in 32.
    const wideId = pitm.body[0] !== 0;

    if (pitm.body.length < FULL_BOX_BYTES + (wideId ? 4 : 2)) {
        return undefined;
    }

    const pitmView = viewOf(pitm.body);
    const itemId = wideId ? pitmView.getUint32(FULL_BOX_BYTES) : pitmView.getUint16(FULL_BOX_BYTES);
    const inner = boxesIn(iprp.body);
    const ipco = inner.find((box) => box.type === "ipco");
    // There may be several `ipma` boxes (one per version and flags pair); the primary item's associations can be in any.
    const ipmas = inner.filter((box) => box.type === "ipma");

    if (!ipco || ipmas.length === 0) {
        return undefined;
    }

    const properties = boxesIn(ipco.body);
    const indexes = ipmas.flatMap((ipma) => associatedIndexes(ipma.body, itemId));

    for (const index of indexes) {
        const property = properties[index - 1];

        // `ispe` is a full box: its width and height follow the 4 version and flag bytes.
        if (property?.type === "ispe" && property.body.length >= FULL_BOX_BYTES + 8) {
            const view = viewOf(property.body);
            const width = view.getUint32(FULL_BOX_BYTES);
            const height = view.getUint32(FULL_BOX_BYTES + 4);

            return width > 0 && height > 0 ? { height, width } : undefined;
        }
    }

    return undefined;
};

/**
 * The pixel size a HEIC or HEIF photo declares for its primary item, read from the file's box headers with a few small
 * slices and without decoding it. `undefined` when the header cannot be read.
 */
export const heicSize = async (file: Blob): Promise<HeicSize | undefined> => {
    const meta = await metaBody(file);

    return meta ? primarySize(meta) : undefined;
};

/**
 * Re-encodes a HEIC photo as a JPEG blob with the browser's own decoder. Safari reads HEIC natively: an image element
 * loads the photo, and a canvas draws it and writes the JPEG. Only called where `canConvertHeic` says the browser decodes
 * HEIC, so this module needs no decoder library.
 *
 * The declared size is read from the header first, so a photo over the decode budget, or one whose size cannot be read,
 * is refused before the browser decodes anything.
 */
export const heicToJpegBlob = async (file: File, quality: number): Promise<Blob> => {
    const declared = await heicSize(file);

    if (!declared) {
        throw new Error("The photo's size could not be read.");
    }

    if (declared.width * declared.height > MAX_DECODE_PIXELS) {
        throw new Error("The photo is too large to convert.");
    }

    const url = URL.createObjectURL(file);
    let canvas: HTMLCanvasElement | undefined;

    try {
        const image = new Image();

        image.src = url;
        await image.decode();

        // The header decided the decode above. The decoded size is checked as well, so a header that disagrees with the photo
        // cannot reach the canvas copy either.
        if (image.naturalWidth * image.naturalHeight > MAX_DECODE_PIXELS) {
            throw new Error("The photo is too large to convert.");
        }

        // Drawn at the downscaler's first size, never at full resolution: iOS refuses a canvas over about 16.7 million pixels,
        // which a 24 or 48 megapixel iPhone photo is, and the downscaler would shrink a larger JPEG to this size anyway.
        const { height, width } = firstAttempt(image.naturalWidth, image.naturalHeight);

        canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");

        if (!context) {
            throw new Error("A canvas is not available to draw the photo on.");
        }

        // JPEG has no alpha: a transparent pixel would come out black.
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, width, height);

        const target = canvas;
        const blob = await new Promise<Blob | null>((resolve) => {
            target.toBlob(resolve, "image/jpeg", quality);
        });

        // A canvas that cannot encode JPEG hands back another type: that is not a JPEG, so it is not sent as one.
        if (!blob || blob.type !== "image/jpeg") {
            throw new Error("The photo could not be encoded as JPEG.");
        }

        return blob;
    } finally {
        URL.revokeObjectURL(url);

        // A canvas holds its pixels until it is collected; several photos picked at once would add up to iOS's canvas memory limit.
        if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
        }
    }
};
