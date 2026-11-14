import { describe, expect, it, vi } from "vitest";

import { reportCaughtError } from "@/lib/analytics/track";

import { appendPastedText, insertPastedText } from "../composer-draft-file";
import githubTable from "./__fixtures__/github-readme-table.html?raw";
import googleDocs from "./__fixtures__/google-docs-list.html?raw";
import googleDocsNumbered from "./__fixtures__/google-docs-numbered.html?raw";
import hostileHtml from "./__fixtures__/hostile.html?raw";
import terminalHtml from "./__fixtures__/terminal.html?raw";
import vscodeHtml from "./__fixtures__/vscode.html?raw";
import wordHtml from "./__fixtures__/word-paragraph.html?raw";
import { htmlToMarkdown } from "./html-to-markdown";
import type { PastedText } from "./paste-plan";
import { breaksBefore, inOpenFence, isLongPaste, isPlainHtml, longestBacktickRun, onOwnLines, planPaste, planText } from "./paste-plan";

vi.mock(import("@/lib/analytics/track"), () => {
    return { reportCaughtError: vi.fn(() => true) };
});
// The real converter, which one test makes throw once.
vi.mock(import("./html-to-markdown"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, htmlToMarkdown: vi.fn(actual.htmlToMarkdown) };
});

const pasted = async (plan: ReturnType<typeof planPaste>): Promise<PastedText | undefined> => (plan.kind === "default" ? undefined : planText(plan));

const isMarkdownPlan = async (plan: ReturnType<typeof planPaste>): Promise<boolean> => {
    const result = await pasted(plan);

    return result?.markdown === true;
};

const clipboard = (data: Record<string, string>): Pick<DataTransfer, "getData"> => {
    return { getData: (type: string) => data[type] ?? "" };
};

const paste = async (
    data: Record<string, string>,
    options: { inFence?: boolean; plainOnly?: boolean; selectedText?: string } = {},
): Promise<string | undefined> => {
    const plan = planPaste(clipboard(data), { inFence: options.inFence, plainOnly: options.plainOnly ?? false, selectedText: options.selectedText ?? "" });

    if (plan.kind === "default") {
        return undefined;
    }

    const { text } = await planText(plan);

    return text;
};

