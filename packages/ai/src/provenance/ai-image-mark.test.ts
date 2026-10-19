/* eslint-disable no-bitwise -- byte-level PNG/JPEG/CRC work is bitwise by nature */
import { describe, expect, it } from "vitest";

import { markAiGeneratedImage, sniffImageMediaType } from "./ai-image-mark";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Independent bitwise CRC-32, so the test does not check the module against itself.
const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xff_ff_ff_ff;

    for (const byte of bytes) {
        crc ^= byte;

        for (let k = 0; k < 8; k += 1) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xed_b8_83_20 : crc >>> 1;
        }
    }

    return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

const chunk = (type: string, data: Uint8Array) => {
    const typeBytes = enc.encode(type);
    const body = new Uint8Array([...typeBytes, ...data]);

    return new Uint8Array([...u32(data.byteLength), ...body, ...u32(crc32(body))]);
};

// An APP11 segment carrying a JUMBF box, the form a C2PA manifest takes.
const C2PA_APP11 = [0xff, 0xeb, 0x00, 0x12, 0x4a, 0x50, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x08, 0x6a, 0x75, 0x6d, 0x62];

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const makePng = (extra: Uint8Array[] = []) => {
    const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    const parts = [SIGNATURE, chunk("IHDR", ihdr), ...extra, chunk("IDAT", new Uint8Array([1, 2, 3])), chunk("IEND", new Uint8Array())];

    return new Uint8Array(parts.flatMap((part) => [...part]));
};

/** Walks the chunks and fails on a bad CRC or a truncated chunk. */
const readPngChunks = (bytes: Uint8Array) => {
    const out: { data: Uint8Array; type: string }[] = [];
    let offset = 8;

    while (offset < bytes.byteLength) {
        const length = ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
        const body = bytes.subarray(offset + 4, offset + 8 + length);
        const crc =
            ((bytes[offset + 8 + length]! << 24) | (bytes[offset + 9 + length]! << 16) | (bytes[offset + 10 + length]! << 8) | bytes[offset + 11 + length]!) >>>
            0;

        expect(crc32(body)).toBe(crc);
        out.push({ data: body.subarray(4), type: dec.decode(body.subarray(0, 4)) });
        offset += 12 + length;
    }

    return out;
};

