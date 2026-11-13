// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import type { PluggableList } from "unified";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamdownRehypePlugins } from "../hooks/use-streamdown-plugins";
import { clearMarkdownBlockCache, MarkdownBlockCacheContext } from "../utils/markdown-block-cache";
import CachedMarkdownBlock from "./cached-markdown-block";

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const REPLY = [
    "# Title",
    "Some **bold** text with a [link](https://example.com) and `code`.",
    "- one\n- two\n- three",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "> a quote",
    "Inline <b>html</b> here.",
    "Final paragraph.",
].join("\n\n");

const BLOCKS = 7;

/** Counts markdown parses: its transformer runs once for every block Streamdown or the cache parses. */
const parses = { count: 0 };
const countParses = () => () => {
    parses.count += 1;
};

const remarkPlugins: PluggableList = [...Object.values(defaultRemarkPlugins), countParses];

const host = document.createElement("div");

document.body.append(host);

/** `cache` is what the chat passes for a finished reply; `isAnimating` alone renders a finished reply uncached. */
const render = (cache: boolean, text = REPLY, rehypePlugins?: PluggableList, isAnimating = !cache): string => {
    const root = createRoot(host);

    act(() => {
        root.render(
            <MarkdownBlockCacheContext value={cache}>
                <Streamdown BlockComponent={CachedMarkdownBlock} isAnimating={isAnimating} rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins}>
                    {text}
                </Streamdown>
            </MarkdownBlockCacheContext>,
        );
    });

    // eslint-disable-next-line unicorn/prefer-dom-node-html-methods -- jsdom has no `getHTML`
    const html = host.innerHTML;

    act(() => root.unmount());

    return html;
};

beforeEach(() => {
    clearMarkdownBlockCache();
    parses.count = 0;
});

afterEach(() => {
    host.replaceChildren();
});

describe(CachedMarkdownBlock, () => {
    it("does not parse a finished reply again when it mounts a second time", () => {
        expect.assertions(2);

        render(true);

        expect(parses.count).toBe(BLOCKS);

        render(true);

        expect(parses.count).toBe(BLOCKS);
    });

    it("parses a streaming reply on every mount", () => {
        expect.assertions(2);

        render(false);

        expect(parses.count).toBe(BLOCKS);

        render(false);

        expect(parses.count).toBe(2 * BLOCKS);
    });

    it("keeps a separate entry per plugin set", () => {
        expect.assertions(1);

        render(true);
        render(true, REPLY, [defaultRehypePlugins.sanitize, defaultRehypePlugins.harden] as PluggableList);

        expect(parses.count).toBe(2 * BLOCKS);
    });

    it("renders the same markup as Streamdown's own block, from the cache too", () => {
        expect.assertions(2);

        const streamdown = render(false, REPLY, undefined, false);

        expect(render(true)).toBe(streamdown);
        expect(render(true)).toBe(streamdown);
    });

    it("shows HTML as text, like Streamdown, when the plugins have no raw HTML step", () => {
        expect.assertions(2);

        const withoutRaw = [defaultRehypePlugins.sanitize, defaultRehypePlugins.harden] as PluggableList;
        const streamdown = render(false, "Inline <b>html</b> here.", withoutRaw, false);

        expect(streamdown).toContain("&lt;b&gt;");
        expect(render(true, "Inline <b>html</b> here.", withoutRaw)).toBe(streamdown);
    });

    it("never serves a block cached for the plain-text plugin list to the raw-HTML list, or back", () => {
        expect.assertions(5);

        const block = "Inline <b>html</b> here.";
        const plainList = streamdownRehypePlugins("plain text");
        const htmlList = streamdownRehypePlugins(block);

        // The same block text, finished, under each list the chat can pick.
        const asText = render(true, block, plainList);
        const asHtml = render(true, block, htmlList);

        expect(asText).toContain("&lt;b&gt;html&lt;/b&gt;");
        expect(asHtml).toContain("<b>html</b>");
        expect(parses.count).toBe(2);

        // Both are cached now, each under its own list.
        expect(render(true, block, plainList)).toBe(asText);
        expect(render(true, block, htmlList)).toBe(asHtml);
    });
});
