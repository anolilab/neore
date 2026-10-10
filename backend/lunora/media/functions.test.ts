import { describe, expect, it } from "vitest";

import { api } from "../_generated/api";
import { imageItemSchema, MEDIA_MAX_PAGE_SIZE, paginationOptionsSchema, parseDataUrlMime, scopeSchema, sourceSchema } from "./functions";

describe("media API exports", () => {
    // Ported from the earlier api. Two things changed and both are load-bearing:
    // the namespace is FLATTENED (`media_functions`, not `media.functions`), and
    // a reference is a plain object `{ __lunoraRef: "<module>:<fn>" }` rather than
    // the earlier leaf carrying a `Symbol(functionName)`. There is no `type` field —
    // the kind lives in the generated TYPE, not the runtime value — so the
    // "registers as a query" assertion is gone rather than faked.
    it("exposes listUserImages on the generated api", () => {
        const reference = api.media.functions.listUserImages as unknown as { __lunoraRef?: string };

        expect(reference).toBeDefined();
        expect(reference.__lunoraRef).toBe("media_functions:listUserImages");
    });
});

describe("scopeSchema", () => {
    it("accepts 'thread' and 'all'", () => {
        expect(scopeSchema.parse("thread")).toBe("thread");
        expect(scopeSchema.parse("all")).toBe("all");
    });

    it("rejects unknown scopes", () => {
        expect(() => scopeSchema.parse("project" as never)).toThrow();
        expect(() => scopeSchema.parse("" as never)).toThrow();
    });
});

describe("sourceSchema", () => {
    it("accepts the three known sources", () => {
        for (const value of ["uploaded", "generated", "document"] as const) {
            expect(sourceSchema.parse(value)).toBe(value);
        }
    });

    it("rejects unknown sources", () => {
        expect(() => sourceSchema.parse("workflow" as never)).toThrow();
    });
});

describe("paginationOptionsSchema", () => {
    it("accepts a valid page request", () => {
        const parsed = paginationOptionsSchema.parse({ cursor: null, numItems: 20 });

        expect(parsed).toEqual({ cursor: null, numItems: 20 });
    });

    it("accepts a string cursor", () => {
        const parsed = paginationOptionsSchema.parse({ cursor: "abc123", numItems: 1 });

        expect(parsed.cursor).toBe("abc123");
    });

    it("rejects numItems below 1", () => {
        expect(() => paginationOptionsSchema.parse({ cursor: null, numItems: 0 })).toThrow();
        expect(() => paginationOptionsSchema.parse({ cursor: null, numItems: -5 })).toThrow();
    });

    it(`rejects numItems above MEDIA_MAX_PAGE_SIZE (${MEDIA_MAX_PAGE_SIZE})`, () => {
        expect(() => paginationOptionsSchema.parse({ cursor: null, numItems: MEDIA_MAX_PAGE_SIZE + 1 })).toThrow();
    });

    it("rejects non-integer numItems", () => {
        expect(() => paginationOptionsSchema.parse({ cursor: null, numItems: 3.5 })).toThrow();
    });

    /**
     * Behaviour change, recorded deliberately: this schema was `z.object(…).strict()`
     * and REJECTED an unknown key. Lunora's `v.object` has no strict mode — it
     * STRIPS instead, and a `.check()` cannot restore the old behaviour because the
     * predicate receives the already-stripped value.
     *
     * Safe here: the handler reads `cursor` and `numItems` off the parsed result by
     * name and passes nothing else through, so an extra key never reached anything.
     * Pinned as a test so the difference is a decision rather than a surprise.
     */
    it("strips unknown extra fields rather than rejecting them", () => {
        expect(paginationOptionsSchema.parse({ cursor: null, endCursor: "x", numItems: 5 } as never)).toStrictEqual({ cursor: null, numItems: 5 });
    });

    it("requires both cursor and numItems", () => {
        expect(() => paginationOptionsSchema.parse({ numItems: 5 } as never)).toThrow();
        expect(() => paginationOptionsSchema.parse({ cursor: null } as never)).toThrow();
    });
});

