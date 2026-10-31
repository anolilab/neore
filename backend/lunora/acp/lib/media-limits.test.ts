/**
 * The size caps and the type list of a host's files are set in two places: the desktop's Rust core decides what
 * it reads and uploads (`packages/device-core/src/media.rs`), the backend decides what it accepts
 * (`constants.ts`). They are provisional (not measured), so one change must not reach only one side.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { uploadLimitFor } from "../../lib/chat-upload";
import { UPLOAD_ALLOWED_MIME } from "../../vault/lib/file-constants";
import { HOST_MEDIA_IMAGE_MIME_TYPES, HOST_MEDIA_MAX_BYTES, HOST_MEDIA_MAX_INLINE_IMAGE_BYTES, HOST_MEDIA_MIME_TYPES } from "./constants";

const rust = readFileSync(join(import.meta.dirname, "../../../../packages/device-core/src/media.rs"), "utf8");
const MIB = 1024 * 1024;

const constant = (name: string): number => {
    const match = new RegExp(String.raw`pub const ${name}: u64 = (\d+) \* 1024 \* 1024;`, "u").exec(rust);

    return Number(match?.[1]) * MIB;
};

describe("a host's file limits", () => {
    it("are the same numbers in the desktop core and the backend", () => {
        expect(constant("MAX_INLINE_IMAGE_BYTES")).toBe(HOST_MEDIA_MAX_INLINE_IMAGE_BYTES);
        expect(constant("MAX_UPLOAD_BYTES")).toBe(HOST_MEDIA_MAX_BYTES);
    });

    it("name the same types: every MIME type the core can produce is one the route takes, and no more", () => {
        const mimes = [...rust.matchAll(/mime: "([^"]+)"/gu)].map((match) => match[1]).toSorted((a, b) => String(a).localeCompare(String(b)));

        expect(mimes).toEqual([...HOST_MEDIA_MIME_TYPES].toSorted((a, b) => String(a).localeCompare(String(b))));

        const images = [...rust.matchAll(/image: true,\s+mime: "([^"]+)"/gu)].map((match) => match[1]).toSorted((a, b) => String(a).localeCompare(String(b)));

        expect(images).toEqual([...HOST_MEDIA_IMAGE_MIME_TYPES].toSorted((a, b) => String(a).localeCompare(String(b))));
    });

    it("stay inside what a chat attachment may be, and never include a type a browser would run", () => {
        for (const type of HOST_MEDIA_MIME_TYPES) {
            expect(UPLOAD_ALLOWED_MIME as ReadonlyArray<string>).toContain(type);
            expect(uploadLimitFor(type)).toBeGreaterThanOrEqual(HOST_MEDIA_MAX_BYTES);
        }

        for (const type of ["image/svg+xml", "text/html", "text/css", "text/javascript", "application/javascript", "application/xml", "text/xml"]) {
            expect(HOST_MEDIA_MIME_TYPES).not.toContain(type);
        }

        expect(HOST_MEDIA_MAX_INLINE_IMAGE_BYTES).toBeLessThan(HOST_MEDIA_MAX_BYTES);
    });
});
