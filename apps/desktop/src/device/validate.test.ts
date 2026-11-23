import { describe, expect, it } from "vitest";

import { readSshAlias } from "./validate";

describe("readSshAlias", () => {
    it("accepts a literal alias with a ! that is not leading", () => {
        expect(readSshAlias("build!legacy")).toBe("build!legacy");
    });

    it("rejects a leading !, whitespace, wildcards and control characters", () => {
        for (const alias of ["!build", "a b", "web-*", "a?", "a\u{7}b"]) {
            expect(() => readSshAlias(alias)).toThrow("sshAlias is invalid");
        }
    });
});
