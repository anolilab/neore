import { describe, expect, it } from "vitest";

import { insertPastedText } from "../composer-draft-file";
import githubTable from "./__fixtures__/github-readme-table.html?raw";
import googleDocs from "./__fixtures__/google-docs-list.html?raw";
import googleDocsNumbered from "./__fixtures__/google-docs-numbered.html?raw";
import hostileHtml from "./__fixtures__/hostile.html?raw";
import terminalHtml from "./__fixtures__/terminal.html?raw";
import vscodeHtml from "./__fixtures__/vscode.html?raw";
import wordHtml from "./__fixtures__/word-paragraph.html?raw";
import { htmlToMarkdown } from "./html-to-markdown";
import { inOpenFence, isLongPaste, isPlainHtml, longestBacktickRun, onOwnLines, planPaste, planText } from "./paste-plan";

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
        await expect(paste({ "text/html": quotes, "text/plain": "plain" })).resolves.toBe("plain");
        await expect(paste({ "text/html": `${"<ul><li>".repeat(600)}deep` })).resolves.toBe("deep");
        expect(htmlToMarkdown(`${"<blockquote>".repeat(3)}a`)).toBe("> > > a");
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
        ["a table keeps its caption", "<table><caption>Prices</caption><tr><th>A</th></tr><tr><td>1</td></tr></table>", "Prices\n\n| A |\n| --- |\n| 1 |"],
        [
            "a numbered list keeps a zero start and an item's own number",
            '<ol start="0"><li>zero</li><li>one</li></ol><ol><li>a</li><li value="5">five</li><li>six</li></ol>',
            "0. zero\n1. one\n\n1. a\n5. five\n6. six",
        ],
        [
            "emoji and formulas drawn as images keep their text",
            '<p>Ship <img alt="🎉"> <img alt=":tada:"> <img class="mwe-math-fallback-image-inline" alt="E=mc^2"> <img alt="A chart"></p>',
            "Ship 🎉 :tada: $E=mc^2$",
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

    it("puts a code block pasted mid-line on lines of its own", async () => {
        await expect(pasteInto("before after", 7, { "text/html": '<pre class="language-js">x()</pre>', "text/plain": "x()" })).resolves.toBe(
            "before \n\n```js\nx()\n```\n\nafter",
        );
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

    it("inserts code as copied, without a fence of its own or Markdown", async () => {
        const code = "const a = 1;\nconst b = 2;";
        const vscode = { "text/html": "<div>x</div>", "text/plain": code, "vscode-editor-data": '{"mode":"typescript"}' };

        await expect(paste(vscode, { inFence: true })).resolves.toBe(code);
        await expect(paste({ "text/html": '<pre class="language-js">x()</pre>', "text/plain": "x()" }, { inFence: true })).resolves.toBe("x()");
        await expect(paste(vscode)).resolves.toBe(`\`\`\`typescript\n${code}\n\`\`\``);
    });
});
