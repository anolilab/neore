import { describe, expect, it } from "vitest";

import githubTable from "./__fixtures__/github-readme-table.html?raw";
import googleDocs from "./__fixtures__/google-docs-list.html?raw";
import hostileHtml from "./__fixtures__/hostile.html?raw";
import terminalHtml from "./__fixtures__/terminal.html?raw";
import vscodeHtml from "./__fixtures__/vscode.html?raw";
import wordHtml from "./__fixtures__/word-paragraph.html?raw";
import { htmlToMarkdown } from "./html-to-markdown";
import { isLongPaste, isPlainHtml, planPaste, planText } from "./paste-plan";

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
    });

    it("pastes text/plain exactly on Ctrl/Cmd+Shift+V", async () => {
        await expect(paste({ "text/html": googleDocs, "text/plain": "Ship the beta" }, { plainOnly: true, selectedText: "x" })).resolves.toBe("Ship the beta");
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
        [
            "a JetBrains copy with bold keywords",
            '<pre style="font-family:\'JetBrains Mono\',monospace"><span style="font-weight:bold">fun</span> x()</pre>',
            true,
        ],
    ])("treats %s as plain: %s", (_label: string, html: string, plain: boolean) => {
        expect(isPlainHtml(html)).toBe(plain);
    });

    it("keeps backticks inside code from closing the fence", () => {
        expect(htmlToMarkdown('<p>Run <code>a`b</code></p><pre class="language-md">```js\nx\n```</pre>')).toBe("Run ``a`b``\n\n````md\n```js\nx\n```\n````");
    });
});
