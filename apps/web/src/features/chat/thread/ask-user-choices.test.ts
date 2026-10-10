import { describe, expect, it } from "vitest";

import { normalizeAskUserChoices } from "./ask-user-choices";

describe(normalizeAskUserChoices, () => {
    it("drops duplicates, blanks and non-strings, keeping the model's order", () => {
        expect(normalizeAskUserChoices(["Yes", "No", "Yes", " ", 3, null, " No "])).toStrictEqual(["Yes", "No"]);
    });

    it("has no choices without an array", () => {
        expect(normalizeAskUserChoices(undefined)).toStrictEqual([]);
        expect(normalizeAskUserChoices("Yes")).toStrictEqual([]);
    });
});
