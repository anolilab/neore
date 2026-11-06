import { describe, expect, it } from "vitest";

import { parsePullRequestAddresses } from "./pull-request-address";

describe("parsePullRequestAddresses", () => {
    it("reads owner/name#number entries in any separator", () => {
        expect(parsePullRequestAddresses("octo/hello#7, octo/world#12\nacme/x#1")).toEqual([
            { number: 7, repository: "octo/hello" },
            { number: 12, repository: "octo/world" },
            { number: 1, repository: "acme/x" },
        ]);
    });

    it("returns nothing for an empty input and null for any token it does not understand", () => {
        expect(parsePullRequestAddresses(" ".repeat(3))).toEqual([]);
        expect(parsePullRequestAddresses("octo/hello#7 nope")).toBeNull();
        expect(parsePullRequestAddresses("https://example.com/octo/hello/pull/7")).toBeNull();
        expect(parsePullRequestAddresses("../etc#1")).toBeNull();
    });
});