describe("markAiGeneratedImage", () => {
    it("adds an iTXt XMP chunk with the trainedAlgorithmicMedia source type before IDAT", () => {
        const png = makePng();
        const marked = markAiGeneratedImage(png);

        expect(marked.byteLength).toBeGreaterThan(png.byteLength);

        const chunks = readPngChunks(marked);

        expect(chunks.map((c) => c.type)).toEqual(["IHDR", "iTXt", "IDAT", "IEND"]);
        expect(dec.decode(chunks[1]!.data)).toContain("DigitalSourceType");
        expect(dec.decode(chunks[1]!.data)).toContain("trainedAlgorithmicMedia");
    });

    it("leaves a PNG carrying a C2PA manifest byte-identical", () => {
        const png = makePng([chunk("caBX", new Uint8Array([9, 9, 9]))]);

        expect(markAiGeneratedImage(png)).toEqual(png);
    });

    it("inserts an APP1 XMP segment after SOI in a JPEG", () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xd9]);
        const marked = markAiGeneratedImage(jpeg);

        expect(marked[2]).toBe(0xff);
        expect(marked[3]).toBe(0xe1);
        expect(dec.decode(marked)).toContain("trainedAlgorithmicMedia");
        expect(marked.subarray(marked.byteLength - 2)).toEqual(new Uint8Array([0xff, 0xd9]));
    });

    it("keeps APP0 first and walks every segment cleanly to SOS when the JPEG has JFIF and Exif", () => {
        const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
        const exif = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x74, 0x00, 0x00];
        const dqt = [0xff, 0xdb, 0x00, 0x03, 0x00];
        const jpeg = new Uint8Array([0xff, 0xd8, ...app0, ...exif, ...dqt, 0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0xff, 0xd9]);
        const marked = markAiGeneratedImage(jpeg);

        expect(marked[2]).toBe(0xff);
        expect(marked[3]).toBe(0xe0);

        const markers: number[] = [];
        let offset = 2;

        while (marked[offset + 1] !== 0xda) {
            expect(marked[offset]).toBe(0xff);
            markers.push(marked[offset + 1]!);
            offset += 2 + ((marked[offset + 2]! << 8) | marked[offset + 3]!);
        }

        expect(markers).toEqual([0xe0, 0xe1, 0xe1, 0xdb]);
        expect(marked[offset + 1]).toBe(0xda);
    });

    it("is idempotent for JPEG and PNG", () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
        const png = makePng();

        expect(markAiGeneratedImage(markAiGeneratedImage(jpeg))).toEqual(markAiGeneratedImage(jpeg));
        expect(markAiGeneratedImage(markAiGeneratedImage(png))).toEqual(markAiGeneratedImage(png));
    });

    it("passes a JPEG with a C2PA (APP11) segment through unchanged", () => {
        const jpeg = new Uint8Array([0xff, 0xd8, ...C2PA_APP11, 0xff, 0xd9]);

        expect(markAiGeneratedImage(jpeg)).toEqual(jpeg);
    });

    it("returns unsupported formats unchanged", () => {
        const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

        expect(markAiGeneratedImage(webp)).toBe(webp);
    });

    it("still marks a PNG whose unrelated text chunk mentions the source-type URI", () => {
        const comment = chunk("iTXt", enc.encode("Comment\0\0\0\0\0http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"));
        const marked = markAiGeneratedImage(makePng([comment]));

        expect(readPngChunks(marked).map((c) => c.type)).toEqual(["IHDR", "iTXt", "iTXt", "IDAT", "IEND"]);
        expect(dec.decode(readPngChunks(marked)[2]!.data)).toContain("DigitalSourceType");
    });

    it("still marks a PNG whose XMP mentions the source type only inside a comment", () => {
        const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><!-- Iptc4xmpExt:DigitalSourceType="https://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia" --></x:xmpmeta>`;
        const keyword = enc.encode("XML:com.adobe.xmp\0\0\0\0\0");
        const itxt = chunk("iTXt", new Uint8Array([...keyword, ...enc.encode(xmp)]));
        const png = makePng([itxt]);
        const marked = markAiGeneratedImage(png);

        expect(marked.byteLength).toBeGreaterThan(png.byteLength);
        expect(dec.decode(marked)).toContain("<rdf:Description");
    });

    it("still marks a JPEG whose XMP mentions the source type only inside a comment", () => {
        const xmp = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><!-- Iptc4xmpExt:DigitalSourceType="https://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia" --></x:xmpmeta>`;
        const header = enc.encode("https://ns.adobe.com/xap/1.0/\0");
        const app1 = [0xff, 0xe1, 0x00, 0x00, ...header, ...enc.encode(xmp)];

        app1[2] = (app1.length - 2) >> 8;
        app1[3] = (app1.length - 2) & 0xff;
        const jpeg = new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xd9]);
        const marked = markAiGeneratedImage(jpeg);

        expect(marked.byteLength).toBeGreaterThan(jpeg.byteLength);
    });

    it("keeps bytes appended after IEND", () => {
        const trailer = enc.encode("trailing data");
        const png = new Uint8Array([...makePng(), ...trailer]);
        const marked = markAiGeneratedImage(png);

        expect(marked.subarray(marked.byteLength - trailer.byteLength)).toEqual(trailer);
        expect(readPngChunks(marked.subarray(0, marked.byteLength - trailer.byteLength)).map((c) => c.type)).toEqual(["IHDR", "iTXt", "IDAT", "IEND"]);
    });

    it("skips a PNG whose XMP already declares our source type", () => {
        const once = markAiGeneratedImage(makePng());

        expect(markAiGeneratedImage(once)).toBe(once);
    });

    it("marks a JPEG whose APP11 segment is not a C2PA (JUMBF) box", () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xeb, 0x00, 0x04, 0x41, 0x42, 0xff, 0xd9]);
        const marked = markAiGeneratedImage(jpeg);

        expect(marked.byteLength).toBeGreaterThan(jpeg.byteLength);
        expect(dec.decode(marked)).toContain("trainedAlgorithmicMedia");
    });

    it("leaves a multi-scan JPEG with a C2PA segment after the first scan unchanged", () => {
        const dqt = [0xff, 0xdb, 0x00, 0x03, 0x00];
        const sosHeader = [0xff, 0xda, 0x00, 0x02];
        const jpeg = new Uint8Array([0xff, 0xd8, ...dqt, ...sosHeader, 0x01, 0x02, ...C2PA_APP11, ...sosHeader, 0x03, 0xff, 0xd9]);

        expect(markAiGeneratedImage(jpeg)).toBe(jpeg);
    });

    it("marks a JPEG whose Exif payload contains the C2PA byte pattern", () => {
        const exif = [0xff, 0xe1, 0x00, 0x0e, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xeb, 0x00, 0x04, 0x4a, 0x50];
        const jpeg = new Uint8Array([0xff, 0xd8, ...exif, 0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xd9]);
        const marked = markAiGeneratedImage(jpeg);

        expect(marked.byteLength).toBeGreaterThan(jpeg.byteLength);
        expect(dec.decode(marked)).toContain("trainedAlgorithmicMedia");
    });

    it("marks a JPEG whose APP11 segment starts with JP but is not a JUMBF box", () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xeb, 0x00, 0x04, 0x4a, 0x50, 0xff, 0xd9]);
        const marked = markAiGeneratedImage(jpeg);

        expect(marked.byteLength).toBeGreaterThan(jpeg.byteLength);
        expect(dec.decode(marked)).toContain("trainedAlgorithmicMedia");
    });

    it("skips fill bytes before a marker in a JPEG header", () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9]);
        const marked = markAiGeneratedImage(jpeg);

        expect(marked[2]).toBe(0xff);
        expect(marked[3]).toBe(0xe1);
        expect(dec.decode(marked)).toContain("trainedAlgorithmicMedia");
    });

    it("leaves a JPEG with a malformed header unchanged", () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78, 0xff, 0xd9]);

        expect(markAiGeneratedImage(jpeg)).toBe(jpeg);
    });

    it("sniffs the image type from the bytes", () => {
        expect(sniffImageMediaType(makePng())).toBe("image/png");
        expect(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe("image/jpeg");
        expect(sniffImageMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
        expect(sniffImageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
        expect(sniffImageMediaType(new Uint8Array([0x00, 0x01, 0x02]))).toBeUndefined();
    });
});
