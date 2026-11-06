import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { heicSize, heicToJpegBlob } from "./heic-decode";

// The header is built as the bytes a HEIF writer lays out: boxes of a 32-bit length, a 4-character type and a payload.
const bytesOf = (size: number, write: (view: DataView) => void): number[] => {
    const buffer = new ArrayBuffer(size);

    write(new DataView(buffer));

    return [...new Uint8Array(buffer)];
};
const u16 = (value: number): number[] => bytesOf(2, (view) => view.setUint16(0, value));
const u32 = (value: number): number[] => bytesOf(4, (view) => view.setUint32(0, value));
const text = (value: string): number[] => [...value].map((char) => char.codePointAt(0) ?? 0);
const zeros = (count: number): number[] => [...new Uint8Array(count)];
const box = (type: string, ...parts: number[][]): number[] => {
    const body = parts.flat();

    return [...u32(8 + body.length), ...text(type), ...body];
};
const FULL_BOX = [0, 0, 0, 0];

const ispe = (width: number, height: number): number[] => box("ispe", FULL_BOX, u32(width), u32(height));
const pitm = (itemId: number): number[] => box("pitm", FULL_BOX, u16(itemId));

/** The `meta` box of a photo whose primary item (1) declares `width` × `height` through its first property. */
const primaryMeta = (width: number, height: number): number[] => {
    const properties = box("ipco", ispe(width, height));
    const associations = box("ipma", FULL_BOX, u32(1), u16(1), [1, 1]);

    return box("meta", FULL_BOX, pitm(1), box("iprp", properties, associations));
};

/** A photo's bytes whose primary item declares `width` × `height`. `mdatBytes` puts a payload before `meta`, which must be skipped by its length. */
const photoBytes = (width: number, height: number, mdatBytes = 0): number[] => {
    const ftyp = box("ftyp", text("heic"), u32(0), text("mif1"));
    const mdat = box("mdat", zeros(mdatBytes));

    return [...ftyp, ...mdat, ...primaryMeta(width, height)];
};

const photoFile = (bytes: number[]): File => new File([Uint8Array.from(bytes)], "IMG_0001.HEIC", { type: "image/heic" });
const photoOf = (width: number, height: number, mdatBytes = 0): File => photoFile(photoBytes(width, height, mdatBytes));

describe(heicSize, () => {
    it("reads the declared width and height of the primary item, without decoding it", async () => {
        const photo = photoOf(4032, 3024);

        await expect(heicSize(photo)).resolves.toStrictEqual({ height: 3024, width: 4032 });
    });

    it("skips boxes that come before `meta` by their length", async () => {
        const photo = photoOf(4032, 3024, 4096);

        await expect(heicSize(photo)).resolves.toStrictEqual({ height: 3024, width: 4032 });
    });

    it("reads the size the primary item is associated with, not the first one in the file", async () => {
        // Property 1 is a thumbnail (100 × 100) that item 2 uses; the primary item 1 uses property 2.
        const properties = box("ipco", ispe(100, 100), ispe(4032, 3024));
        const associations = box("ipma", FULL_BOX, u32(2), u16(2), [1, 1], u16(1), [1, 2]);
        const photo = photoFile(box("meta", FULL_BOX, pitm(1), box("iprp", properties, associations)));

        await expect(heicSize(photo)).resolves.toStrictEqual({ height: 3024, width: 4032 });
    });

    it("answers nothing for bytes that are not a box structure", async () => {
        const photo = new File(["not a photo at all"], "notes.heic");

        await expect(heicSize(photo)).resolves.toBeUndefined();
    });

    it("answers nothing when the primary item has no size property", async () => {
        const associations = box("ipma", FULL_BOX, u32(1), u16(1), [1, 1]);
        const iprp = box("iprp", box("ipco"), associations);
        const photo = photoFile(box("meta", FULL_BOX, pitm(1), iprp));

        await expect(heicSize(photo)).resolves.toBeUndefined();
    });

    it("answers nothing when the file names no primary item, so an unreadable size is refused rather than guessed", async () => {
        const properties = box("ipco", ispe(4032, 3024));
        const associations = box("ipma", FULL_BOX, u32(1), u16(1), [1, 1]);
        const photo = photoFile(box("meta", FULL_BOX, box("iprp", properties, associations)));

        await expect(heicSize(photo)).resolves.toBeUndefined();
    });

    it("answers nothing for a file cut off inside its header", async () => {
        const photo = photoFile(photoBytes(4032, 3024).slice(0, -20));

        await expect(heicSize(photo)).resolves.toBeUndefined();
    });
});

describe(heicToJpegBlob, () => {
    const decoderConstructor = vi.fn();

    beforeEach(() => {
        decoderConstructor.mockClear();
        Object.assign(URL, { createObjectURL: vi.fn(() => "blob:heic"), revokeObjectURL: vi.fn() });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("refuses a small file whose header declares too many pixels, before the browser decodes it", async () => {
        // About 200 bytes, declaring 100 megapixels: the byte size says nothing about the decode cost.
        const photo = photoOf(10_000, 10_000);

        vi.stubGlobal("Image", decoderConstructor);

        await expect(heicToJpegBlob(photo, 0.92)).rejects.toThrow("too large to convert");
        expect(decoderConstructor).not.toHaveBeenCalled();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it("refuses a photo whose size cannot be read, before the browser decodes it", async () => {
        const photo = new File(["not a photo"], "a.heic", { type: "image/heic" });

        vi.stubGlobal("Image", decoderConstructor);

        await expect(heicToJpegBlob(photo, 0.92)).rejects.toThrow("could not be read");
        expect(decoderConstructor).not.toHaveBeenCalled();
    });

    it("hands a photo within the pixel budget to the browser's decoder, and releases its object URL", async () => {
        const photo = photoOf(7000, 7000);

        class DecodingImage {
            public src = "";

            public decode(): Promise<void> {
                decoderConstructor(this.src);

                return Promise.reject(new Error("decode reached"));
            }
        }

        vi.stubGlobal("Image", DecodingImage);

        await expect(heicToJpegBlob(photo, 0.92)).rejects.toThrow("decode reached");
        expect(decoderConstructor).toHaveBeenCalledWith("blob:heic");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:heic");
    });
});
