import { describe, expect, it } from "vitest";

import { methodToUse } from "./merge";

describe("methodToUse", () => {
    it("keeps a choice the repository allows", () => {
        expect(methodToUse(["merge", "squash"], "squash")).toBe("squash");
    });

    it("falls back to the first allowed method when the choice is gone or was never made", () => {
        expect(methodToUse(["merge", "squash"], "rebase")).toBe("merge");
        expect(methodToUse(["squash", "rebase"], null)).toBe("squash");
    });

    it("offers nothing when the repository allows no method", () => {
        expect(methodToUse([], "merge")).toBeNull();
    });
});
