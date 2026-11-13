/**
 * Off-screen message rows skip layout and paint through one stylesheet rule, which jsdom cannot compute. This reads the
 * rule itself, so removing or narrowing it fails here instead of quietly restoring the work for every off-screen row.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(import.meta.dirname, "../../../styles.css"), "utf8");

/** The declarations of the first rule for `selector` inside `block` (the whole sheet when not given). */
const declarationsOf = (selector: string, block = styles): string | undefined => {
    const start = block.indexOf(`${selector} {`);

    if (start === -1) {
        return undefined;
    }

    const open = block.indexOf("{", start);

    return block.slice(open + 1, block.indexOf("}", open));
};

const ROW = ".message-list > [data-list-message-id]";
const SKIPS_OFF_SCREEN = /content-visibility:\s*auto;/;
const KEEPS_REAL_HEIGHT = /contain-intrinsic-size:\s*auto\s+\d+px;/;
const RENDERS_ALL = /content-visibility:\s*visible;/;

describe("the message rows' stylesheet", () => {
    it("lets an off-screen row skip layout and paint, keeping its real height once rendered", () => {
        const rule = declarationsOf(ROW);

        expect(rule).toMatch(SKIPS_OFF_SCREEN);
        expect(rule).toMatch(KEEPS_REAL_HEIGHT);
    });

    it("renders every row when printing", () => {
        const print = styles.slice(styles.indexOf("@media print {"));

        expect(styles).toContain("@media print {");
        expect(declarationsOf(ROW, print)).toMatch(RENDERS_ALL);
    });
});
