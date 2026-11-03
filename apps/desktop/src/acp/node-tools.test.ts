import { describe, expect, it } from "vitest";

import { findNodeTools } from "./node-tools";

const present = (...files: string[]) => (file: string) => files.includes(file);

describe("findNodeTools", () => {
    it("returns absolute paths from the first folder that holds both programs", () => {
        const isFile = present("/a/node", "/b/node", "/b/npm");

        expect(findNodeTools("/a:/b", isFile)).toEqual({ node: "/b/node", npm: "/b/npm" });
    });

    it("ignores a relative PATH entry, so a program in the working folder is never picked", () => {
        expect(findNodeTools(".:bin", present("./node", "./npm", "bin/node", "bin/npm"))).toBeUndefined();
    });

    it("also looks in the folders a GUI app's short PATH leaves out", () => {
        expect(findNodeTools("/usr/bin", present("/opt/homebrew/bin/node", "/opt/homebrew/bin/npm"))).toEqual({ node: "/opt/homebrew/bin/node", npm: "/opt/homebrew/bin/npm" });
    });

    it("finds nothing when either program is missing", () => {
        expect(findNodeTools("/a", present("/a/node"))).toBeUndefined();
        expect(findNodeTools(undefined, present())).toBeUndefined();
    });
});
