const CDATA_SECTION_NODE = 4;

/**
 * Appends a CDATA section to an element. Domino has no CDATA node and never
 * yields one from HTML, so this text node is retyped to CDATA_SECTION_NODE, the
 * shape a browser DOM gives. Its clone keeps the type, since turndown clones
 * every DOM input before it converts it.
 */
export function appendCdataSection(parent: Element, data: string): void {
    const htmlDocument = parent.ownerDocument as Document;

    const retype = (node: Text): void => {
        Object.defineProperties(node, {
            clone: {
                // The current text, as a DOM clones it: a copy whose text was changed clones with the change.
                value: () => {
                    const copy = htmlDocument.createTextNode(node.nodeValue ?? "");

                    retype(copy);

                    return copy;
                },
            },
            nodeType: { value: CDATA_SECTION_NODE },
        });
    };

    const text = htmlDocument.createTextNode(data);

    // Domino has no ParentNode.append().
    // eslint-disable-next-line unicorn/prefer-dom-node-append
    parent.appendChild(text);
    retype(text);
}
