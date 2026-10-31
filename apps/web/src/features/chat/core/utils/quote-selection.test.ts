import { describe, expect, it } from "vitest";

import { formatQuote } from "./quote-selection";

describe(formatQuote, () => {
    it("prefixes every line and ends with a blank line", () => {
        expect(formatQuote("one\ntwo")).toBe("> one\n> two\n\n");
    });

    it("keeps paragraph breaks inside one quote", () => {
        expect(formatQuote("one\n\ntwo")).toBe("> one\n>\n> two\n\n");
    });

    it("trims the selection and normalises CRLF", () => {
        expect(formatQuote("  one\r\ntwo \n")).toBe("> one\n> two\n\n");
    });
});
