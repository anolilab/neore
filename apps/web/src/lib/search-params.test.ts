import { describe, expect, it } from "vitest";

import { parseSearch, stringifySearch } from "./search-params";

describe("search params", () => {
    it.each(["234567E2", "2E345678", "2345E234", "1.50", "-0"])("keeps %s as the text it was, both ways", (value) => {
        const search = `?user_code=${value}`;

        expect(parseSearch(search)).toEqual({ user_code: value });
        expect(stringifySearch(parseSearch(search))).toBe(search);
    });

    it("still reads plain numbers, booleans and JSON", () => {
        expect(parseSearch("?page=2&open=true&ids=%5B1%2C2%5D")).toEqual({ ids: [1, 2], open: true, page: 2 });
    });
});
