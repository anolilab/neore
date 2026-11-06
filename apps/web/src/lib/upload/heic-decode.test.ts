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

    it("finds `meta` behind more than 64 earlier top-level boxes", async () => {
        const leading = Array.from({ length: 100 }, () => box("free")).flat();
        const photo = photoFile([...box("ftyp", text("heic"), u32(0), text("mif1")), ...leading, ...primaryMeta(4032, 3024)]);

        await expect(heicSize(photo)).resolves.toStrictEqual({ height: 3024, width: 4032 });
    });

    it("finds the primary item's size when its property is beyond index 256, through the 15-bit index form", async () => {
        // 300 properties come before the size property, which is the 301st; flag bit 0 of `ipma` makes indexes 15 bits wide.
        const leading = Array.from({ length: 300 }, () => box("free"));
        const properties = box("ipco", ...leading, ispe(4032, 3024));
        const associations = box("ipma", [0, 0, 0, 1], u32(1), u16(1), [1], u16(301));
        const photo = photoFile(box("meta", FULL_BOX, pitm(1), box("iprp", properties, associations)));

        await expect(heicSize(photo)).resolves.toStrictEqual({ height: 3024, width: 4032 });
    });

    it("answers nothing for a box whose declared size is smaller than its own header", async () => {
        const photo = photoFile([0, 0, 0, 4, ...text("meta"), ...FULL_BOX]);

        await expect(heicSize(photo)).resolves.toBeUndefined();
    });

    it("does not read a `meta` box over the metadata byte limit", async () => {
        const fiveMegabytes = 5 * 1024 * 1024;
        const bytes = new Uint8Array(fiveMegabytes + 16);

        new DataView(bytes.buffer).setUint32(0, fiveMegabytes + 8);
        bytes.set(text("meta"), 4);

        await expect(heicSize(new File([bytes], "large-meta.heic"))).resolves.toBeUndefined();
    });

    it("stops scanning a file of endless tiny boxes rather than walking it to the end", async () => {
        // 70,000 boxes of 8 bytes: more header bytes than the scan budget reads, so the walk ends before `meta`.
        const endless = Array.from({ length: 70_000 }, () => box("free")).flat();
        const photo = photoFile([...endless, ...primaryMeta(4032, 3024)]);

        await expect(heicSize(photo)).resolves.toBeUndefined();
    });

    it("answers nothing for a file cut off inside its header", async () => {
        const photo = photoFile(photoBytes(4032, 3024).slice(0, -20));

        await expect(heicSize(photo)).resolves.toBeUndefined();
    });
});

/** An image element that decodes to `width` × `height`, or rejects with `failure`. Each one built is recorded in `built`. */
const imageElement = (options: { failure?: Error; height: number; width: number }, built: { src: string }[]) =>
    class {
        public naturalHeight = options.height;

        public naturalWidth = options.width;

        public src = "";

        private readonly failure = options.failure;

        public constructor() {
            built.push(this);
        }

        public decode(): Promise<void> {
            return this.failure ? Promise.reject(this.failure) : Promise.resolve();
        }
    };

/** A canvas whose 2D context records what is drawn, and whose `toBlob` answers `encoded` (null for a failed encode). */
const canvasElement = (options: { context: boolean; encoded: Blob | null }) => {
    const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" };
    const canvas = {
        getContext: vi.fn(() => (options.context ? context : null)),
        height: 0,
        toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
            callback(options.encoded);
        }),
        width: 0,
    };

    return { canvas, context };
};

