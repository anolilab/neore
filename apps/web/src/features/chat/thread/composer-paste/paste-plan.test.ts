import { describe, expect, it, vi } from "vitest";

import { appendPastedText, insertPastedText } from "../composer-draft-file";
import githubTable from "./__fixtures__/github-readme-table.html?raw";
import googleDocs from "./__fixtures__/google-docs-list.html?raw";
import googleDocsNumbered from "./__fixtures__/google-docs-numbered.html?raw";
import hostileHtml from "./__fixtures__/hostile.html?raw";
import terminalHtml from "./__fixtures__/terminal.html?raw";
import vscodeHtml from "./__fixtures__/vscode.html?raw";
import wordHtml from "./__fixtures__/word-paragraph.html?raw";
import { htmlToMarkdown } from "./html-to-markdown";
import { breaksBefore, inOpenFence, isLongPaste, isPlainHtml, longestBacktickRun, onOwnLines, planPaste, planText } from "./paste-plan";

const clipboard = (data: Record<string, string>): Pick<DataTransfer, "getData"> => {
    return { getData: (type: string) => data[type] ?? "" };
};

const paste = async (
    data: Record<string, string>,
    options: { inFence?: boolean; plainOnly?: boolean; selectedText?: string } = {},
): Promise<string | undefined> => {
    const plan = planPaste(clipboard(data), { inFence: options.inFence, plainOnly: options.plainOnly ?? false, selectedText: options.selectedText ?? "" });

    return plan.kind === "default" ? undefined : planText(plan);
};

describe("composer paste", () => {
    it("turns a Google Docs list with bold, italics and a link into Markdown", async () => {
        await expect(paste({ "text/html": googleDocs, "text/plain": "Release plan\nShip the beta on Monday\nRead the release notes\ntwice" })).resolves.toBe(
            ["Release plan", "", "- **Ship** the beta on Monday", "- Read the [release notes](https://example.com/notes)", "    - *twice*"].join("\n"),
        );
    });

    it("numbers each depth of a flat Google Docs numbered list on its own and indents every line of a nested item", () => {
        expect(htmlToMarkdown(googleDocsNumbered)).toBe(["1. Install", "    1. Download", "       the installer", "    2. Run it", "2. Sign in"].join("\n"));
    });

    it("starts a list copied from a nested Google Docs item at the left edge, keeping its nesting", () => {
        expect(htmlToMarkdown('<ul><li aria-level="2">a</li><li aria-level="3">b</li><li aria-level="2">c</li></ul>')).toBe(
            ["- a", "    - b", "- c"].join("\n"),
        );
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

        expect(htmlToMarkdown(item(2, "a") + item(3, "b") + item(2, "c"))).toBe(["- a", "    - b", "- c"].join("\n"));
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
            ["1. First", "    - a. Sub", "        - i. Deep"].join("\n"),
        );
        expect(htmlToMarkdown(item(1, "a)", "one") + item(1, "b)", "two"))).toBe("- a) one\n- b) two");
    });

    it("counts a reversed list down, from its start or its number of items", () => {
        expect(htmlToMarkdown("<ol reversed><li>b</li><li>a</li></ol>")).toBe("2. b\n1. a");
        expect(htmlToMarkdown('<ol reversed start="10"><li>j</li><li value="4">d</li><li>c</li></ol>')).toBe("10. j\n4. d\n3. c");
        expect(htmlToMarkdown('<ol reversed start="1"><li>a</li><li>z</li></ol>')).toBe("1. a\n0. z");
    });

    it("marks formatted text broken by a line break on each of its lines", () => {
        expect(htmlToMarkdown("<p><b>one<br>two</b> <i>three<br></i><s> four<br>five</s></p>")).toBe("**one**\n**two** *three*\n~~four~~\n~~five~~");
    });

    it("converts a code block of many line elements in linear time", () => {
        // 30,000 lines: about 0.8 s here, against about 4 s when each line re-read the text built so far.
        const html = `<pre>${"<div>let a = 1;</div>".repeat(30_000)}</pre>`;
        const started = performance.now();
        const markdown = htmlToMarkdown(html);

        expect(markdown.split("\n").filter((line) => line === "let a = 1;")).toHaveLength(30_000);
        expect(performance.now() - started).toBeLessThan(3000);
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
        // An HTML-only clipboard is not handed to the editor's rich paste.
        expect(planPaste(clipboard({ "text/html": googleDocs }), { plainOnly: true, selectedText: "" })).toStrictEqual({ kind: "text", text: "" });
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

        for (const html of ["class=".repeat(500_000), "<b ".repeat(1_000_000), "<a ".repeat(1_000_000), "text-decoration".repeat(200_000)]) {
            const started = performance.now();

            planPaste(clipboard({ "text/html": html, "text/plain": "plain" }), plain);
            // Under the cap the formatting checks run on all of it.
            isPlainHtml(html.slice(0, 1_000_000));
            expect(performance.now() - started).toBeLessThan(500);
        }
    });

    it("converts a crafted style attribute under the cap in linear time", () => {
        for (const style of ["text-decoration:".repeat(50_000), "mso-list:".repeat(80_000)]) {
            const started = performance.now();

            htmlToMarkdown(`<p><span style="${style}">x</span></p>`);
            expect(performance.now() - started).toBeLessThan(1000);
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

    it("keeps a link whose label is broken by a line break", () => {
        expect(htmlToMarkdown('<p><a href="https://example.com/">first<br>second</a></p>')).toBe("[first\nsecond](https://example.com/)");
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
            "1. one\n   two\n    - three\n      four",
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
            ["| A | B |", "| --- | --- |", String.raw`| a\\\|b | c |`, "", String.raw`[C:\dir\\](https://x.y/) [a\\\]b](https://x.y/)`].join("\n"),
        ],
        [
            "code in a table cell keeps its backslashes, escapes its pipes for the row, and a backslash before it never escapes its backtick",
            String.raw`<table><tr><th>A</th></tr><tr><td><code>C:\tmp</code> or <code>a|b</code> in C:\<code>x</code></td></tr></table>`,
            "| A |\n| --- |\n| `C:\\tmp` or `a\\|b` in C:\\\\`x` |",
        ],
        [
            "code in a link label is kept as written, and a backslash before it never escapes its backtick",
            '<p><a href="https://x.y/"><code>arr[0]</code> and a[1]</a> <a href="https://x.y/">C:\\<code>x\\y</code></a> <a href="https://x.y/">a`b[</a></p>',
            "[`arr[0]` and a\\[1\\]](https://x.y/) [C:\\\\`x\\y`](https://x.y/) [a`b\\[](https://x.y/)",
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
    it("still counts as formatting, so the link is kept", async () => {
        await expect(paste({ "text/html": '<a title="2 > 1" href="https://example.com/">docs</a>', "text/plain": "docs" })).resolves.toBe(
            "[docs](https://example.com/)",
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
        const started = performance.now();

        expect(htmlToMarkdown(html).length).toBeGreaterThan(200_000);
        expect(performance.now() - started).toBeLessThan(2000);
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
    it("goes in as its visible text, with no Markdown added", () => {
        const plan = planPaste(
            { getData: (type: string) => (type === "text/html" ? "<p><b>const</b> a = 1;</p><p>b()</p>" : "") },
            { inFence: true, plainOnly: false, selectedText: "" },
        );

        expect(plan).toStrictEqual({ kind: "text", text: "const a = 1;\nb()" });
    });
});
