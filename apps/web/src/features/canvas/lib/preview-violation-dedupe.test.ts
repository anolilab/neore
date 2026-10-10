import { describe, expect, it } from "vitest";

import { createViolationDeduper, VIOLATION_DEDUPE_WINDOW_MS } from "./preview-violation-dedupe";

const violation = "Blocked by preview policy (connect-src): https://api.example";

describe(createViolationDeduper, () => {
    it("drops the second report of the same block within the window", () => {
        const isDuplicate = createViolationDeduper();

        expect(isDuplicate(violation, 1000)).toBe(false);
        expect(isDuplicate(violation, 1001)).toBe(true);
    });

    it("keeps a repeat of the same block once the window has passed", () => {
        const isDuplicate = createViolationDeduper();

        expect(isDuplicate(violation, 1000)).toBe(false);
        expect(isDuplicate(violation, 1000 + VIOLATION_DEDUPE_WINDOW_MS)).toBe(false);
    });

    it("keeps different directives and URIs apart", () => {
        const isDuplicate = createViolationDeduper();

        expect(isDuplicate(violation, 1000)).toBe(false);
        expect(isDuplicate("Blocked by preview policy (img-src): https://api.example", 1000)).toBe(false);
        expect(isDuplicate("Blocked by preview policy (connect-src): https://other.example", 1000)).toBe(false);
    });

    it("never drops ordinary console messages", () => {
        const isDuplicate = createViolationDeduper();

        expect(isDuplicate("TypeError: x is undefined", 1000)).toBe(false);
        expect(isDuplicate("TypeError: x is undefined", 1000)).toBe(false);
    });

    it("stays in sync with the prefix the console bridge writes", async () => {
        const { buildPreviewSrcdoc } = await import("./preview-srcdoc");

        expect(buildPreviewSrcdoc("", "html")).toContain('"Blocked by preview policy ("');
    });
});
