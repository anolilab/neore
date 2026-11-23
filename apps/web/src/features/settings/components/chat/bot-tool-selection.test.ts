import { mcpServerKey } from "@neore/backend/bots/tool-selectors";
import { describe, expect, it } from "vitest";

import { resolveTypedSelector } from "./bot-tool-selection";

/** A server's key, or a failed setup: an empty key would let the cases pass with selectors no server can have. */
const keyOf = (url: string): string => {
    const key = mcpServerKey(url);

    if (key === undefined) {
        throw new Error(`No server key for ${url}`);
    }

    return key;
};

const DOCS = keyOf("https://docs.example/mcp");
const OTHER = keyOf("https://other.example/mcp");

describe(resolveTypedSelector, () => {
    it("names a server saved twice under one name and address once", () => {
        const servers = [
            { key: DOCS, name: "docs" },
            { key: DOCS, name: "docs" },
        ];

        expect(resolveTypedSelector("docs:search", servers)).toStrictEqual([`${DOCS}:search`]);
        expect(resolveTypedSelector("docs:*", servers)).toStrictEqual([`${DOCS}:*`]);
    });

    it("still names every server of that name at a different address", () => {
        const servers = [
            { key: DOCS, name: "docs" },
            { key: DOCS, name: "docs" },
            { key: OTHER, name: "docs" },
        ];

        expect(resolveTypedSelector("docs:search", servers)).toStrictEqual([`${DOCS}:search`, `${OTHER}:search`]);
    });
});
