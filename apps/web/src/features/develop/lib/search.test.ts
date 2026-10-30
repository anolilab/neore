import { describe, expect, it } from "vitest";

import { validateDevelopSearch } from "./search";

describe("validateDevelopSearch", () => {
    it("keeps a well-formed address", () => {
        expect(validateDevelopSearch({ number: "12", repository: "octo/hello", section: "mine", tab: "files" })).toEqual({
            number: 12,
            repository: "octo/hello",
            section: "mine",
            tab: "files",
        });
    });

    it.each([
        [{ number: 12 }, {}],
        [{ repository: "octo/hello" }, {}],
        [{ number: 0, repository: "octo/hello" }, {}],
        [{ number: 1.5, repository: "octo/hello" }, {}],
        [{ number: 3, repository: "../etc/passwd" }, {}],
        [{ number: 3, repository: "no-slash" }, {}],
        [{ number: 3, repository: "a/b c" }, {}],
        [{ section: "everything" }, {}],
        [{ tab: "files" }, {}],
        [
            { number: 3, repository: "octo/hello", tab: "nope" },
            { number: 3, repository: "octo/hello" },
        ],
        [{ number: 3, repository: ["a/b"] }, {}],
    ])("reads %j as %j", (search, expected) => {
        expect(validateDevelopSearch(search)).toEqual(expected);
    });

    it("keeps a nested group path", () => {
        expect(validateDevelopSearch({ number: 1, repository: "group/sub/repo" })).toEqual({ number: 1, repository: "group/sub/repo" });
    });
});
