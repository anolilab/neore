import type { PageContext } from "./build";
import { buildPageContext, EXTRACTION_TRANSFER_CAP, PageContextError } from "./build";
import { extractPageContent } from "./extract";

/**
 * Hosts Chrome never lets an extension script, even with `activeTab`. Checked
 * up front so the user gets a sentence instead of a scripting error.
 */
const RESTRICTED_HOSTS = new Set(["addons.mozilla.org", "chrome.google.com", "chromewebstore.google.com", "microsoftedge.microsoft.com"]);

/**
 * Only ordinary web pages. `chrome://`, `edge://`, `about:`, `file:`, `view-source:`,
 * `data:` and other extensions' pages (`chrome-extension://`, `moz-extension://`)
 * are never read — they are browser internals or someone else's UI, not
 * content the user is reading.
 */
export const isCapturableUrl = (value: string | undefined): value is string => {
    if (!value) {
        return false;
    }

    try {
        const url = new URL(value);

        return (url.protocol === "https:" || url.protocol === "http:") && !RESTRICTED_HOSTS.has(url.hostname);
    } catch {
        return false;
    }
};

const NO_ACCESS_MESSAGE = 'Anole can only read a page after you invoke it there: right-click the page and choose "Chat with this page", or press the shortcut.';

/**
 * Extract the readable content of `tab` and budget it into a `PageContext`.
 *
 * Needs `activeTab` to have been granted for this tab (toolbar click, context
 * menu, keyboard command). A click inside the side panel does NOT grant it, so
 * from the panel this fails on any tab the user has not invoked the extension
 * on — which surfaces as `NO_ACCESS_MESSAGE`, not as a raw scripting error.
 */
export const capturePage = async (tab: chrome.tabs.Tab): Promise<PageContext> => {
    // Without a grant, `tab.url` is not even visible to us.
    if (tab.id === undefined || !tab.url) {
        throw new PageContextError(NO_ACCESS_MESSAGE);
    }

    if (!isCapturableUrl(tab.url)) {
        throw new PageContextError("This page cannot be shared: browser pages, extension pages and local files are never read.");
    }

    let results: chrome.scripting.InjectionResult<Awaited<ReturnType<typeof extractPageContent>>>[];

    try {
        results = await chrome.scripting.executeScript({
            args: [EXTRACTION_TRANSFER_CAP],
            func: extractPageContent,
            target: { tabId: tab.id },
        });
    } catch {
        throw new PageContextError(NO_ACCESS_MESSAGE);
    }

    const raw = results[0]?.result;

    if (!raw) {
        throw new PageContextError("The page did not return any content.");
    }

    // Trust the tab's URL over the page's own `location`, which a page controls.
    return buildPageContext({ ...raw, url: tab.url });
};

/**
 * A selection from the context menu. `info.selectionText` comes from the
 * browser, so no script runs in the page at all.
 */
export const selectionContext = (selectionText: string, tab: chrome.tabs.Tab | undefined): PageContext => {
    if (!isCapturableUrl(tab?.url)) {
        throw new PageContextError("Selections can only be shared from ordinary web pages.");
    }

    return buildPageContext({ selection: selectionText, title: tab.title ?? "", url: tab.url }, { includeText: false });
};
