/**
 * "Page changed": a URL, and optionally a selector (watch one element) and a text-contains check.
 *
 * Without `contains` it fires when the extracted text changes. With it, it fires when the text starts
 * containing the phrase (a change from absent to present), so a page that always had it stays quiet.
 * The first check only records a baseline.
 */
import { sha256Hex } from "../../lib/crypto";
import { pageComparableText, parsePageSelector } from "./page-extract";
import type { EventSource } from "./types";

/** The excerpt handed to the run as data. */
export const PAGE_EXCERPT_CHARS = 2000;

export const pageSource: EventSource<{ contains?: string; kind: "page"; selector?: string; url: string }> = {
    check: async (ctx, config, state) => {
        const { text: html } = await ctx.fetchPage(config.url);
        const selector = config.selector ? parsePageSelector(config.selector) : undefined;

        if (config.selector && !selector) {
            throw new Error("The selector is not one this watcher understands. Use a tag, #id, .class, tag.class or tag#id.");
        }

        const text = pageComparableText(html, selector);

        if (text === undefined) {
            throw new Error(`Nothing on the page matches "${config.selector}".`);
        }

        const hash = await sha256Hex(text);
        const matched = config.contains === undefined ? undefined : text.toLowerCase().includes(config.contains.toLowerCase());
        const next = { ...state, hash, matched };

        // No baseline yet: remember how the page looks now and say nothing.
        if (state.hash === undefined) {
            return { fired: false, state: next };
        }

        const fired = config.contains === undefined ? hash !== state.hash : matched === true && state.matched !== true;

        if (!fired) {
            return { fired: false, state: next };
        }

        return {
            excerpt: text.slice(0, PAGE_EXCERPT_CHARS),
            fired: true,
            fireKey: `page:${hash}`,
            state: next,
            summary: config.contains === undefined ? `The page changed: ${config.url}` : `The page now contains "${config.contains}": ${config.url}`,
        };
    },
};