describe(heicToJpegBlob, () => {
    const realCreateElement = document.createElement.bind(document);

    beforeEach(() => {
        Object.assign(URL, { createObjectURL: vi.fn(() => "blob:heic"), revokeObjectURL: vi.fn() });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    /** Hands `canvas` to `document.createElement("canvas")` and leaves every other element to the real DOM. */
    const useCanvas = (canvas: unknown) => {
        const spy = vi.spyOn(document, "createElement");

        spy.mockImplementation(((tag: string, elementOptions?: ElementCreationOptions) =>
            tag === "canvas" ? canvas : realCreateElement(tag, elementOptions)) as Document["createElement"]);

        return spy;
    };

    it("refuses a small file whose header declares too many pixels, before the browser decodes it", async () => {
        // About 200 bytes, declaring 100 megapixels: the byte size says nothing about the decode cost.
        const built: { src: string }[] = [];

        vi.stubGlobal("Image", imageElement({ height: 10_000, width: 10_000 }, built));

        await expect(heicToJpegBlob(photoOf(10_000, 10_000), 0.92)).rejects.toThrow("too large to convert");
        expect(built).toHaveLength(0);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it("refuses a photo whose size cannot be read, before the browser decodes it", async () => {
        const built: { src: string }[] = [];
        const photo = new File(["not a photo"], "a.heic", { type: "image/heic" });

        vi.stubGlobal("Image", imageElement({ height: 1, width: 1 }, built));

        await expect(heicToJpegBlob(photo, 0.92)).rejects.toThrow("could not be read");
        expect(built).toHaveLength(0);
    });

    it("hands a photo within the pixel budget to the browser's decoder, and releases its object URL", async () => {
        const built: { src: string }[] = [];

        vi.stubGlobal("Image", imageElement({ failure: new Error("decode reached"), height: 7000, width: 7000 }, built));

        await expect(heicToJpegBlob(photoOf(7000, 7000), 0.92)).rejects.toThrow("decode reached");
        expect(built[0]?.src).toBe("blob:heic");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:heic");
    });

    describe("with the browser's image element and canvas faked at the boundary", () => {
        it("decodes the photo, draws it on a white canvas, encodes it as JPEG and releases the object URL", async () => {
            const photo = photoOf(100, 80);
            const built: { src: string }[] = [];
            const encoded = new Blob([Uint8Array.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
            const { canvas, context } = canvasElement({ context: true, encoded });

            vi.stubGlobal("Image", imageElement({ height: 80, width: 100 }, built));
            useCanvas(canvas);

            await expect(heicToJpegBlob(photo, 0.92)).resolves.toBe(encoded);
            expect(URL.createObjectURL).toHaveBeenCalledWith(photo);
            expect(built[0]?.src).toBe("blob:heic");
            expect(canvas.width).toBe(100);
            expect(canvas.height).toBe(80);
            expect(context.fillStyle).toBe("#fff");
            expect(context.fillRect).toHaveBeenCalledWith(0, 0, 100, 80);
            expect(context.drawImage).toHaveBeenCalledWith(built[0], 0, 0);
            expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.92);
            expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:heic");
        });

        it("refuses a photo whose decoded size is over the budget, though its header was not, and releases the object URL", async () => {
            const { canvas } = canvasElement({ context: true, encoded: null });

            vi.stubGlobal("Image", imageElement({ height: 10_000, width: 10_000 }, []));
            useCanvas(canvas);

            await expect(heicToJpegBlob(photoOf(100, 80), 0.92)).rejects.toThrow("too large to convert");
            expect(canvas.toBlob).not.toHaveBeenCalled();
            expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:heic");
        });

        it("refuses a photo the browser fails to decode, before any canvas is made, and releases the object URL", async () => {
            const { canvas } = canvasElement({ context: true, encoded: null });

            vi.stubGlobal("Image", imageElement({ failure: new Error("unreadable photo"), height: 80, width: 100 }, []));
            const createElement = useCanvas(canvas);

            await expect(heicToJpegBlob(photoOf(100, 80), 0.92)).rejects.toThrow("unreadable photo");
            expect(createElement).not.toHaveBeenCalledWith("canvas");
            expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:heic");
        });

        it.each([
            ["an encoder that falls back to PNG", new Blob(["png"], { type: "image/png" })],
            ["an encoder that returns nothing", null],
        ])("refuses %s rather than sending it as a JPEG, and releases the object URL", async (_label, encoded) => {
            const { canvas } = canvasElement({ context: true, encoded });

            vi.stubGlobal("Image", imageElement({ height: 80, width: 100 }, []));
            useCanvas(canvas);

            await expect(heicToJpegBlob(photoOf(100, 80), 0.92)).rejects.toThrow("could not be encoded as JPEG");
            expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:heic");
        });

        it("refuses a browser with no 2D canvas, and releases the object URL", async () => {
            const { canvas } = canvasElement({ context: false, encoded: null });

            vi.stubGlobal("Image", imageElement({ height: 80, width: 100 }, []));
            useCanvas(canvas);

            await expect(heicToJpegBlob(photoOf(100, 80), 0.92)).rejects.toThrow("canvas is not available");
            expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:heic");
        });
    });
});
