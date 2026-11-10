import { describe, expect, it, vi } from "vitest";

// The unit-test transform does not compile Lingui macros, so `msg` returns the descriptor shape it would produce.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join(""), message: strings.join("") };
        },
    };
});

const { getUseCase, USE_CASES } = await import("./use-case-data");

describe("use cases", () => {
    it("has a unique slug for every page", () => {
        const slugs = USE_CASES.map((useCase) => useCase.slug);

        expect(new Set(slugs).size).toBe(slugs.length);
    });

    it("gives every page its steps and its controls", () => {
        for (const useCase of USE_CASES) {
            expect(useCase.steps.length).toBeGreaterThanOrEqual(3);
            expect(useCase.controls.length).toBeGreaterThanOrEqual(2);
        }
    });

    it("finds a page by slug and returns nothing for an unknown one", () => {
        expect(getUseCase("routines")?.slug).toBe("routines");
        expect(getUseCase("does-not-exist")).toBeUndefined();
    });
});
