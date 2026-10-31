import { describe, expect, it } from "vitest";

import { compileGlob, globProblem } from "./glob";

const matches = (glob: string, candidate: string): boolean => compileGlob(glob)(candidate);

describe("compileGlob", () => {
    it("matches * inside one segment only", () => {
        expect(matches("src/*.ts", "src/a.ts")).toBe(true);
        expect(matches("src/*.ts", "src/deep/a.ts")).toBe(false);
        expect(matches("*.md", "README.md")).toBe(true);
        expect(matches("*.md", "docs/README.md")).toBe(false);
    });

    it("matches ** across zero or more segments", () => {
        expect(matches("src/**/*.ts", "src/a.ts")).toBe(true);
        expect(matches("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
        expect(matches("src/**/*.ts", "lib/a.ts")).toBe(false);
        expect(matches("**", "a/b")).toBe(true);
    });

    it("matches ? as one character and braces as alternatives", () => {
        expect(matches("a?.txt", "ab.txt")).toBe(true);
        expect(matches("a?.txt", "a.txt")).toBe(false);
        expect(matches("src/*.{ts,tsx}", "src/a.tsx")).toBe(true);
        expect(matches("src/*.{ts,tsx}", "src/a.js")).toBe(false);
    });

    it("treats regular-expression characters literally", () => {
        expect(matches("a+b.(x)", "a+b.(x)")).toBe(false);
        expect(matches("a.b", "aXb")).toBe(false);
    });

    it("never matches a path that climbs out or is absolute", () => {
        expect(matches("**", "../secret")).toBe(false);
        expect(matches("**", "/etc/passwd")).toBe(false);
        expect(matches("**/*", "a/../../b")).toBe(false);
    });

    it("stays fast on a hostile pattern", () => {
        const started = Date.now();

        matches("*a*a*a*a", "a".repeat(255));
        expect(Date.now() - started).toBeLessThan(500);
    });
});

describe("globProblem", () => {
    it("accepts the plain forms", () => {
        for (const glob of ["*.ts", "src/**/*.{ts,tsx}", "docs/**", "a/b?c"]) {
            expect(globProblem(glob), glob).toBeNull();
        }
    });

    it("names what is wrong", () => {
        expect(globProblem("../x")).not.toBeNull();
        expect(globProblem("x".repeat(201))).not.toBeNull();
        expect(globProblem("{a,{b,c}}")).not.toBeNull();
        expect(globProblem("[ab]")).not.toBeNull();
        expect(globProblem("a\u{0}b")).not.toBeNull();
    });
});
