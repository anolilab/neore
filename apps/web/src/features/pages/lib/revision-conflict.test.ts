import { describe, expect, it } from "vitest";

import { readRevisionConflict } from "./revision-conflict";

describe("readRevisionConflict", () => {
    it("reads the coded conflict payload", () => {
        const error = Object.assign(new Error("This page changed"), {
            data: { code: "PAGE_REVISION_CONFLICT", content: "md", contentJson: { type: "doc" }, revision: 7, title: "T" },
        });

        expect(readRevisionConflict(error)).toEqual({ content: "md", contentJson: { type: "doc" }, revision: 7, title: "T" });
    });

    it("ignores any other error", () => {
        expect(readRevisionConflict(new Error("boom"))).toBeNull();
        expect(readRevisionConflict({ data: { code: "PROMPT_LIMIT_REACHED" } })).toBeNull();
        expect(readRevisionConflict(null)).toBeNull();
    });
});
