import { describe, expect, it } from "vitest";

import type { PaletteScope } from "./command-palette-scope";
import { isPaletteScoped, matchesWithinWords, NO_PALETTE_SCOPE, projectRowsVisible, threadRowVisible, unscopedRowsVisible } from "./command-palette-scope";

const scope = (overrides: Partial<PaletteScope>): PaletteScope => {
    return { ...NO_PALETTE_SCOPE, ...overrides };
};

describe(matchesWithinWords, () => {
    it("matches a term anywhere inside a word", () => {
        expect(matchesWithinWords("Invoice export", "voice")).toBe(true);
        expect(matchesWithinWords("Invoice export", "export")).toBe(true);
    });

    it("ignores case and accents", () => {
        expect(matchesWithinWords("Café menu", "CAFE")).toBe(true);
        expect(matchesWithinWords("PDF Totals", "pdf tot")).toBe(true);
    });

    it("matches everything for an empty query, and nothing for a term the label lacks", () => {
        expect(matchesWithinWords("Anything", " ".repeat(3))).toBe(true);
        expect(matchesWithinWords("PDF totals off by one", "the invoice bug")).toBe(false);
    });
});

describe(threadRowVisible, () => {
    it("shows every thread with no filter on", () => {
        expect(threadRowVisible(NO_PALETTE_SCOPE, "active")).toBe(true);
        expect(threadRowVisible(NO_PALETTE_SCOPE, "archived")).toBe(true);
    });

    it("the archived filter limits the thread rows to archived threads", () => {
        const archivedOnly = scope({ archived: true });

        expect(threadRowVisible(archivedOnly, "archived")).toBe(true);
        expect(threadRowVisible(archivedOnly, "active")).toBe(false);
    });

    it("the threads filter shows both kinds of thread, and the archived filter narrows it", () => {
        expect(threadRowVisible(scope({ threads: true }), "active")).toBe(true);
        expect(threadRowVisible(scope({ threads: true, archived: true }), "active")).toBe(false);
        expect(threadRowVisible(scope({ threads: true, archived: true }), "archived")).toBe(true);
    });

    it("the projects filter alone shows no thread rows", () => {
        expect(threadRowVisible(scope({ projects: true }), "active")).toBe(false);
        expect(threadRowVisible(scope({ projects: true }), "archived")).toBe(false);
    });
});

describe(projectRowsVisible, () => {
    it("shows project rows only under the projects filter, so the unfiltered palette keeps its rows", () => {
        expect(projectRowsVisible(NO_PALETTE_SCOPE)).toBe(false);
        expect(projectRowsVisible(scope({ projects: true }))).toBe(true);
    });

    it("hides them under the threads or archived filter alone", () => {
        expect(projectRowsVisible(scope({ threads: true }))).toBe(false);
        expect(projectRowsVisible(scope({ archived: true }))).toBe(false);
    });
});

describe("palette filters as a whole", () => {
    it("any filter switches off the unscoped rows: navigation, actions and message hits", () => {
        expect(unscopedRowsVisible(NO_PALETTE_SCOPE)).toBe(true);
        expect(isPaletteScoped(NO_PALETTE_SCOPE)).toBe(false);

        for (const filter of ["archived", "projects", "threads"] as const) {
            expect(unscopedRowsVisible(scope({ [filter]: true }))).toBe(false);
        }
    });
});
