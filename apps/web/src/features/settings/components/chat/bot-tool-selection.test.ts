import { mcpServerKey } from "@neore/backend/bots/tool-selectors";
import { describe, expect, it } from "vitest";

import { resolveTypedSelector } from "./bot-tool-selection";

const DOCS = mcpServerKey("https://docs.example/mcp") ?? "";
const OTHER = mcpServerKey("https://other.example/mcp") ?? "";

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
