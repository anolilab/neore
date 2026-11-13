import { createDocument } from "@mixmark-io/domino";
import { describe, expect, it } from "vitest";

import type { Options } from "../src/index";
import TurndownService, { gfm } from "../src/index";

function convert(html: string, options: Partial<Options> = {}): string {
    return new TurndownService(options).use(gfm).turndown(html);
}

describe("gfm tables", () => {
    it("writes a table as a GFM table, its first row as the header", () => {
        expect(convert("<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>")).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
    });

    it("keeps the cells after a cell that spans columns or rows under their own headers", () => {
        expect(
            convert(
                `<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan="2">ab</td><td>c</td></tr><tr><td rowspan="2">a</td><td>b</td><td>c</td></tr><tr><td>b2</td><td>c2</td></tr></table>`,
            ),
        ).toBe("| A | B | C |\n| --- | --- | --- |\n| ab |  | c |\n| a | b | c |\n|  | b2 | c2 |");
    });

    it("spans a cell down to the end of its row group at most, so the next group keeps its columns", () => {
        expect(
            convert(
                [
                    `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td rowspan="0">a</td><td>b</td></tr><tr><td>c</td></tr></tbody>`,
                    `<tfoot><tr><td>f1</td><td>f2</td></tr></tfoot></table><table><tbody><tr><td rowspan="5">x</td><td>y</td></tr></tbody><tbody><tr><td>z1</td><td>z2</td></tr></tbody></table>`,
                ].join(""),
            ),
        ).toBe("| A | B |\n| --- | --- |\n| a | b |\n|  | c |\n| f1 | f2 |\n\n| x | y |\n| --- | --- |\n| z1 | z2 |");
    });

    it("writes the caption above the table", () => {
        expect(convert("<table><caption>Prices</caption><tr><th>A</th></tr><tr><td>1</td></tr></table>")).toBe("Prices\n\n| A |\n| --- |\n| 1 |");
    });

    it("writes a table nested in a cell as the text of its cells, leaving out a cell a remove rule drops", () => {
        const service = new TurndownService().use(gfm);

        service.remove((node) => node.getAttribute("class") === "no");

        expect(
            service.turndown(
                `<table><tr><th>A</th><th>B</th></tr><tr><td>x<table><tr><td>in 1</td><td class="no">no</td></tr><tr><td>in <b>2</b></td></tr></table>y</td><td>z</td></tr></table>`,
            ),
        ).toBe("| A | B |\n| --- | --- |\n| x in 1 in **2** y | z |");
    });

    it("leaves out the rows and cells a remove rule drops", () => {
        const service = new TurndownService().use(gfm);

        service.remove((node) => node.hasAttribute("hidden"));

        expect(
            service.turndown(
                "<table><tr><th>A</th><th hidden>S</th><th>B</th></tr><tr hidden><td>secret</td></tr><tbody hidden><tr><td>secret</td></tr></tbody><tr><td>a</td><td hidden>secret</td><td>b</td></tr></table>",
            ),
        ).toBe("| A | B |\n| --- | --- |\n| a | b |");
    });

    it("writes block content in a cell on the cell's line, a list as its items and a heading as strong text", () => {
        expect(
            convert(
                "<table><tr><th>A</th></tr><tr><td><ul><li>a</li><li>b</li></ul></td></tr><tr><td><h2>Title</h2></td></tr><tr><td><blockquote>q</blockquote></td></tr></table>",
            ),
        ).toBe("| A |\n| --- |\n| a; b |\n| **Title** |\n| q |");
    });

    it("escapes every pipe in a cell, inside code too, and keeps a backslash in text escaped", () => {
        expect(convert(String.raw`<table><tr><th>A</th><th>B</th></tr><tr><td>a\|b</td><td><code>a|b</code></td></tr></table>`)).toBe(
            ["| A | B |", "| --- | --- |", String.raw`| a\\\|b | ${"`"}a\|b${"`"} |`].join("\n"),
        );
    });

    it("keeps a backslash in code as written and one before code escaped", () => {
        expect(convert(String.raw`<table><tr><th>A</th></tr><tr><td><code>C:\tmp</code> in C:\<code>x</code></td></tr></table>`)).toBe(
            ["| A |", "| --- |", String.raw`| ${"`"}C:\tmp${"`"} in C:\\${"`"}x${"`"} |`].join("\n"),
        );
    });

    it("writes a line break in a cell as a space", () => {
        expect(convert("<table><tr><th>A</th></tr><tr><td>one<br>two</td></tr></table>")).toBe("| A |\n| --- |\n| one two |");
    });

    it("writes a table whose spans would fill too many cells as the text of its cells, a line per row", () => {
        expect(convert(`<table>${"<tr><td colspan=1000>x</td></tr>".repeat(200)}</table>`)).toBe("x\n".repeat(200).trim());
    });

    it("writes nothing for a table with no cells", () => {
        expect(convert("<p>a</p><table></table><p>b</p>")).toBe("a\n\nb");
    });
});

