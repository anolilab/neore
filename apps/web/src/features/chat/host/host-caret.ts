/**
 * Where a textarea's caret belongs after hidden characters are removed from its value. Offsets are UTF-16 units, as a
 * textarea's selection is. Each removed range that starts before the offset moves it back by the units it covers.
 * `removed` is in order, as `findHiddenText` returns it.
 */
export const caretAfterRemoval = (offset: number, removed: ReadonlyArray<{ index: number; length: number }>): number => {
    let shift = 0;

    for (const range of removed) {
        if (range.index >= offset) {
            break;
        }

        shift += Math.min(range.length, offset - range.index);
    }

    return offset - shift;
};