describe("imageItemSchema", () => {
    const validItem = {
        createdAt: 1_700_000_000_000,
        id: "file:abc123",
        mimeType: "image/png",
        source: "uploaded" as const,
        threadId: "thread_xyz",
        threadTitle: "My Thread",
        thumbnailUrl: "https://r2.example/img.png",
        url: "https://r2.example/img.png",
    };

    it("accepts a complete vault-image item", () => {
        expect(imageItemSchema.parse(validItem)).toEqual(validItem);
    });

    it("allows null threadId / threadTitle / thumbnailUrl", () => {
        const orphan = { ...validItem, threadId: null, threadTitle: null, thumbnailUrl: null };

        expect(imageItemSchema.parse(orphan)).toEqual(orphan);
    });

    it("requires url to be a string", () => {
        const bad = { ...validItem, url: null as unknown as string };

        expect(() => imageItemSchema.parse(bad)).toThrow();
    });

    it("requires createdAt to be a number", () => {
        const bad = { ...validItem, createdAt: "yesterday" as unknown as number };

        expect(() => imageItemSchema.parse(bad)).toThrow();
    });

    it("rejects unknown source values", () => {
        const bad = { ...validItem, source: "imported" as never };

        expect(() => imageItemSchema.parse(bad)).toThrow();
    });
});

describe("MEDIA_MAX_PAGE_SIZE", () => {
    it("is a positive integer", () => {
        expect(Number.isSafeInteger(MEDIA_MAX_PAGE_SIZE)).toBe(true);
        expect(MEDIA_MAX_PAGE_SIZE).toBeGreaterThan(0);
    });

    it("is at least 10 (sane lower bound for picker grid)", () => {
        expect(MEDIA_MAX_PAGE_SIZE).toBeGreaterThanOrEqual(10);
    });
});

describe("parseDataUrlMime", () => {
    it("extracts the mime from a standard base64 data URL", () => {
        expect(parseDataUrlMime("data:image/png;base64,iVBORw0KG...")).toBe("image/png");
        expect(parseDataUrlMime("data:image/jpeg;base64,/9j/4A...")).toBe("image/jpeg");
        expect(parseDataUrlMime("data:image/webp;base64,UklGR...")).toBe("image/webp");
    });

    it("extracts the mime from a comma-only data URL (no charset/base64 flag)", () => {
        expect(parseDataUrlMime("data:image/svg+xml,<svg/>")).toBe("image/svg+xml");
        expect(parseDataUrlMime("data:image/png,raw")).toBe("image/png");
    });

    it("falls back to image/png for non-data URLs", () => {
        expect(parseDataUrlMime("https://r2.example/foo.png")).toBe("image/png");
        expect(parseDataUrlMime("https://r2.example/foo.jpg")).toBe("image/png");
        expect(parseDataUrlMime("/local/path.png")).toBe("image/png");
    });

    it("falls back when the data URL is malformed (no delimiter)", () => {
        expect(parseDataUrlMime("data:image/png")).toBe("image/png");
        expect(parseDataUrlMime("data:")).toBe("image/png");
    });

    it("falls back when the mime slice would be empty", () => {
        expect(parseDataUrlMime("data:,payload")).toBe("image/png");
        expect(parseDataUrlMime("data:;base64,x")).toBe("image/png");
    });

    it("picks the earliest delimiter when both ';' and ',' are present", () => {
        // semicolon before comma — usual case
        expect(parseDataUrlMime("data:image/png;base64,xxx")).toBe("image/png");
        // semicolons inside the payload after a comma must NOT be treated as a delimiter
        expect(parseDataUrlMime("data:image/svg+xml,<svg;foo />")).toBe("image/svg+xml");
    });
});