describe("gfm strikethrough", () => {
    it.each(["del", "s", "strike"])("wraps <%s> in tildes", (tag) => {
        expect(convert(`<p>a <${tag}>old</${tag}> b</p>`)).toBe("a ~~old~~ b");
    });

    it("writes nothing for an empty element", () => {
        expect(convert("<p>a<s></s>b</p>")).toBe("ab");
    });
});

describe("gfm task list items", () => {
    it("writes a checkbox as a task box, matching its type without case", () => {
        expect(convert(`<ul><li><input type="CHECKBOX" checked>done</li><li><input type="Checkbox">open</li></ul>`)).toBe("*   [x] done\n*   [ ] open");
    });

    it("writes a checkbox outside a list as a task box too", () => {
        expect(convert(`<div><input type="checkbox" checked>Finish report</div>`)).toBe("[x] Finish report");
    });

    it("leaves other inputs alone", () => {
        expect(convert(`<p>a<input type="text" value="x">b</p>`)).toBe("ab");
    });
});

describe("gfm rules and remove filters", () => {
    it("lets a remove filter drop an element a gfm rule would write", () => {
        const service = new TurndownService().use(gfm);

        service.remove((node) => node.getAttribute("class") === "gone");

        expect(service.turndown(`<p>a <s class="gone">old</s><input class="gone" type="checkbox"> b</p>`)).toBe("a  b");
    });
});

describe("gfm span attributes", () => {
    it("reads a span's leading digits, as HTML does", () => {
        expect(convert(`<table><tr><th colspan="2abc">a</th></tr><tr><td>1</td><td>2</td></tr></table>`)).toBe("| a |  |\n| --- | --- |\n| 1 | 2 |");
    });
});

describe("gfm review cases", () => {
    it("escapes a pipe from a nested table's cell once, so it stays inside the outer cell", () => {
        expect(convert("<table><tr><th>A</th></tr><tr><td><table><tr><td>a|b</td></tr></table></td></tr></table>")).toBe(
            String.raw`| A |
| --- |
| a\|b |`,
        );
    });

    it("writes no separator after the last list item a remove filter keeps", () => {
        const service = new TurndownService().use(gfm);

        service.remove((node) => node.getAttribute("class") === "gone");

        expect(service.turndown(`<table><tr><th>A</th></tr><tr><td><ul><li>a</li><li class="gone">b</li></ul></td></tr></table>`)).toBe(
            "| A |\n| --- |\n| a |",
        );
    });

    it("writes a code block in a cell as inline code, on one line", () => {
        expect(convert("<table><tr><th>A</th></tr><tr><td><pre><code>x *y*\nz</code></pre></td></tr></table>")).toBe("| A |\n| --- |\n| `x *y* z` |");
    });

    it("keeps a nested table's caption with its cells' text", () => {
        expect(convert("<table><tr><th>A</th></tr><tr><td><table><caption>Cap</caption><tr><td>x</td></tr></table></td></tr></table>")).toBe(
            "| A |\n| --- |\n| Cap x |",
        );
    });

    it("keeps a nested list's items apart from the item that holds them", () => {
        expect(convert("<table><tr><th>A</th></tr><tr><td><ul><li>outer<ul><li>inner</li></ul></li><li>next</li></ul></td></tr></table>")).toBe(
            "| A |\n| --- |\n| outer; inner; next |",
        );
    });

    it("writes the head, then the body, then the footer, whatever their order in the source", () => {
        expect(convert("<table><tfoot><tr><td>f</td></tr></tfoot><tbody><tr><td>b</td></tr></tbody><thead><tr><th>h</th></tr></thead></table>")).toBe(
            "| h |\n| --- |\n| b |\n| f |",
        );
    });

    it("escapes literal tildes inside struck text, but not in its code", () => {
        expect(convert("<p><s>a ~~b~~ c <code>~~</code></s></p>")).toBe(String.raw`~~a \~\~b\~\~ c ${"`"}~~${"`"}~~`);
    });

    it("writes one pair of tildes for a strike nested in a strike", () => {
        expect(convert("<p><s>a<del>b</del></s></p>")).toBe("~~ab~~");
    });
});

describe("gfm review cases, second round", () => {
    it("writes a checkbox's current state, which a DOM input may have changed from its attribute", () => {
        const box = `<input type="checkbox">`;
        const document = createDocument(`<ul><li>${box}a</li><li><input type="checkbox" checked>b</li></ul>`);
        const boxes = document.querySelectorAll("input");

        (boxes[0] as HTMLInputElement).checked = true;
        (boxes[1] as HTMLInputElement).checked = false;

        expect(new TurndownService().use(gfm).turndown(document.body)).toBe("*   [x] a\n*   [ ] b");
    });

    it("finds a remove filter that another remove filter adds while it runs", () => {
        const service = new TurndownService().use(gfm);
        let isAdded = false;

        service.remove((node) => {
            if (!isAdded && node.getAttribute("class") === "gone") {
                isAdded = true;
                service.remove((candidate) => candidate.getAttribute("class") === "gone");
            }

            return false;
        });

        expect(service.turndown(`<table><tr><th>A</th><th class="gone">B</th></tr><tr><td>1</td><td class="gone">2</td></tr></table>`)).toBe(
            "| A |\n| --- |\n| 1 |",
        );
    });
});
