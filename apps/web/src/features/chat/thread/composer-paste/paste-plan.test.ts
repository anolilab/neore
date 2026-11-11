import { describe, expect, it } from "vitest";

import githubTable from "./__fixtures__/github-readme-table.html?raw";
import googleDocs from "./__fixtures__/google-docs-list.html?raw";
import googleDocsNumbered from "./__fixtures__/google-docs-numbered.html?raw";
import hostileHtml from "./__fixtures__/hostile.html?raw";
import terminalHtml from "./__fixtures__/terminal.html?raw";
import vscodeHtml from "./__fixtures__/vscode.html?raw";
import wordHtml from "./__fixtures__/word-paragraph.html?raw";
import { htmlToMarkdown } from "./html-to-markdown";
import { isLongPaste, isPlainHtml, longestBacktickRun, planPaste, planText } from "./paste-plan";

const clipboard = (data: Record<string, string>): Pick<DataTransfer, "getData"> => {
    return { getData: (type: string) => data[type] ?? "" };
};

const paste = async (data: Record<string, string>, options: { plainOnly?: boolean; selectedText?: string } = {}): Promise<string | undefined> => {
    const plan = planPaste(clipboard(data), { plainOnly: options.plainOnly ?? false, selectedText: options.selectedText ?? "" });

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

    it("converts HTML too big to convert when it is the only text, and leaves a composer quote chip to the editor", async () => {
        await expect(paste({ "text/html": `<p>Hello</p><!--${"x".repeat(1_000_000)}-->` })).resolves.toBe("Hello");
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
            "hidden table rows and cells are left out",
            '<table><tr><th>A</th><th style="display:none">S</th><th>B</th></tr><tr style="display:none"><td>secret</td></tr><tbody hidden><tr><td>secret</td></tr></tbody><tr><td>a</td><td aria-hidden="true">secret</td><td>b</td></tr></table>',
            "| A | B |\n| --- | --- |\n| a | b |",
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
