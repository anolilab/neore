import { describe, expect, it } from "vitest";

import { isFolderRelativePath, readHostChanges, withoutHostChanges } from "./changes";

// The same table is in `apps/desktop/src/acp/changes.test.ts` against the host's `isSummaryPath`: a path one side
// takes and the other refuses costs a whole turn its end.
const ACCEPTED = ["a.ts", "src/b.ts", "dir/with space.md", "a..b/c", "..hidden"];
const REFUSED = ["c:x.md", String.raw`C:\x`, String.raw`a\..\b`, String.raw`..\a`, "a/../b", "..", String.raw`\server\x`, "/etc/passwd", "a\nb", "a\u{0}b"];

describe("isFolderRelativePath", () => {
    it("takes the paths the host sends and refuses the ones it must not", () => {
        expect(ACCEPTED.filter((candidate) => !isFolderRelativePath(candidate))).toEqual([]);
        expect(REFUSED.filter((candidate) => isFolderRelativePath(candidate))).toEqual([]);
    });
});

describe("readHostChanges", () => {
    it("reads the summary off a reply's metadata and nothing else", () => {
        const files = [{ added: 1, path: "a.ts", removed: 0 }];

        expect(readHostChanges({ neore: { hostChanges: { files, patch: "+x\n" } } })).toEqual({ files, patch: "+x\n" });
        expect(readHostChanges({ neore: { hostChanges: { files: [] } } })).toBeUndefined();
        expect(readHostChanges({ neore: {} })).toBeUndefined();
        expect(readHostChanges(undefined)).toBeUndefined();
    });

    it("refuses stored metadata whose entries are not file changes, so a renderer never meets a null", () => {
        const files = [{ added: 1, path: "a.ts", removed: 0 }];

        expect(readHostChanges({ neore: { hostChanges: { files: [null] } } })).toBeUndefined();
        expect(readHostChanges({ neore: { hostChanges: { files: [{ path: "a.ts" }] } } })).toBeUndefined();
        expect(readHostChanges({ neore: { hostChanges: { files: [{ added: -1, path: "a.ts", removed: 0 }] } } })).toBeUndefined();
        expect(readHostChanges({ neore: { hostChanges: { files, patch: 7 } } })).toBeUndefined();
        expect(readHostChanges({ neore: { hostChanges: { files, patch: { tooLarge: true } } } })).toEqual({ files, patch: { tooLarge: true } });
    });
});

describe("withoutHostChanges", () => {
    it("drops the summary from the metadata copied onto parts and leaves the rest alone", () => {
        const metadata = { neore: { billed: false, hostChanges: { files: [], patch: "x" } }, other: 1 };

        expect(withoutHostChanges(metadata)).toEqual({ neore: { billed: false }, other: 1 });
        expect(metadata.neore.hostChanges).toBeDefined();
        expect(withoutHostChanges({ neore: { billed: false } })).toEqual({ neore: { billed: false } });
        expect(withoutHostChanges(undefined)).toBeUndefined();
    });
});
