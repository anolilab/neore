/**
 * Decodes a complete text file. A UTF-16 byte-order mark (FF FE, or FE FF) selects
 * UTF-16, and anything else is UTF-8. `TextDecoder` drops the mark itself.
 */
export const decodeTextBytes = (bytes: Uint8Array): string => {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder("utf-16le").decode(bytes);
    }

    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder("utf-16be").decode(bytes);
    }

    return new TextDecoder().decode(bytes);
};
