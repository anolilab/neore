"use client";

/**
 * TextSelectionMenu - Floating popup that appears when text is selected in a message.
 * Shows "Pin selection" and "Copy" actions.
 */

import { Trans } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { CopyIcon, PinIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

const WHITESPACE_RE = /\s+/;

/**
 * Parse a markdown string into top-level blocks (split on blank lines,
 * code-fence-aware so blocks inside ``` are never split).
 */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s/;

const parseMarkdownBlocks = (markdown: string): string[] => {
    const blocks: string[] = [];
    const lines = markdown.split("\n");
    const current: string[] = [];
    let isInCode = false;

    for (const line of lines) {
        if (line.startsWith("```")) {
            isInCode = !isInCode;
        }

        if (!isInCode && line.trim() === "") {
            if (current.length > 0) {
                blocks.push(current.join("\n"));
                current.length = 0;
            }
        } else if (!isInCode && LIST_ITEM_RE.test(line) && current.length > 0) {
            // Each list item becomes its own block so partial-list selections work
            blocks.push(current.join("\n"));
            current.length = 0;
            current.push(line);
        } else {
            current.push(line);
        }
    }

    if (current.length > 0) {
        blocks.push(current.join("\n"));
    }

    return blocks;
};

const getTopLevelBlocks = (container: Element): Element[] => {
    const BLOCKS = new Set(["BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "P", "PRE", "TABLE"]);
    const LIST_CONTAINERS = new Set(["OL", "UL"]);
    const result: Element[] = [];

    const walk = (element: Element): void => {
        for (const child of element.children) {
            if (BLOCKS.has(child.tagName)) {
                result.push(child);
            } else if (LIST_CONTAINERS.has(child.tagName)) {
                // Surface each LI as its own block so partial-list selections work
                for (const li of child.children) {
                    if (li.tagName === "LI") {
                        result.push(li);
                    }
                }
            } else {
                walk(child);
            }
        }
    };

    walk(container);

    return result;
};

/** Strip markdown formatting to get plain comparable text. */
const normalizeMdBlock = (md: string): string =>
    md
        .replaceAll(/^#{1,6}\s+/gm, "")
        .replaceAll(/^[ \t]*[-*+]\s+/gm, "")
        .replaceAll(/^[ \t]*\d+\.\s+/gm, "")
        .replaceAll(/\*\*([^*]*)\*\*/g, "$1")
        .replaceAll(/\*([^*]*)\*/g, "$1")
        .replaceAll(/`([^`]*)`/g, "$1")
        .replaceAll(/\[([^[\]]*)\]\(([^()]*)\)/g, "$1")
        // Strip all non-letter, non-digit, non-space, non-hyphen characters
        // (covers ≈ → ← : ; ( ) . ! ? | – — and any other symbols)
        .replaceAll(/[^\p{L}\p{N}\s-]/gu, " ")
        .replaceAll(/\s+/g, " ")
        .trim()
        .toLowerCase();

/**
 * Find the markdown block index whose normalized text content most closely
 * matches the given anchor text. Searches forward from `startFrom`.
 */
const findMdBlockByText = (mdBlocks: string[], anchorText: string, startFrom = 0): number => {
    // Normalize the anchor the same way as blocks so special chars (≈ → : etc.)
    // are stripped consistently on both sides before comparison.
    const normalizedAnchor = normalizeMdBlock(anchorText);
    const anchorWords = normalizedAnchor
        .split(WHITESPACE_RE)
        .filter((w) => w.length >= 3)
        .slice(0, 8);

    if (anchorWords.length === 0) {
        return -1;
    }

    for (let i = startFrom; i < mdBlocks.length; i += 1) {
        const normalizedBlock = normalizeMdBlock(mdBlocks[i] ?? "");

        // All anchor words must appear in the block (order-independent).
        // Using every() instead of a joined substring avoids false negatives
        // when short words appear between the anchor words in the markdown
        // (e.g. "check-list no measuring" vs "check-list measuring").
        if (anchorWords.every((w) => normalizedBlock.includes(w))) {
            return i;
        }
    }

    return -1;
};

/**
 * Extract markdown from a single [data-markdown-part] element for the given range.
 * Returns null when no matching blocks are found (caller should use full markdown or plainText).
 */
const extractFromSinglePart = (range: Range, markdownPartElement: HTMLElement): string | null => {
    const fullMarkdown = markdownPartElement.dataset.markdownPart ?? "";

    if (!fullMarkdown) {
        return null;
    }

    const domBlocks = getTopLevelBlocks(markdownPartElement);
    const mdBlocks = parseMarkdownBlocks(fullMarkdown);

    // No block structure — return the whole part's markdown (rare: inline-only message)
    if (domBlocks.length === 0 || mdBlocks.length === 0) {
        return fullMarkdown;
    }

    // Step 1: find which DOM blocks the range intersects
    let firstDomIndex = -1;
    let lastDomIndex = -1;

    for (const [i, domBlock] of domBlocks.entries()) {
        if (!(domBlock && range.intersectsNode(domBlock))) {
            continue;
        }

        if (firstDomIndex === -1) {
            firstDomIndex = i;
        }

        lastDomIndex = i;
    }

    if (firstDomIndex === -1) {
        return null;
    }

    // Step 2: match those DOM blocks to markdown blocks by text content
    const firstDomText = (domBlocks[firstDomIndex]?.textContent ?? "").replaceAll(/\s+/g, " ").trim();
    const lastDomText = (domBlocks[lastDomIndex]?.textContent ?? "").replaceAll(/\s+/g, " ").trim();

    const firstMdIndex = findMdBlockByText(mdBlocks, firstDomText);

    if (firstMdIndex === -1) {
        return null;
    }

    let lastMdIndex = firstMdIndex;

    if (firstDomIndex !== lastDomIndex) {
        const found = findMdBlockByText(mdBlocks, lastDomText, firstMdIndex);

        if (found !== -1) {
            lastMdIndex = found;
        }
    }

    // Step 3: extract and join the markdown slice
    // Adjacent list items must be joined with \n (no blank line) so they render
    // as a single list rather than N separate one-item lists.
    const slice = mdBlocks.slice(firstMdIndex, lastMdIndex + 1);
    const allListItems = slice.every((b) => LIST_ITEM_RE.test(b));

    return slice.join(allListItems ? "\n" : "\n\n") || null;
};

/**
 * Given a selection range, return the best markdown representation of the
 * selected content.
 *
 * Handles two cases:
 *   A) Selection within a single [data-markdown-part] element (common case).
 *   B) Selection spanning multiple [data-markdown-part] elements — happens when
 *      the AI used tool calls mid-response, splitting text into separate parts.
 *      In that case we combine the extracted markdown from each intersecting part.
 */
const resolveSelectionText = (range: Range, plainText: string): string => {
    const container = range.commonAncestorContainer;
    const element = (container.nodeType === Node.TEXT_NODE ? container.parentElement : container) as HTMLElement | null;

    // Case A: selection is within a single markdown part
    const markdownPartElement = element?.closest("[data-markdown-part]");

    if (markdownPartElement) {
        return extractFromSinglePart(range, markdownPartElement as HTMLElement) ?? plainText;
    }

    // Case B: commonAncestorContainer is above [data-markdown-part] — cross-part selection.
    // Walk up to [data-message-id] and find every [data-markdown-part] the range touches.
    const messageElement = element?.closest("[data-message-id]");

    if (!messageElement) {
        return plainText;
    }

    const allParts = [...messageElement.querySelectorAll("[data-markdown-part]")];
    const intersectingParts = allParts.filter((part) => range.intersectsNode(part));

    if (intersectingParts.length === 0) {
        return plainText;
    }

    const combined = intersectingParts
        .flatMap((part) => {
            // Try to extract only the selected blocks; fall back to the full part markdown
            const markdown = extractFromSinglePart(range, part as HTMLElement) ?? (part as HTMLElement).dataset.markdownPart ?? "";

            return markdown ? [markdown] : [];
        })
        .join("\n\n");

    return combined || plainText;
};

interface TextSelectionMenuProps {
    isTextModel?: boolean;
    threadId?: string;
}

interface SelectionState {
    messageId: string;
    messageRole: string;
    rect: DOMRect;
    text: string;
}

const TextSelectionMenu: FC<TextSelectionMenuProps> = ({ isTextModel = true, threadId }) => {
    const [selection, setSelection] = useState<SelectionState | null>(null);
    const crpc = useCRPC();
    const setActiveRightSidebarTab = useChatUIStore((state) => state.setActiveRightSidebarTab);
    const { mutate: createPin } = useMutation(crpc.chat.pins.functions.createPin.mutationOptions());
    const menuRef = useRef<HTMLDivElement>(null);

    const handleMouseUp = useCallback(() => {
        const sel = globalThis.getSelection();
        const plainText = sel?.toString().trim();

        if (!plainText || !sel || sel.rangeCount === 0) {
            setSelection(null);

            return;
        }

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        // Find closest ancestor with data-message-id
        const container = range.commonAncestorContainer as Node;
        const element = (container.nodeType === Node.TEXT_NODE ? container.parentElement : container) as HTMLElement | null;
        const messageElement = element?.closest("[data-message-id]") as HTMLElement | null;

        if (!messageElement) {
            setSelection(null);

            return;
        }

        const messageId = messageElement.dataset.messageId ?? "";
        const messageRole = messageElement.dataset.messageRole ?? "assistant";
        const text = resolveSelectionText(range, plainText);

        setSelection({ messageId, messageRole, rect, text });
    }, []);

    const handleMouseDown = useCallback((e: MouseEvent) => {
        // Dismiss if click is outside the menu
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
            setSelection(null);
        }
    }, []);

    useEffect(() => {
        document.addEventListener("mouseup", handleMouseUp);
        document.addEventListener("mousedown", handleMouseDown);

        return () => {
            document.removeEventListener("mouseup", handleMouseUp);
            document.removeEventListener("mousedown", handleMouseDown);
        };
    }, [handleMouseUp, handleMouseDown]);

    // Dismiss on scroll
    useEffect(() => {
        const handleScroll = () => setSelection(null);

        window.addEventListener("scroll", handleScroll, { capture: true });

        return () => window.removeEventListener("scroll", handleScroll, true);
    }, []);

    const handleCopy = () => {
        navigator.clipboard.writeText(selection?.text ?? "").catch(() => {});
        setSelection(null);
    };

    const handlePinSelection = () => {
        if (!selection || !threadId) {
            return;
        }

        createPin(
            {
                messageId: selection.messageId,
                messageRole: selection.messageRole,
                selectedText: selection.text,
                // `threadId` is the `/chat/$threadId` route param, passed down as a plain string.
                threadId: threadId as Id<"threads">,
            },
            {
                onError: (error) => showError(error as Error),
                onSuccess: () => {
                    setActiveRightSidebarTab("pins");
                },
            },
        );
        setSelection(null);
        globalThis.getSelection()?.removeAllRanges();
    };

    // Position the menu above the selection (fixed = viewport coordinates, no scrollY offset)
    const top = selection ? selection.rect.top - 44 : 0;
    const left = selection ? selection.rect.left + selection.rect.width / 2 : 0;

    return (
        <AnimatePresence>
            {selection && threadId && (
                <motion.div
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    className="bg-background border-border fixed z-50 flex -translate-x-1/2 items-center gap-1 rounded-lg border p-1 shadow-md"
                    exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.1 }, y: 3 }}
                    initial={{ opacity: 0, scale: 0.92, y: 3 }}
                    key="text-selection-menu"
                    ref={menuRef}
                    style={{ left, top }}
                    transition={{ duration: 0.12, ease: "easeOut" }}
                >
                    {isTextModel && (
                        <Button className="h-7 gap-1.5 px-2 text-xs" onClick={handlePinSelection} variant="ghost">
                            <PinIcon className="size-3" />
                            <Trans>Pin</Trans>
                        </Button>
                    )}
                    <Button className="h-7 gap-1.5 px-2 text-xs" onClick={handleCopy} variant="ghost">
                        <CopyIcon className="size-3" />
                        <Trans>Copy</Trans>
                    </Button>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default TextSelectionMenu;
