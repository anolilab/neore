import type { RefObject } from "react";
import { useEffect } from "react";

const LANGUAGE_CLASS = /language-([\w+-]+)/;

/** The scrolling `<pre>` Streamdown renders for a code block. */
const CODE_BLOCK_PRE = "[data-streamdown='code-block-body'] pre";

/**
 * Streamdown renders each code block's scrolling `<pre>` itself, and its component map does not reach that element, so a
 * long line cannot be scrolled from the keyboard (axe: `scrollable-region-focusable`). This makes every such `<pre>` a
 * focusable, named region inside `root`, and keeps doing so as a streamed reply adds blocks. A block without a language
 * is named `fallbackLabel`, so no region is left unnamed.
 */
export const useFocusableCodeBlocks = (root: RefObject<HTMLElement | null>, fallbackLabel: string): void => {
    useEffect(() => {
        const element = root.current;

        if (!element) {
            return undefined;
        }

        const markPre = (pre: HTMLElement): void => {
            const label = LANGUAGE_CLASS.exec(pre.className)?.[1] ?? fallbackLabel;

            // Skip a block that is already marked, so the attribute writes do not cost a style recalculation.
            if (pre.tabIndex === 0 && pre.getAttribute("role") === "region" && pre.getAttribute("aria-label") === label) {
                return;
            }

            pre.tabIndex = 0;
            pre.setAttribute("role", "region");
            pre.setAttribute("aria-label", label);
        };

        const markWithin = (node: Element): void => {
            if (node.matches(CODE_BLOCK_PRE)) {
                markPre(node as HTMLElement);
            }

            for (const pre of node.querySelectorAll<HTMLElement>(CODE_BLOCK_PRE)) {
                markPre(pre);
            }
        };

        markWithin(element);

        // A streamed reply changes the tree every frame. Only what a change added is looked at, not every block again;
        // a `class` change relabels a block whose language arrived after it opened.
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === "attributes") {
                    if (record.target instanceof HTMLElement && record.target.matches(CODE_BLOCK_PRE)) {
                        markPre(record.target);
                    }
                } else {
                    for (const added of record.addedNodes) {
                        if (added instanceof Element) {
                            markWithin(added);
                        }
                    }
                }
            }
        });

        observer.observe(element, { attributeFilter: ["class"], childList: true, subtree: true });

        return () => {
            observer.disconnect();
        };
    }, [root, fallbackLabel]);
};
