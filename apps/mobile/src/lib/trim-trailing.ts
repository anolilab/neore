/**
 * Drops every `char` from the end of `value`. A `/x+$/` regex backtracks quadratically on a long run of
 * `x` that does not reach the end, so the loop keeps the same result without that cost.
 */
export const trimTrailing = (value: string, char: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === char) {
        end -= 1;
    }

    return value.slice(0, end);
};
