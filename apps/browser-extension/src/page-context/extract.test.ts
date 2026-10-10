import { afterEach, describe, expect, it } from "vitest";

import { extractPageContent } from "./extract";

const setPage = (html: string, title = "Test page") => {
    document.title = title;
    document.body.innerHTML = html;
};

const paragraph = (words: number, word = "lorem") => `<p>${`${word} `.repeat(words).trimEnd()}.</p>`;

afterEach(() => {
    document.body.replaceChildren();
    document.getSelection()?.removeAllRanges();
});

describe("extractPageContent", () => {
    it("prefers the article over navigation, sidebars and footers", () => {
        setPage(`
      <nav>Home About Contact</nav>
      <header role="banner">Site banner</header>
      <aside>Sidebar promo</aside>
      <article>
        <h1>The headline</h1>
        ${paragraph(60, "alpha")}
        ${paragraph(60, "beta")}
      </article>
      <footer>Copyright footer</footer>
    `);

        const result = extractPageContent(100_000);

        expect(result.text).toContain("# The headline");
        expect(result.text).toContain("alpha alpha");
        expect(result.text).toContain("beta beta");
        expect(result.text).not.toContain("Home About");
        expect(result.text).not.toContain("Sidebar promo");
        expect(result.text).not.toContain("Copyright footer");
        expect(result.title).toBe("Test page");
    });

    it("finds the densest block when the page has no semantic container", () => {
        setPage(`
      <div class="menu"><a href="/">Link one</a> <a href="/">Link two</a></div>
      <div class="story">${paragraph(50, "gamma")}${paragraph(50, "delta")}</div>
      <div class="teaser">${paragraph(3, "short")}</div>
    `);

        const result = extractPageContent(100_000);

        expect(result.text).toContain("gamma");
        expect(result.text).toContain("delta");
        expect(result.text).not.toContain("Link one");
    });

    it("never reads scripts, styles, form values or hidden elements", () => {
        setPage(`
      <article>
        ${paragraph(60, "visible")}
        <script>window.secret = "script-body"</script>
        <style>.x { color: red }</style>
        <form><input type="password" value="hunter2"><textarea>draft-text</textarea></form>
        <div hidden>hidden-attr</div>
        <div aria-hidden="true">aria-hidden-text</div>
        <div style="display: none">display-none-text</div>
        <div class="cookie-consent">Accept cookies</div>
      </article>
    `);

        const { text } = extractPageContent(100_000);

        for (const leaked of ["script-body", "color: red", "hunter2", "draft-text", "hidden-attr", "aria-hidden-text", "display-none-text", "Accept cookies"]) {
            expect(text).not.toContain(leaked);
        }

        expect(text).toContain("visible");
    });

    it("drops boilerplate blocks by class or id as whole words only", () => {
        setPage(`
      <article>
        ${paragraph(60, "story")}
        <div class="related-posts">related-block</div>
        <div id="breadcrumbs">breadcrumb-block</div>
        <div class="Share_Buttons">share-block</div>
        <div class="adventure">adventure-block</div>
        <div class="shadow">shadow-block</div>
      </article>
    `);

        const { text } = extractPageContent(100_000);

        for (const dropped of ["related-block", "breadcrumb-block", "share-block"]) {
            expect(text).not.toContain(dropped);
        }

        // `ad` and `ads` are words, not prefixes: neither "adventure" nor "shadow" matches.
        expect(text).toContain("adventure-block");
        expect(text).toContain("shadow-block");
    });

    it("keeps a noise-named wrapper that holds most of the article", () => {
        setPage(`<main><div class="content-sidebar-layout">${paragraph(60, "kept")}</div>${paragraph(10, "aside")}</main>`);

        expect(extractPageContent(100_000).text).toContain("kept kept");
    });

    it("keeps block structure: headings, list items and preformatted code", () => {
        setPage(`
      <main>
        <h2>Setup</h2>
        ${paragraph(40, "intro")}
        <ul><li>first item</li><li>second item</li></ul>
        <pre>const x = 1;\n  indented();\n   \n</pre>
      </main>
    `);

        const { text } = extractPageContent(100_000);

        expect(text).toContain("## Setup");
        expect(text).toContain("- first item\n\n- second item");
        expect(text).toContain("const x = 1;\n  indented();");
        // Trailing whitespace of a code block is trimmed; its indentation is not.
        expect(text).not.toContain("indented();\n   ");
    });

    it("does not modify the live page", () => {
        setPage(`<article>${paragraph(60)}<nav>keep me</nav><script>1</script></article>`);
        const before = document.body.cloneNode(true);

        extractPageContent(100_000);

        expect(document.body.isEqualNode(before)).toBe(true);
    });

    it("returns the current selection", () => {
        setPage(`<article>${paragraph(60)}<p id="pick">picked words here</p></article>`);

        const range = document.createRange();

        range.selectNodeContents(document.querySelector("#pick")!);
        document.getSelection()!.addRange(range);

        expect(extractPageContent(100_000).selection).toBe("picked words here");
    });

    it("caps the transfer size", () => {
        setPage(`<article>${paragraph(2000)}</article>`);

        expect(extractPageContent(500).text).toHaveLength(500);
    });

    it("is self-contained, so it survives serialisation into the page", () => {
        // `chrome.scripting.executeScript({ func })` re-creates the function from
        // its source text: anything it closed over would be undefined in the page.
        // eslint-disable-next-line sonarjs/code-eval -- re-creating the function from its source IS the contract under test
        const revived = new Function(`return (${extractPageContent.toString()})`)() as typeof extractPageContent;

        setPage(`<article>${paragraph(60, "serialised")}</article>`);

        expect(revived(100_000).text).toContain("serialised");
    });
});
