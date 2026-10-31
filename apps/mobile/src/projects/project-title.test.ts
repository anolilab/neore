import { describe, expect, it } from "vitest";

import { MAX_LENGTH } from "../../../../backend/lunora/lib/validators";
import { checkProjectTitle, MAX_PROJECT_TITLE_LENGTH } from "./project-title";

describe("checkProjectTitle", () => {
    it("accepts a name and returns it trimmed", () => {
        expect(checkProjectTitle("  Roadmap  ")).toEqual({ ok: true, title: "Roadmap" });
    });

    it("refuses an empty name and one that is only whitespace", () => {
        expect(checkProjectTitle("")).toMatchObject({ ok: false });
        expect(checkProjectTitle(" \n\t ")).toMatchObject({ ok: false });
    });

    it("accepts a name of exactly the limit and refuses one character more", () => {
        expect(checkProjectTitle("a".repeat(MAX_PROJECT_TITLE_LENGTH))).toMatchObject({ ok: true });
        expect(checkProjectTitle("a".repeat(MAX_PROJECT_TITLE_LENGTH + 1))).toMatchObject({ ok: false });
    });

    it("measures the limit after trimming", () => {
        expect(checkProjectTitle(` ${"a".repeat(MAX_PROJECT_TITLE_LENGTH)} `)).toMatchObject({ ok: true });
    });

    it("uses the same limit as createProject's `title` input on the server", () => {
        expect(MAX_PROJECT_TITLE_LENGTH).toBe(MAX_LENGTH.long);
    });
});
