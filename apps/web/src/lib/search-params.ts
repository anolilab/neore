import { parseSearchWith, stringifySearchWith } from "@tanstack/react-router";

/**
 * The router's default JSON-parses every query value, so a value that only looks like a number comes back changed:
 * `234567E2` as 23456700 and `2E345678` as `Infinity`, and the address is then rewritten to match. Here a value is
 * read as a number only when the number writes back as the same text; anything else stays the string it was.
 */
const parseValue = (value: string): unknown => {
    const parsed: unknown = JSON.parse(value);

    if (typeof parsed === "number" && String(parsed) !== value) {
        throw new SyntaxError(`${value} does not round-trip as a number`);
    }

    return parsed;
};

export const parseSearch = parseSearchWith(parseValue);

export const stringifySearch = stringifySearchWith(JSON.stringify, parseValue);
