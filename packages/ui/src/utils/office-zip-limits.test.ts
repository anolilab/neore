import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { assertOfficeZipWithinLimits } from "./office-zip-limits";

// Small caps, so the tests build small archives: the same check, a fraction of the time on CI.
const SMALL = { maxBytes: 1000, maxEntries: 3 };

const CENTRAL_ENTRY_SIGNATURE = 0x02_01_4b_50;

const buildZip = async (files: Record<string, string>, comment?: string): Promise<ArrayBuffer> => {
    const zip = new JSZip();

    for (const [name, content] of Object.entries(files)) {
        zip.file(name, content);
    }

    return zip.generateAsync({ comment, compression: "DEFLATE", type: "arraybuffer" });
};

describe(assertOfficeZipWithinLimits, () => {
    it("accepts a small archive", async () => {
        const buffer = await buildZip({ "a.xml": "<a/>", "b.xml": "<b/>" });

        await expect(assertOfficeZipWithinLimits(buffer)).resolves.toBeUndefined();
    });

    it("rejects an archive that expands past the cap although it is tiny compressed", async () => {
        const buffer = await buildZip({ "big.xml": "a".repeat(SMALL.maxBytes + 1) });

        expect(buffer.byteLength).toBeLessThan(SMALL.maxBytes);
        await expect(assertOfficeZipWithinLimits(buffer, SMALL)).rejects.toThrow("expands too large");
    });

    it("sums sizes across entries", async () => {
        const half = "a".repeat(SMALL.maxBytes / 2 + 1);

        const buffer = await buildZip({ "a.xml": half, "b.xml": half });

        await expect(assertOfficeZipWithinLimits(buffer, SMALL)).rejects.toThrow("expands too large");
    });

    it("rejects an archive whose declared sizes are small but whose stream inflates past the cap", async () => {
        const buffer = await buildZip({ "big.xml": "a".repeat(SMALL.maxBytes * 2) });

        // Lie about the uncompressed size in the central directory, as a crafted archive can.
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);
        const central = bytes.findIndex((_, index) => view.getUint32(index, true) === CENTRAL_ENTRY_SIGNATURE);

        view.setUint32(central + 24, 10, true);

        await expect(assertOfficeZipWithinLimits(buffer, SMALL)).rejects.toThrow("expands too large");
    });

    it("reads the real end record when the archive comment contains its signature", async () => {
        const buffer = await buildZip({ "a.xml": "<a/>" }, "PK\u{5}\u{6} not a record, just comment text");

        await expect(assertOfficeZipWithinLimits(buffer, SMALL)).resolves.toBeUndefined();
    });

    it("rejects too many entries", async () => {
        const files = Object.fromEntries(Array.from({ length: SMALL.maxEntries + 1 }, (_, index) => [`f${index}.xml`, ""]));

        const buffer = await buildZip(files);

        await expect(assertOfficeZipWithinLimits(buffer, SMALL)).rejects.toThrow("too many entries");
    });

    it("rejects data that is not a ZIP archive", async () => {
        await expect(assertOfficeZipWithinLimits(new TextEncoder().encode("not a zip at all, just text").buffer as ArrayBuffer)).rejects.toThrow("Not a ZIP");
    });
});