describe("composer paste", () => {
    it("turns a Google Docs list with bold, italics and a link into Markdown", async () => {
        await expect(paste({ "text/html": googleDocs, "text/plain": "Release plan\nShip the beta on Monday\nRead the release notes\ntwice" })).resolves.toBe(
            ["Release plan", "", "- **Ship** the beta on Monday", "- Read the [release notes](https://example.com/notes)", "  - *twice*"].join("\n"),
        );
    });

    it("numbers each depth of a flat Google Docs numbered list on its own and indents every line of a nested item", () => {
        expect(htmlToMarkdown(googleDocsNumbered)).toBe(["1. Install", "   1. Download", "      the installer", "   2. Run it", "2. Sign in"].join("\n"));
    });

    it("starts a list copied from a nested Google Docs item at the left edge, keeping its nesting", () => {
        expect(htmlToMarkdown('<ul><li aria-level="2">a</li><li aria-level="3">b</li><li aria-level="2">c</li></ul>')).toBe(["- a", "  - b", "- c"].join("\n"));
    });

    it("keeps a list or text placed straight in a list, nesting a list under the item before it", () => {
        expect(htmlToMarkdown("<ul><li>a</li><ul><li>b</li></ul><li>c</li>d</ul>")).toBe(
            `${htmlToMarkdown("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>")}\n- d`,
        );
        expect(htmlToMarkdown("<ol><li>a</li><ol><li>b</li></ol><li>c</li></ol>")).toBe(htmlToMarkdown("<ol><li>a<ol><li>b</li></ol></li><li>c</li></ol>"));
        expect(htmlToMarkdown("<ul><li>a</li><ul><li>b</li></ul></ul>")).toContain("- b");
    });

    it("starts a Word list copied from a nested level at the left edge, keeping its nesting", () => {
        const item = (level: number, text: string): string =>
            `<p class=MsoListParagraph style='mso-list:l0 level${level} lfo1'><span style='mso-list:Ignore'>o</span>${text}</p>`;

        expect(htmlToMarkdown(item(2, "a") + item(3, "b") + item(2, "c"))).toBe(["- a", "  - b", "- c"].join("\n"));
        // A level-one item in hidden text is not where the shown list starts.
        expect(htmlToMarkdown(`<p>Steps</p><div style="display:none">${item(1, "secret")}</div>${item(3, "a")}`)).toBe("Steps\n\n- a");
    });

    it("keeps the number of a Word list item numbered past 9999", () => {
        expect(htmlToMarkdown(`<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">10000.</span>ten thousand</p>`)).toBe("10000. ten thousand");
    });

    it("keeps a lettered or roman Word marker as text on a list item of its own", () => {
        const item = (level: number, marker: string, text: string): string =>
            `<p style="mso-list:l0 level${level} lfo1"><span style="mso-list:Ignore">${marker}</span>${text}</p>`;

        expect(htmlToMarkdown(item(1, "1.", "First") + item(2, "a.", "Sub") + item(3, "i.", "Deep"))).toBe(
            ["1. First", "   - a. Sub", "     - i. Deep"].join("\n"),
        );
        expect(htmlToMarkdown(item(1, "a)", "one") + item(1, "b)", "two"))).toBe("- a) one\n- b) two");
    });

    it("numbers a reversed list as an ordinary one, from its start, as Markdown numbers every list", () => {
        expect(htmlToMarkdown("<ol reversed><li>b</li><li>a</li></ol>")).toBe("1. b\n2. a");
        expect(htmlToMarkdown('<ol reversed start="10"><li>j</li><li value="4">d</li><li>c</li></ol>')).toBe("10. j\n4. d\n5. c");
        expect(htmlToMarkdown('<ol reversed start="1"><li>a</li><li>z</li></ol>')).toBe("1. a\n2. z");
    });

    it("marks formatted text broken by a line break as one span across its lines", () => {
        expect(htmlToMarkdown("<p><b>one<br>two</b> <i>three<br></i><s> four<br>five</s></p>")).toBe("**one\ntwo** *three*\n~~four\nfive~~");
    });

    it("converts a code block of many line elements in linear time", () => {
        // 30,000 lines: about 0.8 s here, against about 4 s when each line re-read the text built so far. No wall-clock
        // gate (docs/agents/testing.md): the test timeout stops a run that grows far worse than that.
        const html = `<pre>${"<div>let a = 1;</div>".repeat(30_000)}</pre>`;
        const markdown = htmlToMarkdown(html);

        expect(markdown.split("\n").filter((line) => line === "let a = 1;")).toHaveLength(30_000);
    });

    it("takes a Word item's number only from a marker it shows", () => {
        const hiddenMarker = '<span style="display:none"><span style="mso-list:Ignore">9.</span></span>';

        expect(htmlToMarkdown(`<p style="mso-list:l0 level1 lfo1">${hiddenMarker}visible</p>`)).toBe("- visible");
    });

    it("keeps the spaces at both ends of inline code", () => {
        expect(htmlToMarkdown("<p>a <code> both </code> b <code> left</code></p>")).toBe("a `  both  ` b ` left`");
    });

    it("turns a GitHub README table into a GFM table and keeps the code block's language", async () => {
        await expect(paste({ "text/html": githubTable, "text/plain": "Options" })).resolves.toBe(
            [
                "## Options",
                "",
                "| Option | Default | Description |",
                "| --- | --- | --- |",
                "| `timeout` | `30` | Seconds before a request **fails** |",
                '| `mode` | `"a\\|b"` | See [modes](https://github.com/example/repo/blob/main/docs/modes.md) |',
                "",
                "```shell",
                "npm install example",
                "npx example --timeout 10",
                "```",
            ].join("\n"),
        );
    });

    it("fences a multi-line VS Code copy with its language and keeps a one-line copy plain", async () => {
        const code = "const answer = 42;\nconsole.log(answer);";
        const vscode = {
            "text/html": vscodeHtml,
            "text/plain": code,
            "vscode-editor-data": '{"version":1,"isFromEmptySelection":false,"mode":"typescriptreact"}',
        };

        await expect(paste(vscode)).resolves.toBe(`\`\`\`tsx\n${code}\n\`\`\``);
        await expect(paste({ ...vscode, "text/plain": "const answer = 42;" })).resolves.toBe("const answer = 42;");

        // A long copy becomes an attachment of the code as copied, without fence lines.
        const long = Array.from({ length: 12 }, (_: unknown, index: number) => `const line${index} = ${index};`).join("\n");

        await expect(paste({ ...vscode, "text/plain": long })).resolves.toBe(long);

        // So does one that is long only with its fence lines.
        const nine = long.split("\n").slice(0, 9).join("\n");

        await expect(paste({ ...vscode, "text/plain": nine })).resolves.toBe(nine);
    });

    it("pastes a styled Word paragraph and a terminal copy as their plain text", async () => {
        const word = "The quarterly numbers are in, and the trend holds.";
        const terminal = "user@host:~$ ls -la\ntotal 8\n";

        await expect(paste({ "text/html": wordHtml, "text/plain": word })).resolves.toBe(word);
        await expect(paste({ "text/html": terminalHtml, "text/plain": terminal })).resolves.toBe(terminal);
        // Without HTML the editor pastes the text as it always has.
        expect(planPaste(clipboard({ "text/plain": terminal }), { plainOnly: false, selectedText: "" })).toStrictEqual({ kind: "default" });
    });

    it("links the selection when a URL is pasted over it, and pastes a URL alone as typed", async () => {
        await expect(paste({ "text/plain": "https://example.com/a_(b)" }, { selectedText: "the [docs]" })).resolves.toBe(
            String.raw`[the \[docs\]](https://example.com/a_%28b%29)`,
        );
        expect(planPaste(clipboard({ "text/plain": "https://example.com" }), { plainOnly: false, selectedText: "" })).toStrictEqual({ kind: "default" });
        // A URL pasted over a URL replaces it.
        expect(planPaste(clipboard({ "text/plain": "https://new.example" }), { plainOnly: false, selectedText: "https://old.example" })).toStrictEqual({
            kind: "default",
        });
    });

    it("pastes text/plain exactly on Ctrl/Cmd+Shift+V", async () => {
        await expect(paste({ "text/html": googleDocs, "text/plain": "Ship the beta" }, { plainOnly: true, selectedText: "x" })).resolves.toBe("Ship the beta");
        // An HTML-only clipboard is not handed to the editor's rich paste: its visible text goes in, no Markdown added.
        const plan = planPaste(clipboard({ "text/html": googleDocs }), { plainOnly: true, selectedText: "" });

        const result = await pasted(plan);
        const text = result?.text ?? "";

        expect(plan.kind).not.toBe("default");
        expect(text !== "" && !text.includes("**")).toBe(true);
    });

    it("takes the text of HTML too big to convert when it is the only text, and leaves a composer quote chip to the editor", async () => {
        await expect(paste({ "text/html": `<p>Hello</p><!--${"x".repeat(1_000_000)}-->` })).resolves.toBe("Hello");
        // Numeric references are decoded; one that names no character stays as written.
        await expect(paste({ "text/html": `<p>Caf&#233; &#X1F389; &#39;q&#39; &#0; &#xD800;</p><!--${"x".repeat(1_000_000)}-->` })).resolves.toBe(
            "Café 🎉 'q' &#0; &#xD800;",
        );
        // What the page does not show stays out: script, style, noscript and template content, in any case, closed or not.
        await expect(
            paste({
                "text/html": `<SCRIPT>s<b></Script ><style>p{}</style>Hi<noscript>n</noscript><Template>t</template><p>${"x".repeat(1_000_000)}<script>s`,
            }),
        ).resolves.toBe(`Hi\n${"x".repeat(1_000_000)}`);

        const text = await paste({ "text/html": "<div><b>row</b> &amp; &lt;more&gt;</div>".repeat(150_000) });

        expect(text?.startsWith("row & <more>\nrow")).toBe(true);
        expect(text).toHaveLength(150_000 * "row & <more>\n".length - 1);
        // Blocks, lines and cells keep their words apart.
        await expect(
            paste({ "text/html": `<p>one</p><p>two<br>three</p><table><tr><td>a</td><td>b</td></tr></table><!--${"x".repeat(1_000_000)}-->` }),
        ).resolves.toBe("one\ntwo\nthree\n a b");
        // Each <br> is a line, so two keep their blank line; one that ends a block is its end, and Windows line ends are one.
        await expect(paste({ "text/html": `<p>A<br><br>B</p>\r\n<div>C<br></div><div><br></div><div>D</div><!--${"x".repeat(1_000_000)}-->` })).resolves.toBe(
            "A\n\nB\nC\n\nD",
        );
        expect(isLongPaste(text ?? "")).toBe(true);
        expect(
            planPaste(
                clipboard({
                    "text/html": '<div data-quote-chip="" data-message-id="m1"><blockquote><p>quoted</p></blockquote></div>',
                    "text/plain": "> quoted",
                }),
                {
                    plainOnly: false,
                    selectedText: "",
                },
            ),
        ).toStrictEqual({ kind: "default" });
    });

    it("converts formatting whose HTML only mentions a quote chip, and leaves a real chip to the editor", () => {
        const plan = (html: string) => planPaste(clipboard({ "text/html": html, "text/plain": "bold" }), { plainOnly: false, selectedText: "" }).kind;

        expect(plan("<!-- <div data-quote-chip> --><strong>bold</strong>")).toBe("html");
        expect(plan('<div title="data-quote-chip"><strong>bold</strong></div>')).toBe("html");
        expect(plan("<div data-quote-chip-x><strong>bold</strong></div>")).toBe("html");
        expect(plan("<p>data-quote-chip <strong>bold</strong></p>")).toBe("html");
        expect(plan('<div class="x" DATA-QUOTE-CHIP data-message-id="m1"><blockquote><p>bold</p></blockquote></div>')).toBe("default");
        expect(plan('<meta charset="utf-8"><div data-x=\'a>b\' data-quote-chip=""><blockquote><p>bold</p></blockquote></div>')).toBe("default");
    });

    it("leaves a quote chip beside plain text to the editor, and converts one beside formatting", async () => {
        const chip = '<div data-quote-chip="" data-message-id="m1"><blockquote><p>quoted</p></blockquote></div>';
        const plan = (html: string) => planPaste(clipboard({ "text/html": html, "text/plain": "x" }), { plainOnly: false, selectedText: "" }).kind;

        expect(plan(`${chip}<p>my comment</p>`)).toBe("default");
        // A div nested in the chip is part of it, and what follows the chip is still looked at.
        expect(plan(`<div data-quote-chip=""><div><blockquote><p>q</p></blockquote></div></div><p>plain</p>`)).toBe("default");
        expect(plan(`<div data-quote-chip=""><div><blockquote><p>q</p></blockquote></div></div><p><strong>bold</strong></p>`)).toBe("html");
        // A `</div>` in an attribute value or a `<` in text does not end the chip.
        expect(plan(`<div data-quote-chip=""><span title="</div>">1 < 2</span><blockquote><p>q</p></blockquote></div><p>plain</p>`)).toBe("default");
        expect(plan(`${chip}<p>see <a href="https://example.com">this</a></p>`)).toBe("html");
        await expect(paste({ "text/html": `${chip}<p><strong>bold</strong> reply</p>`, "text/plain": "> quoted\n\nbold reply" })).resolves.toBe(
            "> quoted\n\n**bold** reply",
        );
    });

    it("keeps a less-than sign that starts no tag in the text of HTML too big to convert", async () => {
        await expect(paste({ "text/html": `<p>2 < 3 <= 4 <3</p><!--${"x".repeat(1_000_000)}-->` })).resolves.toBe("2 < 3 <= 4 <3");
    });

    it("keeps quoted attribute values out of the text of HTML too big to convert", async () => {
        await expect(
            paste({ "text/html": `<div title=">secret">visible</div><div data-x='a>b'>two</div><p>don't > stop</p><!--${"x".repeat(1_000_000)}-->` }),
        ).resolves.toBe("visible\ntwo\ndon't > stop");
    });

    it("plans crafted multi-megabyte HTML in linear time", () => {
        const plain = { plainOnly: false, selectedText: "" };

        // No wall-clock gate (docs/agents/testing.md): a pattern that rescans from every match takes minutes here, past the
        // test timeout.
        for (const html of [
            "class=".repeat(500_000),
            "<b ".repeat(1_000_000),
            "<a ".repeat(1_000_000),
            "text-decoration".repeat(200_000),
            '<i title="class=language-x">'.repeat(35_000),
        ]) {
            expect(planPaste(clipboard({ "text/html": html, "text/plain": "plain" }), plain).kind).not.toBe("default");
            // Under the cap the formatting checks run on all of it.
            expect(typeof isPlainHtml(html.slice(0, 1_000_000))).toBe("boolean");
        }
    });

    it("converts a crafted style attribute under the cap in linear time", () => {
        // A crafted style of 800 KB took 69 s before the patterns were bounded: past the test timeout, with no wall-clock gate.
        for (const style of ["text-decoration:".repeat(50_000), "mso-list:".repeat(80_000)]) {
            expect(htmlToMarkdown(`<p><span style="${style}">x</span></p>`)).toBe("x");
        }
    });

    it("falls back to the plain text for HTML nested too deep to convert in bounded work", async () => {
        // Each quote re-indents all it holds: 300 deep over 1000 lines would be ~90M characters.
        const quotes = `${"<blockquote>".repeat(300)}${"a<br>".repeat(1000)}`;

        expect(() => htmlToMarkdown(quotes)).toThrow(RangeError);
        expect(() => htmlToMarkdown(`${"<div>".repeat(600)}a`)).toThrow(RangeError);
        expect(() => htmlToMarkdown("<ul><li>a</li>".repeat(600))).toThrow(RangeError);
        await expect(paste({ "text/html": quotes, "text/plain": "plain" })).resolves.toBe("plain");
        await expect(paste({ "text/html": `${"<ul><li>".repeat(600)}deep` })).resolves.toBe("deep");
        expect(htmlToMarkdown(`${"<blockquote>".repeat(3)}a`)).toBe("> > > a");
    });

    it("reads the rows of tables nested in cells once each, not once per table around them", () => {
        const depth = 200;
        const html = `${"<table><tr><td>".repeat(depth)}<table>${"<tr><td>r</td></tr>".repeat(500)}</table>${"</td></tr></table>".repeat(depth)}`;
        const elements = new DOMParser().parseFromString(html, "text/html").body.querySelectorAll("*").length;
        // Calls through: counts the children every walk lists, so a nested table read again per table around it shows up.
        const listed = vi.spyOn(Element.prototype, "children", "get");

        try {
            expect(htmlToMarkdown(html)).toBe(`| ${"r ".repeat(500).trim()} |\n| --- |`);
            const visited = listed.mock.results.reduce((sum: number, result) => sum + (result.value as HTMLCollection).length, 0);

            // Read once each: a few listings per element. Read per enclosing table: about depth × 500 rows (100,000).
            expect(visited).toBeLessThan(elements * 4);
        } finally {
            listed.mockRestore();
        }
    });

    it("keeps runs of non-breaking spaces, which HTML does not collapse", () => {
        expect(htmlToMarkdown("<p>a\u{A0}\u{A0}\u{A0}b <b>c</b></p>")).toBe("a\u{A0}\u{A0}\u{A0}b **c**");
    });

    it("keeps a link whose label is broken by a line break, its label on one line", () => {
        expect(htmlToMarkdown('<p><a href="https://example.com/">first<br>second</a></p>')).toBe("[first second](https://example.com/)");
    });

    it("pastes deeply nested formatting around many lines as plain text instead of rebuilding them per element", async () => {
        const html = `${"<b>".repeat(400)}${"line<br>".repeat(5000)}${"</b>".repeat(400)}`;

        expect(() => htmlToMarkdown(html)).toThrow(RangeError);
        await expect(paste({ "text/html": html, "text/plain": "plain" })).resolves.toBe("plain");
    });

    it("keeps the spaces inside a link's tag around the link", () => {
        expect(htmlToMarkdown('<p>Read<a href="https://example.com/"> docs </a>today</p>')).toBe("Read [docs](https://example.com/) today");
    });

    it("keeps task boxes whatever the case of their type", () => {
        expect(htmlToMarkdown('<ul><li><input type="CHECKBOX" checked>done</li><li><input type="Checkbox">open</li></ul>')).toBe("- [x] done\n- [ ] open");
    });

    it("pastes a table whose spans would fill too many cells as its text", () => {
        expect(htmlToMarkdown(`<table>${"<tr><td colspan=1000>x</td></tr>".repeat(200)}</table>`)).toBe("x\n".repeat(200).trim());
    });

    it("measures a huge HTML paste by its Markdown, so it becomes an attachment", async () => {
        const rows = Array.from({ length: 40 }, (_: unknown, index: number) => `<tr><td>row ${index}</td><td><b>value</b></td></tr>`).join("");
        const markdown = await paste({ "text/html": `<table><tr><th>Name</th><th>Value</th></tr>${rows}</table>`, "text/plain": "short" });

        expect(markdown?.split("\n")).toHaveLength(42);
        expect(isLongPaste(markdown ?? "")).toBe(true);
    });

    it("never runs or keeps script, handlers, styles, comments or unsafe links from the HTML", async () => {
        const markdown = await paste({ "text/html": hostileHtml, "text/plain": "Hello world" });

        expect(markdown).toBe("Hello **world**\n\nclick me");
        expect((globalThis as { __pasteExecuted?: boolean }).__pasteExecuted).toBeUndefined();
    });

    it.each([
        ["repeated <br> keeps its blank lines", "<p>A<br><br>B</p><div>C<br>\n<br>D</div>", "A\n\nB\n\nC\n\nD"],
        [
            "a table nested in a cell keeps its shown text",
            '<table><tr><th>A</th><th>B</th></tr><tr><td>x<table><tr><td>in 1</td><td style="display:none">no</td></tr><tr><td>in <b>2</b></td></tr></table>y</td><td>z</td></tr></table>',
            "| A | B |\n| --- | --- |\n| x in 1 in **2** y | z |",
        ],
        ["a div per line is a line each", "<div>one <b>1</b></div> <div>two</div><div><br></div><div>four</div><p>para</p>", "one **1**\ntwo\n\nfour\n\npara"],
        ["a code block in a list item stays in it", "<ul><li>step<pre>a\n\nb</pre></li></ul>", "- step\n\n  ```\n  a\n\n  b\n  ```"],
        ["a code block in a quote stays in it", "<blockquote><p>q</p><pre>a\nb</pre></blockquote>", "> q\n>\n> ```\n> a\n> b\n> ```"],
        [
            "text the page hides is left out",
            '<p>Hi <span style="visibility:hidden">secret</span><span class="sr-only">sr</span><b aria-hidden="true">x</b>there</p>',
            "Hi there",
        ],
        [
            "text the page hides inside code is left out",
            '<p><code>a<span style="display:none">HIDDEN</span>b</code></p><pre>x<span class="sr-only">HIDDEN</span><script>HIDDEN</script>y</pre>',
            "`ab`\n\n```\nxy\n```",
        ],
        [
            "a code block with a line per <br> or per div keeps its lines",
            "<pre>a<br>b</pre><pre><div>c</div><div>d</div></pre>",
            "```\na\nb\n```\n\n```\nc\nd\n```",
        ],
        [
            "a Word list paragraph keeps its later lines in the item",
            '<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">1.</span>one<br>two</p><p style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">o</span>three<br>four</p>',
            "1. one\n   two\n   - three\n     four",
        ],
        [
            "a cell spanning columns or rows keeps the cells after it under their headers",
            '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan="2">ab</td><td>c</td></tr><tr><td rowspan="2">a</td><td>b</td><td>c</td></tr><tr><td>b2</td><td>c2</td></tr></table>',
            "| A | B | C |\n| --- | --- | --- |\n| ab |  | c |\n| a | b | c |\n|  | b2 | c2 |",
        ],
        [
            "a cell spans down to the end of its row group at most, so the footer keeps its columns",
            [
                '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td rowspan="0">a</td><td>b</td></tr><tr><td>c</td></tr></tbody>',
                '<tfoot><tr><td>f1</td><td>f2</td></tr></tfoot></table><table><tbody><tr><td rowspan="5">x</td><td>y</td></tr></tbody><tbody><tr><td>z1</td><td>z2</td></tr></tbody></table>',
            ].join(""),
            "| A | B |\n| --- | --- |\n| a | b |\n|  | c |\n| f1 | f2 |\n\n| x | y |\n| --- | --- |\n| z1 | z2 |",
        ],
        [
            "only a style that hides text hides it, not the same words inside another value",
            '<p><span style="background-image:url(https://example.com/display:none)">shown</span> <span style="display: none !important">gone</span></p>',
            "shown",
        ],
        [
            "hidden list items are left out",
            '<ol><li>one</li><li hidden>secret</li><li style="display:none">secret</li><li aria-hidden="true">secret</li><li>two</li></ol>',
            "1. one\n2. two",
        ],
        [
            "hidden table rows and cells are left out",
            '<table><tr><th>A</th><th style="display:none">S</th><th>B</th></tr><tr style="display:none"><td>secret</td></tr><tbody hidden><tr><td>secret</td></tr></tbody><tr><td>a</td><td aria-hidden="true">secret</td><td>b</td></tr></table>',
            "| A | B |\n| --- | --- |\n| a | b |",
        ],
        [
            "a backslash in a cell or a link label never escapes the Markdown around it",
            String.raw`<table><tr><th>A</th><th>B</th></tr><tr><td>a\|b</td><td>c</td></tr></table><p><a href="https://x.y/">C:\dir\</a> <a href="https://x.y/">a\]b</a></p>`,
            ["| A | B |", "| --- | --- |", String.raw`| a\\\|b | c |`, "", String.raw`[C:\\dir\\](https://x.y/) [a\\\]b](https://x.y/)`].join("\n"),
        ],
        [
            "code in a table cell keeps its backslashes, escapes its pipes for the row, and a backslash before it never escapes its backtick",
            String.raw`<table><tr><th>A</th></tr><tr><td><code>C:\tmp</code> or <code>a|b</code> in C:\<code>x</code></td></tr></table>`,
            "| A |\n| --- |\n| `C:\\tmp` or `a\\|b` in C:\\\\`x` |",
        ],
        [
            "code in a link label is kept as written, and a backslash before it never escapes its backtick",
            '<p><a href="https://x.y/"><code>arr[0]</code> and a[1]</a> <a href="https://x.y/">C:\\<code>x\\y</code></a> <a href="https://x.y/">a`b[</a></p>',
            "[`arr[0]` and a\\[1\\]](https://x.y/) [C:\\\\`x\\y`](https://x.y/) [a\\`b\\[](https://x.y/)",
        ],
        ["a table keeps its caption", "<table><caption>Prices</caption><tr><th>A</th></tr><tr><td>1</td></tr></table>", "Prices\n\n| A |\n| --- |\n| 1 |"],
        [
            "a numbered list keeps a zero start and an item's own number",
            '<ol start="0"><li>zero</li><li>one</li></ol><ol><li>a</li><li value="5">five</li><li>six</li></ol>',
            "0. zero\n1. one\n\n1. a\n5. five\n6. six",
        ],
        [
            "emoji and formulas drawn as images keep their text",
            '<p>Ship <img alt="🎉"> <img alt="👍🏽"> <img alt="👨‍👩‍👧"> <img alt=":tada:"> <img class="mwe-math-fallback-image-inline" alt="E=mc^2"> <img alt="A chart"> <img alt="Report 🎉"></p>',
            "Ship 🎉 👍🏽 👨‍👩‍👧 :tada: $E=mc^2$",
        ],
        [
            "an emoji or formula drawn as an image in a picture keeps its text",
            '<p>Ship <picture><source srcset="https://x.y/a.webp"><img alt="🎉" src="https://x.y/a.png"></picture> <picture><img class="math" alt="x^2"></picture></p>',
            "Ship 🎉 $x^2$",
        ],
        [
            "a dollar sign in a formula's source cannot end it early, so the rest stays in the formula",
            '<p><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x$ [click](https://x.y/) $y</annotation></semantics></math> <img class="math" alt="$$a"></p>',
            "$$x$ [click](https://x.y/) $y$$ $$$ $$a $$$",
        ],
        [
            "a closed details shows its summary alone, an open one all of it",
            "<details><summary>Logs</summary><p>hidden line</p>loose text</details><details><p>no summary</p></details><details open><summary>Shown</summary><p>body</p></details>",
            "Logs\n\nShown\n\nbody",
        ],
        [
            "a link in a table cell keeps its label escaped once, a backslash before code in it and a pipe too",
            String.raw`<table><tr><th>A</th></tr><tr><td><a href="https://x.y/">a\<code>b|c</code>]</a> <a href="https://x.y/">d|]e</a> <a href="https://x.y/a|b">https://x.y/a|b</a></td></tr></table>`,
            ["| A |", "| --- |", String.raw`| [a\\${"`"}b\|c${"`"}\]](https://x.y/) [d\|\]e](https://x.y/) [https://x.y/a\|b](https://x.y/a\|b) |`].join("\n"),
        ],
        [
            "a MathML formula without TeX keeps its visible text, not its other annotations",
            '<p>Area <math><semantics><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><annotation encoding="StarMath">a + b</annotation></semantics></math> here</p>',
            "Area a+b here",
        ],
    ])("%s", (_label: string, html: string, markdown: string) => {
        expect(htmlToMarkdown(html)).toBe(markdown);
    });

    it.each([
        [
            "part of a Google Docs paragraph with bold",
            '<b style="font-weight:normal" id="docs-internal-guid-1"><span style="font-weight:700;white-space:pre-wrap">bold</span> rest</b>',
            false,
        ],
        ["inline code in a sentence", 'Call <code style="font-family:ui-monospace,monospace">foo()</code> now', false],
        ["a lone code block with a language", '<pre class="language-js">x()</pre>', false],
        ["a lone code block with a language in single quotes", "<pre class='language-js'>x()</pre>", false],
        ["a lone code block with a language and spaces around the equals sign", '<pre class = "language-js">x()</pre>', false],
        ["a strikethrough style", '<span style="text-decoration:line-through">old</span> price', false],
        ["a MathML formula", "<math><mi>x</mi></math>", false],
        ["an emoji drawn as an image", '<span>Ship <img alt="🎉"></span>', false],
        [
            "a JetBrains copy with bold keywords",
            '<pre style="font-family:\'JetBrains Mono\',monospace"><span style="font-weight:bold">fun</span> x()</pre>',
            true,
        ],
    ])("treats %s as plain: %s", (_label: string, html: string, plain: boolean) => {
        expect(isPlainHtml(html)).toBe(plain);
    });

    it("finds the longest backtick run in code with more runs than a call takes arguments", () => {
        expect(longestBacktickRun(`${"`a".repeat(300_000)}\`\`\``)).toBe(3);
    });

    it("keeps backticks inside code from closing the fence", () => {
        expect(htmlToMarkdown('<p>Run <code>a`b</code></p><pre class="language-md">```js\nx\n```</pre>')).toBe("Run ``a`b``\n\n````md\n```js\nx\n```\n````");
    });
});

describe("pasted blocks beside text", () => {
    const table = "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>";
    // The draft once the paste lands at `caret`, as the composer inserts it.
    const pasteInto = async (draft: string, caret: number, data: Record<string, string>): Promise<string> => {
        const text = (await paste(data)) ?? "";

        return insertPastedText(draft, onOwnLines(text, caret > 0 && draft[caret - 1] !== "\n", caret < draft.length && draft[caret] !== "\n"), caret, caret);
    };

    it("starts a table pasted after text on its own line, a blank line apart", async () => {
        await expect(pasteInto("Hi ", 3, { "text/html": table, "text/plain": "a\tb\n1\t2" })).resolves.toSatisfy((draft: string) =>
            draft.startsWith("Hi \n\n| a | b |"),
        );
    });

    it("adds nothing to a table pasted at the start of an empty line", async () => {
        const markdown = await paste({ "text/html": table, "text/plain": "a\tb\n1\t2" });

        await expect(pasteInto("Hi\n", 3, { "text/html": table, "text/plain": "a\tb\n1\t2" })).resolves.toBe(`Hi\n${markdown}`);
    });

    it("keeps the language of a code block written with spaces around its class's equals sign", async () => {
        await expect(paste({ "text/html": '<pre class = "language-js">x()</pre>', "text/plain": "x()" })).resolves.toBe("```js\nx()\n```");
    });

    it("keeps a MathML formula without TeX in a paste with other formatting", async () => {
        await expect(paste({ "text/html": "<p><b>Sum</b>: <math><mi>x</mi><mo>+</mo><mn>1</mn></math></p>", "text/plain": "Sum: x+1" })).resolves.toBe(
            "**Sum**: x+1",
        );
    });

    it("puts a code block pasted mid-line on lines of its own", async () => {
        await expect(pasteInto("before after", 7, { "text/html": '<pre class="language-js">x()</pre>', "text/plain": "x()" })).resolves.toBe(
            "before \n\n```js\nx()\n```\n\nafter",
        );
    });

    it.each([
        ["a list pasted mid-line", "<ul><li>a</li><li>b</li></ul>", "foo \n- a\n- b\n\nbar"],
        ["a quote pasted mid-line", "<blockquote><p>q</p></blockquote>", "foo \n> q\n\nbar"],
        ["a numbered list starting at 3", '<ol start="3"><li>c</li></ol>', "foo \n\n3. c\n\nbar"],
        ["a heading", "<h2>Title</h2>", "foo \n## Title\nbar"],
        // A blank line before, or the text before it becomes a heading.
        ["a rule", "<hr>", "foo \n\n---\n\nbar"],
    ])("keeps the text after %s out of it", async (_label: string, html: string, draft: string) => {
        await expect(pasteInto("foo bar", 4, { "text/html": html, "text/plain": "x" })).resolves.toBe(draft);
    });

    it.each([
        ["a table", table, "typed\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"],
        ["a list", "<ul><li>a</li><li>b</li></ul>", "typed\n- a\n- b"],
        ["a link", '<a href="https://example.com/docs">docs</a>', "typed\n[docs](https://example.com/docs)"],
    ])("starts %s appended to a draft edited while it converted on a line of its own", async (_label: string, html: string, draft: string) => {
        const text = (await paste({ "text/html": html, "text/plain": "x" })) ?? "";

        expect(appendPastedText("typed", text, breaksBefore(text))).toBe(draft);
    });

    it("keeps an inline paste inline", async () => {
        await expect(pasteInto("see  here", 4, { "text/html": '<a href="https://example.com/docs">docs</a>', "text/plain": "docs" })).resolves.toBe(
            "see [docs](https://example.com/docs) here",
        );
    });
});

describe("a paste inside a code block the person typed", () => {
    it("knows a fence is open from an odd number of fence lines before the caret", () => {
        expect(inOpenFence("Look:\n```ts\nconst a = 1;\n")).toBe(true);
        expect(inOpenFence("```\nx\n```\nafter ")).toBe(false);
        expect(inOpenFence("no fence")).toBe(false);
    });

    it("closes a fence only on a bare run of its own character at least as long", () => {
        expect(inOpenFence("````md\n```\nnested\n")).toBe(true);
        expect(inOpenFence("```\n~~~\n```js\nx\n")).toBe(true);
        expect(inOpenFence("````md\n```\n````  \nafter ")).toBe(false);
        expect(inOpenFence("``` a`b\ntext")).toBe(false);
    });

    it("sees a fence opened inside a quote or a list item", () => {
        expect(inOpenFence("> ```md\n> some\n")).toBe(true);
        expect(inOpenFence("- ```js\n  code\n")).toBe(true);
        expect(inOpenFence("1. a\n   - ```js\n     code\n")).toBe(true);
        expect(inOpenFence("> ```\n> x\n> ```\nafter ")).toBe(false);
        expect(inOpenFence("- ```js\n  x\n  ```\n- after ")).toBe(false);
        expect(inOpenFence("-```\n* * *\n")).toBe(false);
    });

    it("inserts code as copied, without a fence of its own or Markdown", async () => {
        const code = "const a = 1;\nconst b = 2;";
        const vscode = { "text/html": "<div>x</div>", "text/plain": code, "vscode-editor-data": '{"mode":"typescript"}' };

        await expect(paste(vscode, { inFence: true })).resolves.toBe(code);
        await expect(paste({ "text/html": '<pre class="language-js">x()</pre>', "text/plain": "x()" }, { inFence: true })).resolves.toBe("x()");
        await expect(paste(vscode)).resolves.toBe(`\`\`\`typescript\n${code}\n\`\`\``);
    });
});

describe("a converted block pasted on a line of its own", () => {
    it("takes the blank line a table needs beside text on the line below or above", () => {
        const table = "| A |\n| --- |";

        expect(onOwnLines(table, false, false, { lineAfter: true })).toBe(`${table}\n`);
        expect(onOwnLines(table, false, false, { lineBefore: true })).toBe(`\n${table}`);
        expect(onOwnLines("# Title", false, false, { lineAfter: true })).toBe("# Title");
        expect(onOwnLines(table, false, false)).toBe(table);
    });
});

describe("plain-looking HTML that still carries Markdown", () => {
    it("converts a horizontal rule or a task box outside a list instead of taking the plain text", async () => {
        await expect(paste({ "text/html": '<div><input type="checkbox" checked>Finish report</div>', "text/plain": "Finish report" })).resolves.toBe(
            "[x] Finish report",
        );
        await expect(paste({ "text/html": "<div>a</div><hr><div>b</div>", "text/plain": "a\nb" })).resolves.toBe("a\n\n---\n\nb");
    });
});

describe("HTML past the conversion cap", () => {
    it("skips a quoted attribute value however much space comes after its equals sign", async () => {
        const html = `<p title=${" ".repeat(40)}"a > b">kept</p>${"<p>x</p>".repeat(140_000)}`;
        const text = await paste({ "text/html": html });

        expect(text?.startsWith("kept")).toBe(true);
        expect(text).not.toContain('b"');
    });
});

describe("code blocks of line elements", () => {
    it("keeps text after a line element on a line of its own", () => {
        expect(htmlToMarkdown("<pre><div>first</div>tail</pre>")).toBe("```\nfirst\ntail\n```");
    });
});

describe("raw text in HTML past the conversion cap", () => {
    it("ends a script only at its own end tag, not at a longer name", async () => {
        const html = `<script>secret</scripture><p>leaked</p></script><p>kept</p>${"<p>x</p>".repeat(140_000)}`;
        const text = await paste({ "text/html": html });

        expect(text?.startsWith("kept")).toBe(true);
        expect(text).not.toContain("leaked");
    });
});

describe("a plain Word list", () => {
    it("converts a Word list with no other formatting instead of taking its bulleted plain text", async () => {
        const item = (text: string): string => `<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·</span>${text}</p>`;

        await expect(paste({ "text/html": item("one") + item("two"), "text/plain": "·\tone\n·\ttwo" })).resolves.toBe("- one\n- two");
    });
});

describe("a link whose tag quotes an angle bracket", () => {
    it("still counts as formatting, so the link is kept, its title too", async () => {
        await expect(paste({ "text/html": '<a title="2 > 1" href="https://example.com/">docs</a>', "text/plain": "docs" })).resolves.toBe(
            '[docs](https://example.com/ "2 > 1")',
        );
    });
});

describe("lists nested in the page's list items", () => {
    it("stay tight: no blank line between an item's text and its sub-list", () => {
        expect(htmlToMarkdown("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>")).toBe("- a\n  - b\n- c");
    });
});

describe("a code block of deeply nested spans", () => {
    it("is read once, however many elements wrap its text", () => {
        const html = `<pre>${"<span>".repeat(400)}${"x".repeat(200_000)}${"</span>".repeat(400)}</pre>`;

        // No wall-clock gate (docs/agents/testing.md): the test timeout stops a run far slower than one read of the text.
        expect(htmlToMarkdown(html).length).toBeGreaterThan(200_000);
    });
});

describe("a comment before the first element", () => {
    it("is not read as a monospace block, so the bold text after it converts", async () => {
        await expect(paste({ "text/html": "<!-- <pre> --><strong>Important</strong>", "text/plain": "Important" })).resolves.toBe("**Important**");
    });
});

describe("named references in HTML past the conversion cap", () => {
    it("decodes them as the page shows them, the legacy prefix match included", async () => {
        const html = `<p>caf&eacute;&hellip; &notaname; &zz;</p>${"<p>x</p>".repeat(140_000)}`;
        const text = await paste({ "text/html": html });

        // `&notaname;` reads as "¬aname;" in a browser too; a name that matches nothing stays as written.
        expect(text?.split("\n", 1)[0]).toBe("café… ¬aname; &zz;");
    });
});

describe("an HTML-only copy pasted inside a code fence", () => {
    it("goes in as its visible text, with no Markdown added and its indentation kept", async () => {
        const plan = planPaste(
            {
                getData: (type: string) =>
                    type === "text/html" ? "<p><b>const</b> a = 1;</p><p>b()<span hidden>secret</span></p><pre>  if (x) {\n    y();\n  }</pre>" : "",
            },
            { inFence: true, plainOnly: false, selectedText: "" },
        );

        await expect(pasted(plan)).resolves.toMatchObject({ text: "const a = 1;\nb()\n  if (x) {\n    y();\n  }" });
        await expect(isMarkdownPlan(plan)).resolves.toBe(false);
    });
});

describe("the plain-paste shortcut on an HTML-only copy", () => {
    it("pastes its visible text instead of nothing, hidden parts left out", async () => {
        const html = [
            '<p><b>bold</b>   text<span style="display:none">secret</span><span aria-hidden="true">secret</span></p>',
            "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table><ul><li>one</li><li>two</li></ul>",
        ].join("");
        const plan = planPaste({ getData: (type: string) => (type === "text/html" ? html : "") }, { inFence: false, plainOnly: true, selectedText: "" });

        await expect(pasted(plan)).resolves.toMatchObject({ text: "bold text\na b\nc d\none\ntwo" });
        // Text as copied: no breaks are added to keep a block off the text beside the caret, even when it starts like one.
        await expect(isMarkdownPlan(plan)).resolves.toBe(false);
    });

    it("takes the text of HTML too big to parse in one pass", () => {
        const html = `<p>words</p>${"<b></b>".repeat(200_000)}`;
        const plan = planPaste({ getData: (type: string) => (type === "text/html" ? html : "") }, { inFence: false, plainOnly: true, selectedText: "" });

        expect(plan).toStrictEqual({ kind: "text", text: "words" });
    });
});

describe("which plans are Markdown the plan wrote", () => {
    it("counts converted HTML, a fenced editor copy and a link over a selection, not text as copied", async () => {
        const plan = async (data: Record<string, string>, selectedText = ""): Promise<boolean> =>
            isMarkdownPlan(planPaste(clipboard(data), { plainOnly: false, selectedText }));

        await expect(plan({ "text/html": "<b>bold</b>", "text/plain": "bold" })).resolves.toBe(true);
        await expect(plan({ "text/plain": "a\nb", "vscode-editor-data": JSON.stringify({ mode: "typescript" }) })).resolves.toBe(true);
        await expect(plan({ "text/plain": "https://x.y/" }, "docs")).resolves.toBe(true);
        await expect(plan({ "text/html": "<p>| a |</p>", "text/plain": "| a |" })).resolves.toBe(false);
        const plainShortcut = planPaste(clipboard({ "text/plain": "| a |" }), { plainOnly: true, selectedText: "" });

        await expect(isMarkdownPlan(plainShortcut)).resolves.toBe(false);
    });

    it("does not count the plain text a conversion falls back to, so it goes in as copied", async () => {
        // Too deep to convert, and past the conversion cap: the text as copied, even when it starts like a block.
        await expect(planText({ html: `${"<ul><li>".repeat(600)}deep`, kind: "html", plain: "- item" })).resolves.toStrictEqual({
            markdown: false,
            text: "- item",
        });
        await expect(planText({ html: `<b>x</b>${" ".repeat(1_100_000)}`, kind: "html", plain: "# x" })).resolves.toStrictEqual({
            markdown: false,
            text: "# x",
        });
        // Formatting that holds no text.
        await expect(planText({ html: "<b></b>", kind: "html", plain: "> quote" })).resolves.toStrictEqual({ markdown: false, text: "> quote" });
    });
});

describe("a converter that throws", () => {
    it("reports a bug in it and pastes the plain text, without reporting HTML it refuses", async () => {
        const bug = new TypeError("Cannot read properties of null");

        vi.mocked(htmlToMarkdown).mockImplementationOnce(() => {
            throw bug;
        });

        await expect(planText({ html: "<b>secret</b>", kind: "html", plain: "secret" })).resolves.toStrictEqual({ markdown: false, text: "secret" });
        expect(reportCaughtError).toHaveBeenCalledExactlyOnceWith(bug, { feature: "composer-paste" });

        vi.mocked(reportCaughtError).mockClear();

        await expect(planText({ html: `${"<div>".repeat(600)}a`, kind: "html", plain: "a" })).resolves.toStrictEqual({ markdown: false, text: "a" });
        expect(reportCaughtError).not.toHaveBeenCalled();
    });
});

describe("text set back to normal weight inside bold", () => {
    it.each([
        ["a span", '<b>Bold <span style="font-weight:normal">normal</span> again</b>', "**Bold** normal **again**"],
        ["a numeric weight inside a bold span", '<span style="font-weight:700">a<span style="font-weight:400">b</span>c</span>', "**a**b**c**"],
        ["a normal-weight b", '<strong>one <b style="font-weight:normal">two</b></strong>', "**one** two"],
        ["bold again inside it", '<b>a <span style="font-weight:normal">b <b>c</b> d</span> e</b>', "**a** b **c** d **e**"],
        ["across lines", '<b>a<br><span style="font-weight:normal">b</span><br>c</b>', "**a**\nb\n**c**"],
        ["with no bold around it", '<p>a <span style="font-weight:normal">b</span> <i>c</i></p>', "a b *c*"],
        ["italic on the same span", '<b><span style="font-weight:400;font-style:italic">x</span></b>', "*x*"],
        ["struck on the same span", '<b><span style="font-weight:400;text-decoration:line-through">x</span></b>', "~~x~~"],
        ["inside italics in the bold", '<b><i><span style="font-weight:normal">x</span> y</i></b>', "*x* ***y***"],
    ])("stays out of the bold: %s", (_: string, html: string, markdown: string) => {
        expect(htmlToMarkdown(html)).toBe(markdown);
    });
});

describe("superscripts and subscripts", () => {
    it.each([
        ["an exponent", "<strong>E=mc<sup>2</sup></strong>", "**E=mc²**"],
        ["a chemical formula", "<p><b>H<sub>2</sub>O</b> and CO<sub>2</sub></p>", "**H₂O** and CO₂"],
        ["a signed exponent", "<p><i>x<sup>-(n+1)</sup></i></p>", "*x⁻⁽ⁿ⁺¹⁾*"],
        ["an ordinal, kept as text", "<p>12<sup>th</sup> <b>May</b></p>", "12th **May**"],
        ["a footnote mark, kept as text", "<p>Fact<sup>[1]</sup> <b>here</b></p>", String.raw`Fact\[1\] **here**`],
    ])("keeps the raised or lowered meaning where Unicode can: %s", (_: string, html: string, markdown: string) => {
        expect(htmlToMarkdown(html)).toBe(markdown);
    });
});

describe("formatting on part of an emoji sequence", () => {
    it.each([
        ["the first emoji bold", "<p><strong>👩</strong>\u{200D}👩 hi</p>", "👩\u{200D}👩 hi"],
        ["the last emoji italic", "<p>👩\u{200D}<em>👧</em></p>", "👩\u{200D}👧"],
        ["the joiner inside the bold", "<p><b>👩\u{200D}</b>👩</p>", "👩\u{200D}👩"],
        ["an emoji with its selector", '<p><span style="font-weight:bold">❤\u{FE0F}</span>\u{200D}🔥</p>', "❤\u{FE0F}\u{200D}🔥"],
    ])("keeps the joiner beside its emoji: %s", (_: string, html: string, markdown: string) => {
        expect(htmlToMarkdown(html)).toBe(markdown);
    });

    it("still marks a whole emoji or an emoji beside words", () => {
        expect(htmlToMarkdown("<p><b>👩\u{200D}👩</b> and <b>🎉</b> <i>yay</i></p>")).toBe("**👩\u{200D}👩** and **🎉** *yay*");
    });
});

describe("an anchor without its own href", () => {
    it("does not count as a link, so a code editor's copy keeps its plain text", () => {
        expect(isPlainHtml('<pre style="font-family:monospace"><a data-href="x" title="see href=y">fn</a>()</pre>')).toBe(true);
        expect(isPlainHtml('<p><a class="x" href="https://example.com/">docs</a></p>')).toBe(false);
    });
});

describe("lists numbered with letters or roman numerals", () => {
    it("keep their markers as text, since Markdown numbers only in digits", () => {
        expect(htmlToMarkdown('<ol type="A"><li>one</li><li>two</li></ol>')).toBe("- A. one\n- B. two");
        expect(htmlToMarkdown('<ol type="i" start="3"><li>three</li><li>four</li></ol>')).toBe("- iii. three\n- iv. four");
        expect(htmlToMarkdown('<ol type="1"><li>one</li></ol>')).toBe("1. one");
    });
});

describe("a URL pasted over a selection with spaces around it", () => {
    it("links the word and keeps the spaces outside the link", () => {
        expect(planPaste(clipboard({ "text/plain": "https://example.com/" }), { plainOnly: false, selectedText: "docs " })).toStrictEqual({
            kind: "text",
            markdown: true,
            text: "[docs](https://example.com/) ",
        });
    });
});

describe("text hidden from assistive technology in any case", () => {
    it("stays out of the paste", () => {
        expect(htmlToMarkdown('<p>shown<span aria-hidden="TRUE"> secret</span></p>')).toBe("shown");
    });
});

describe("emphasis styled on a block element", () => {
    it("marks the text of a paragraph, list item or table cell, not a heading's", () => {
        expect(
            htmlToMarkdown(
                [
                    '<p style="font-weight:bold">Important</p>',
                    '<ul><li style="font-style:italic">item</li></ul>',
                    '<table><tr><th>A</th></tr><tr><td style="text-decoration:line-through">old</td></tr></table>',
                    '<h2 style="font-weight:bold">Title</h2>',
                ].join(""),
            ),
        ).toBe("**Important**\n\n- *item*\n\n| A |\n| --- |\n| ~~old~~ |\n\n## Title");
    });
});

describe("a language class only in text or another attribute's value", () => {
    it("does not stop a monospace copy from pasting as its plain text", () => {
        expect(isPlainHtml('<pre title="class = language-js">let x=1;</pre>')).toBe(true);
        expect(isPlainHtml('<pre style="font-family:monospace">&lt;code class="language-js"&gt;</pre>')).toBe(true);
        expect(isPlainHtml('<pre data-x="1" CLASS="hljs language-js">x()</pre>')).toBe(false);
    });
});

describe("an HTML-only plain monospace copy", () => {
    it("goes in as its visible text, without a fence", async () => {
        await expect(paste({ "text/html": "<pre>let x = 1;\nlet y = 2;</pre>" })).resolves.toBe("let x = 1;\nlet y = 2;");
    });
});

describe("visible text of a closed details", () => {
    it("is its summary alone, as in the Markdown", async () => {
        await expect(
            paste(
                { "text/html": "<details><summary>Logs</summary><p>hidden line</p></details><details open><summary>Shown</summary><p>body</p></details>" },
                { plainOnly: true },
            ),
        ).resolves.toBe("Logs\nShown\nbody");
    });
});

describe("a URL ending in a backslash pasted over a selection", () => {
    it("still forms a link: the backslash is encoded", () => {
        expect(planPaste(clipboard({ "text/plain": "https://example.com/path\\" }), { plainOnly: false, selectedText: "text" })).toStrictEqual({
            kind: "text",
            markdown: true,
            text: "[text](https://example.com/path%5C)",
        });
    });
});

describe("a style declared twice", () => {
    it("reads as CSS does: the last declaration wins, unless an earlier one is important", () => {
        expect(htmlToMarkdown('<p><span style="font-weight:bold; font-weight:normal">text</span></p>')).toBe("text");
        expect(htmlToMarkdown('<p><span style="font-weight:bold !important; font-weight:normal">text</span></p>')).toBe("**text**");
        expect(htmlToMarkdown('<p><span style="font-style:italic; font-style:normal">text</span></p>')).toBe("text");
    });
});

describe("negative list numbers", () => {
    it("keep their numbers as text, since Markdown numbers only from 0", () => {
        expect(htmlToMarkdown('<ol start="-2"><li>alpha</li><li>beta</li><li>gamma</li></ol>')).toBe("- -2. alpha\n- -1. beta\n0. gamma");
    });
});

describe("a raised, lowered or monospace run with no other formatting", () => {
    it("goes through the converter, so its meaning survives", () => {
        expect(isPlainHtml("<p>E=mc<sup>2</sup></p>")).toBe(false);
        expect(isPlainHtml("<p>H<sub>2</sub>O</p>")).toBe(false);
        expect(isPlainHtml("<p>run <samp>ok</samp> and <tt>ls</tt></p>")).toBe(false);
        expect(isPlainHtml("<p>simple text</p>")).toBe(true);
        expect(htmlToMarkdown("<p>E=mc<sup>2</sup></p>")).toBe("E=mc²");
        expect(htmlToMarkdown("<p>12<sup>th</sup> May</p>")).toBe("12th May");
    });
});

describe("display or visibility declared twice", () => {
    it("hides only what the last declaration hides", () => {
        expect(htmlToMarkdown('<p style="display:none; display:block">Visible</p><p><b>bold</b></p>')).toBe("Visible\n\n**bold**");
        expect(htmlToMarkdown('<p style="visibility:hidden; visibility:visible">Visible</p>')).toBe("Visible");
        expect(htmlToMarkdown('<p style="display:block; display:none">secret</p><p>shown</p>')).toBe("shown");
        expect(htmlToMarkdown('<p style="display:none !important; display:block">secret</p><p>shown</p>')).toBe("shown");
    });
});

describe("a code block inside a heading", () => {
    it("keeps the heading's text, puts the block below it and the text after the block below that", () => {
        expect(htmlToMarkdown("<h2>Setup<pre>npm i</pre></h2>")).toBe("## Setup\n\n```\nnpm i\n```");
        expect(htmlToMarkdown("<h2>A<pre>x</pre>B</h2>")).toBe("## A\n\n```\nx\n```\n\nB");
        expect(htmlToMarkdown("<h3><pre>only code</pre></h3>")).toBe("```\nonly code\n```");
        expect(htmlToMarkdown("<h2>Use <code>npm</code></h2>")).toBe("## Use `npm`");
    });
});

describe("a line indented four spaces before backticks", () => {
    it("is indented code, not a fence, so the caret after it is not in one", () => {
        expect(inOpenFence("    ```\ncode")).toBe(false);
        expect(inOpenFence("   ```\ncode")).toBe(true);
        expect(inOpenFence("> ```md\ncode")).toBe(true);
    });
});

describe("block content in a pasted table cell", () => {
    it("goes on the cell's line without block markers", () => {
        expect(
            htmlToMarkdown(
                "<table><tr><th>A</th></tr><tr><td><ul><li>a</li><li>b</li></ul></td></tr><tr><td><h2>Title</h2></td></tr><tr><td><blockquote>q</blockquote></td></tr></table>",
            ),
        ).toBe("| A |\n| --- |\n| a; b |\n| **Title** |\n| q |");
    });
});

describe("an HTML-only copy with control characters, pasted plain", () => {
    it("leaves them out, as they show nothing", async () => {
        await expect(paste({ "text/html": "<p>a\u{1}b\u{2}c\u{3}d\u{10}e</p>" }, { plainOnly: true, selectedText: "" })).resolves.toBe("abcde");
    });
});

describe("an HTML-only copy with an emoji picture, pasted plain", () => {
    it("keeps the emoji from its alt text", async () => {
        await expect(paste({ "text/html": '<p>Done <img alt="🎉" src="x.png"></p>' }, { plainOnly: true, selectedText: "" })).resolves.toBe("Done 🎉");
    });
});

describe("non-breaking spaces at the edge of a block", () => {
    it("stay outside the formatting marks; one that ends the paste is trimmed with it", () => {
        expect(htmlToMarkdown("<p><strong>&nbsp;Warning&nbsp;</strong></p>")).toBe("\u{A0}**Warning**");
    });
});
