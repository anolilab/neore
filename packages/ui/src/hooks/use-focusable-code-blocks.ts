import type { RefObject } from "react";
import { useEffect } from "react";

const LANGUAGE_CLASS = /language-([\w+-]+)/;

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

        const mark = (): void => {
            for (const pre of element.querySelectorAll<HTMLElement>(":scope [data-streamdown='code-block-body'] pre")) {
                const language = LANGUAGE_CLASS.exec(pre.className)?.[1];

                pre.tabIndex = 0;
                pre.setAttribute("role", "region");
                pre.setAttribute("aria-label", language ?? fallbackLabel);
            }
        };

        mark();

        const observer = new MutationObserver(mark);

        observer.observe(element, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
        };
    }, [root, fallbackLabel]);
};
