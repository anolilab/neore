import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { assertOfficeZipWithinLimits, OFFICE_ZIP_MAX_ENTRIES, OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES } from "./office-zip-limits";

const buildZip = async (files: Record<string, string>): Promise<ArrayBuffer> => {
    const zip = new JSZip();

    for (const [name, content] of Object.entries(files)) {
        zip.file(name, content);
    }

    return zip.generateAsync({ compression: "DEFLATE", type: "arraybuffer" });
};

describe(assertOfficeZipWithinLimits, () => {
    it("accepts a small archive", async () => {
        const buffer = await buildZip({ "a.xml": "<a/>", "b.xml": "<b/>" });

        expect(() => assertOfficeZipWithinLimits(buffer)).not.toThrow();
    });

    it("rejects an archive that expands past the cap although it is tiny compressed", async () => {
        const buffer = await buildZip({ "big.xml": "a".repeat(OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES + 1) });

        expect(buffer.byteLength).toBeLessThan(1024 * 1024);
        expect(() => assertOfficeZipWithinLimits(buffer)).toThrow("expands too large");
    });

    it("sums sizes across entries", async () => {
        const half = "a".repeat(OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES / 2 + 1);

        const buffer = await buildZip({ "a.xml": half, "b.xml": half });

        expect(() => assertOfficeZipWithinLimits(buffer)).toThrow("expands too large");
    });

    it("rejects too many entries", async () => {
        const files = Object.fromEntries(Array.from({ length: OFFICE_ZIP_MAX_ENTRIES + 1 }, (_, index) => [`f${index}.xml`, ""]));

        const buffer = await buildZip(files);

        expect(() => assertOfficeZipWithinLimits(buffer)).toThrow("too many entries");
    });

    it("rejects data that is not a ZIP archive", () => {
        expect(() => assertOfficeZipWithinLimits(new TextEncoder().encode("not a zip at all, just text").buffer as ArrayBuffer)).toThrow("Not a ZIP");
    });
});
