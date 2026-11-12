/**
 * The collapseWhitespace function is adapted from collapse-whitespace
 * by Luc Thevenard.
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Luc Thevenard <lucthevenard@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const RUN_OF_SPACE = /[ \r\n\t]+/g;
const TRAILING_SPACE = / $/;

interface CollapseOptions {
    element: Node;
    isBlock: (node: Node) => boolean;
    isPre?: ((node: Node) => boolean) | null;
    isVoid: (node: Node) => boolean;
}

/**
 * Removes extraneous whitespace from the given element.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- one pass over the tree, as upstream; splitting it only passes state around.
export default function collapseWhitespace(options: CollapseOptions): void {
    const { element, isBlock, isVoid } = options;
    const isPre = options.isPre ?? isPreElement;

    if (!element.firstChild || isPre(element)) {
        return;
    }

    let previousText: CharacterData | null = null;
    let isKeepLeadingWs = false;

    let previous: Node | null = null;
    let node: Node = next(previous, element, isPre);

    while (node !== element) {
        if (node.nodeType === 3 || node.nodeType === 4) {
            // Node.TEXT_NODE or Node.CDATA_SECTION_NODE
            const characterData = node as CharacterData;
            let text = characterData.data.replaceAll(RUN_OF_SPACE, " ");

            if (!isKeepLeadingWs && text[0] === " " && (!previousText || TRAILING_SPACE.test(previousText.data))) {
                text = text.slice(1);
            }

            // `text` might be empty at this point.
            if (!text) {
                node = remove(node);
                continue;
            }

            characterData.data = text;

            previousText = characterData;
        } else if (node.nodeType === 1) {
            // Node.ELEMENT_NODE
            if (isBlock(node) || node.nodeName === "BR") {
                if (previousText) {
                    previousText.data = previousText.data.replace(TRAILING_SPACE, "");
                }

                previousText = null;
                isKeepLeadingWs = false;
            } else if (isVoid(node) || isPre(node)) {
                // Avoid trimming space around non-block, non-BR void elements and inline PRE.
                previousText = null;
                isKeepLeadingWs = true;
            } else if (previousText) {
                // Drop protection if set previously.
                isKeepLeadingWs = false;
            }
        } else {
            node = remove(node);
            continue;
        }

        const nextNode = next(previous, node, isPre);

        previous = node;
        node = nextNode;
    }

    if (previousText) {
        previousText.data = previousText.data.replace(TRAILING_SPACE, "");

        if (!previousText.data) {
            remove(previousText);
        }
    }
}

function isPreElement(node: Node): boolean {
    return node.nodeName === "PRE";
}

/**
 * Removes the given node from the DOM and returns the next node in the sequence.
 */
function remove(node: Node): Node {
    const nextNode = node.nextSibling || node.parentNode;

    (node as ChildNode).remove();

    return nextNode as Node;
}

/**
 * Returns the next node in the sequence, given the current and previous nodes.
 */
function next(previous: Node | null, current: Node, isPre: (node: Node) => boolean): Node {
    if ((previous && previous.parentNode === current) || isPre(current)) {
        return (current.nextSibling || current.parentNode) as Node;
    }

    return (current.firstChild || current.nextSibling || current.parentNode) as Node;
}
