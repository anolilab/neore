/* eslint-disable e18e/prefer-static-regex -- `extractPageContent` is serialised into the page (see below): a module-scope regex would be undefined there */

/** What the injected extractor hands back from the page. Plain data only — it crosses a structured-clone boundary. */
export interface RawPageContent {
    selection: string;
    text: string;
    title: string;
    url: string;
}

/**
 * Readability-style extraction of the page the user is looking at.
 *
 * This function is passed to `chrome.scripting.executeScript({ func })`, which
 * serialises it with `Function.prototype.toString()` and runs it in the page.
 * So it MUST be self-contained: no imports, no module-level helpers, no
 * closures — everything it uses is declared inside it. The unit tests call it
 * directly against a jsdom document, which is the same contract.
 *
 * It reads text only (`textContent`, never `innerHTML`, never form values), and
 * removes navigation, forms, scripts and hidden elements before reading. The
 * `maxChars` cap is a transfer ceiling; the real token budget is applied later
 * by `buildPageContext`.
 */
export function extractPageContent(maxChars: number): RawPageContent {
    const NOISE_SELECTOR = [
        "script",
        "style",
        "noscript",
        "template",
        "svg",
        "canvas",
        "iframe",
        "object",
        "embed",
        "video",
        "audio",
        "form",
        "button",
        "input",
        "select",
        "textarea",
        "nav",
        "footer",
        "aside",
        "dialog",
        "[hidden]",
        '[aria-hidden="true"]',
        '[role="navigation"]',
        '[role="banner"]',
        '[role="contentinfo"]',
        '[role="complementary"]',
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[role="search"]',
    ].join(",");
    const NOISE_WORDS = [
        "ad",
        "ads",
        "advert",
        "banner",
        "breadcrumbs?",
        "comments?",
        "consent",
        "cookie",
        "footer",
        "menu",
        "modal",
        "newsletter",
        "popup",
        "promo",
        "related",
        "share",
        "sharing",
        "sidebar",
        "social",
        "sponsor",
        "subscribe",
    ];
    const NOISE_NAME = new RegExp(String.raw`(?:^|[\s_-])(?:${NOISE_WORDS.join("|")})(?:$|[\s_-])`, "i");
    const BLOCK_TAGS = new Set([
        "ADDRESS",
        "ARTICLE",
        "BLOCKQUOTE",
        "DD",
        "DETAILS",
        "DIV",
        "DL",
        "DT",
        "FIGCAPTION",
        "FIGURE",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "HEADER",
        "HR",
        "LI",
        "MAIN",
        "OL",
        "P",
        "PRE",
        "SECTION",
        "SUMMARY",
        "TABLE",
        "TR",
        "UL",
    ]);

    const textLength = (element: Element): number => (element.textContent ?? "").replaceAll(/\s+/g, " ").trim().length;

    // ── 1. Pick the content root ────────────────────────────────────────────
    // Semantic containers first; otherwise score each paragraph's parent (and,
    // at half weight, grandparent) by the text it holds, and take the best.
    const pickRoot = (): Element => {
        const body = document.body ?? document.documentElement;
        const semantic = [...document.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]')]
            .map((element) => {
                return { element, length: textLength(element) };
            })
            .filter((candidate) => candidate.length >= 200)
            .toSorted((a, b) => b.length - a.length)[0];

        if (semantic) {
            return semantic.element;
        }

        const scores = new Map<Element, number>();

        for (const paragraph of document.querySelectorAll("p, pre, blockquote, li")) {
            const length = textLength(paragraph);

            if (length < 25) {
                continue;
            }

            const parent = paragraph.parentElement;
            const grandparent = parent?.parentElement;

            if (parent) {
                scores.set(parent, (scores.get(parent) ?? 0) + length);
            }

            if (grandparent) {
                scores.set(grandparent, (scores.get(grandparent) ?? 0) + length / 2);
            }
        }

        let best: Element | undefined;
        let bestScore = 0;

        for (const [element, score] of scores) {
            if (score <= bestScore) {
                continue;
            }

            best = element;
            bestScore = score;
        }

        return best && bestScore >= 200 ? best : body;
    };

    // ── 2. Strip noise from a copy (never mutate the live page) ─────────────
    const root = pickRoot().cloneNode(true) as Element;
    const rootLength = Math.max(1, textLength(root));

    for (const element of root.querySelectorAll(NOISE_SELECTOR)) {
        element.remove();
    }

    // `querySelectorAll` returns a static list, so removing elements while
    // iterating it is safe.
    for (const element of root.querySelectorAll("[class], [id], [style]")) {
        // Already gone with a removed ancestor.
        if (element !== root && !root.contains(element)) {
            continue;
        }

        const style = element.getAttribute("style") ?? "";

        if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) {
            element.remove();
            continue;
        }

        const name = `${element.getAttribute("class") ?? ""} ${element.getAttribute("id") ?? ""}`;

        // Only boilerplate-sized blocks: a wrapper that happens to be called
        // "content-sidebar-layout" but holds most of the article stays.
        if (NOISE_NAME.test(name) && textLength(element) < rootLength * 0.3) {
            element.remove();
        }
    }

    // ── 3. Serialise to text, keeping block structure ───────────────────────
    const lines: string[] = [];
    let current = "";

    const flush = () => {
        const line = current.replaceAll(/\s+/g, " ").trim();

        if (line) {
            lines.push(line);
        }

        current = "";
    };

    const walk = (node: Node): void => {
        if (node.nodeType === 3) {
            current += node.textContent ?? "";

            return;
        }

        if (node.nodeType !== 1) {
            return;
        }

        const element = node as Element;
        const tag = element.tagName;

        if (tag === "BR") {
            flush();

            return;
        }

        if (tag === "PRE") {
            flush();

            const code = (element.textContent ?? "").trimEnd();

            if (code.trim()) {
                lines.push(code);
            }

            return;
        }

        const isBlock = BLOCK_TAGS.has(tag);

        if (isBlock) {
            flush();
        }

        if (/^H[1-6]$/.test(tag)) {
            current += `${"#".repeat(Number(tag[1]))} `;
        } else if (tag === "LI") {
            current += "- ";
        }

        for (const child of element.childNodes) {
            walk(child);
        }

        if (isBlock) {
            flush();
        } else if (tag === "TD" || tag === "TH") {
            current += " ";
        }
    };

    walk(root);
    flush();

    const text = lines.join("\n\n").slice(0, maxChars);
    const selection = (globalThis.getSelection?.()?.toString() ?? "").trim().slice(0, maxChars);

    return {
        selection,
        text,
        title: (document.title || document.querySelector("h1")?.textContent || "").trim(),
        url: document.location?.href ?? "",
    };
}
