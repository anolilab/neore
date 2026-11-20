/**
 * A bot's tool selection: which of a run's tools it keeps. It only removes, the exclude list wins, and a selector that
 * names nothing selects nothing. Servers are named by their stable key, never their display name.
 */
import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import { applyBotToolSelection } from "./tool-selection";
import type { ToolOrigin } from "./tool-selectors";
import {
    BOT_TOOL_SELECTOR_MAX_COUNT,
    BOT_TOOL_SELECTOR_MAX_LENGTH,
    connectorServerKey,
    mcpServerKey,
    normalizeBotToolSelection,
    selectionMayKeepDevices,
    selectionMayKeepServer,
    selectionKeeps,
    selectionServerKey,
} from "./tool-selectors";

const DOCS = mcpServerKey("https://docs.example/mcp") ?? "";
const MAIL = connectorServerKey("gmail") ?? "";

const ORIGINS: Record<string, ToolOrigin> = {
    mcp_docs__read: { server: DOCS, tool: "read" },
    mcp_docs__search: { server: DOCS, tool: "search" },
    mcp_mail__send: { server: MAIL, tool: "send" },
};

const TOOLS = Object.fromEntries(["webSearch", "dateTime", ...Object.keys(ORIGINS)].map((name) => [name, {}])) as ToolSet;

const kept = (selection: Parameters<typeof applyBotToolSelection>[1], origins: Record<string, ToolOrigin> = ORIGINS): string[] =>
    Object.keys(
        applyBotToolSelection(
            { ...TOOLS, ...(Object.fromEntries(Object.keys(origins).map((name) => [name, {}])) as ToolSet) },
            selection,
            (name) => origins[name],
        ),
    ).toSorted((a, b) => a.localeCompare(b));

describe("applyBotToolSelection", () => {
    it("keeps every tool when the bot has no selection", () => {
        expect(kept(undefined)).toStrictEqual(Object.keys(TOOLS).toSorted((a, b) => a.localeCompare(b)));
        expect(kept(null)).toStrictEqual(Object.keys(TOOLS).toSorted((a, b) => a.localeCompare(b)));
    });

    it("keeps only the allowed built-ins and server tools", () => {
        expect(kept({ allow: ["webSearch", `${DOCS}:search`], exclude: [] })).toStrictEqual(["mcp_docs__search", "webSearch"]);
    });

    it("lets the exclude list win over the allow list", () => {
        expect(kept({ allow: ["webSearch", `${DOCS}:*`], exclude: [`${DOCS}:read`, "webSearch"] })).toStrictEqual(["mcp_docs__search"]);
    });

    it("removes excluded tools from every tool when nothing is allowed by name", () => {
        expect(kept({ exclude: [`${MAIL}:*`, "dateTime"] })).toStrictEqual(["mcp_docs__read", "mcp_docs__search", "webSearch"]);
    });

    it("gives no tools for an empty allow list", () => {
        expect(kept({ allow: [], exclude: [] })).toStrictEqual([]);
    });

    it("selects nothing with a selector that names no available tool, never every tool", () => {
        expect(kept({ allow: ["nope", `${DOCS}:nope`, `${mcpServerKey("https://gone") ?? ""}:*`, "*", "mcp_docs__search"], exclude: [] })).toStrictEqual([]);
        // A server tool is not named by a bare tool name, nor a built-in by a server's.
        expect(kept({ allow: ["search", `${DOCS}:webSearch`], exclude: [] })).toStrictEqual([]);
    });

    it("excludes a server tool whose own name holds a colon", () => {
        const origins = { ...ORIGINS, mcp_docs__ns_write: { server: DOCS, tool: "ns:write" } };

        expect(kept({ exclude: [`${DOCS}:ns:write`] }, origins)).not.toContain("mcp_docs__ns_write");
        expect(kept({ allow: [`${DOCS}:ns:write`], exclude: [] }, origins)).toStrictEqual(["mcp_docs__ns_write"]);
    });

    it("keeps none of a server's tools when its key is unknown", () => {
        const origins = { ...ORIGINS, mcp_odd__run: { server: "", tool: "run" } };

        expect(kept({ exclude: ["dateTime"] }, origins)).not.toContain("mcp_odd__run");
    });
});

describe("normalizeBotToolSelection", () => {
    it("trims and de-duplicates, and keeps an absent allow list absent", () => {
        expect(normalizeBotToolSelection({ allow: [" webSearch ", "webSearch", ""], exclude: [`${DOCS}:*`, ` ${DOCS}:* `] })).toStrictEqual({
            selection: { allow: ["webSearch"], exclude: [`${DOCS}:*`] },
        });
        expect(normalizeBotToolSelection({ exclude: [`${DOCS}:*`] })).toStrictEqual({ selection: { exclude: [`${DOCS}:*`] } });
        // One that removes nothing is stored as no selection, so the bot reads as keeping every tool.
        expect(normalizeBotToolSelection({ exclude: [" "] })).toStrictEqual({ selection: null });
    });

    it("refuses a list past the cap, a selector past its length and one with control characters", () => {
        const many = Array.from({ length: BOT_TOOL_SELECTOR_MAX_COUNT + 1 }, (_, index) => `tool${String(index)}`);

        expect(normalizeBotToolSelection({ allow: many, exclude: [] })).toHaveProperty("error");
        expect(normalizeBotToolSelection({ exclude: many })).toHaveProperty("error");
        expect(normalizeBotToolSelection({ exclude: ["x".repeat(BOT_TOOL_SELECTOR_MAX_LENGTH + 1)] })).toHaveProperty("error");
        expect(normalizeBotToolSelection({ exclude: [`${DOCS}:\nsearch`] })).toHaveProperty("error");
    });

    it("refuses a server named by its display name, which a rename would stop matching", () => {
        expect(normalizeBotToolSelection({ exclude: ["docs:*"] })).toHaveProperty("error");
        expect(normalizeBotToolSelection({ allow: ["GitHub:create_issue"], exclude: [] })).toHaveProperty("error");
        expect(normalizeBotToolSelection({ exclude: [`${DOCS}:`] })).toHaveProperty("error");
    });
});

describe("selectionMayKeepServer", () => {
    it("skips a server the allow list never names, or one excluded whole", () => {
        expect(selectionMayKeepServer(null, DOCS)).toBe(true);
        expect(selectionMayKeepServer({ exclude: ["dateTime"] }, DOCS)).toBe(true);
        expect(selectionMayKeepServer({ allow: [], exclude: [] }, DOCS)).toBe(false);
        expect(selectionMayKeepServer({ allow: ["webSearch", `${MAIL}:send`], exclude: [] }, DOCS)).toBe(false);
        expect(selectionMayKeepServer({ allow: [`${DOCS}:read`], exclude: [] }, DOCS)).toBe(true);
        expect(selectionMayKeepServer({ exclude: [`${DOCS}:*`] }, DOCS)).toBe(false);
        expect(selectionMayKeepServer({ exclude: [] }, undefined)).toBe(false);
        expect(selectionMayKeepDevices({ allow: ["webSearch"], exclude: [] })).toBe(false);
        expect(selectionMayKeepDevices({ exclude: [] })).toBe(true);
    });
});

describe("selectionServerKey", () => {
    /** The bot owner's own run: the run's saved servers are the owner's. */
    const OWNER_RUN = { runs: true, serverKeys: [] };
    const DOCS_URL = "https://docs.example/mcp";
    const docs = { url: DOCS_URL };

    it("keys a server by its address, under no selection or one that names only saved servers", () => {
        expect(selectionServerKey(null, docs, [DOCS_URL], OWNER_RUN)).toBe(DOCS);
        expect(selectionServerKey({ exclude: [`${DOCS}:read`] }, docs, [DOCS_URL, "https://other"], OWNER_RUN)).toBe(DOCS);
        expect(selectionServerKey({ exclude: [] }, { connectorSlug: "gmail", url: "https://x" }, [], OWNER_RUN)).toBe(MAIL);
    });

    it("keeps none of a server's tools when another saved server shares its address", () => {
        expect(selectionServerKey({ allow: [`${DOCS}:*`], exclude: [] }, docs, [DOCS_URL, DOCS_URL], OWNER_RUN)).toBe("");
        expect(selectionServerKey({ allow: [`${DOCS}:*`], exclude: [] }, docs, [DOCS_URL, DOCS_URL], { runs: false, serverKeys: [] })).toBe("");
    });

    it("keeps no user server's tools when an exclusion names an address no saved server has any more", () => {
        const edited = { exclude: [`${mcpServerKey("https://docs.example/old") ?? ""}:*`] };

        expect(selectionServerKey(edited, docs, [DOCS_URL], OWNER_RUN)).toBe("");
        // A connector's slug never changes, so it is not held to the user's own servers.
        expect(selectionServerKey(edited, { connectorSlug: "gmail" }, [DOCS_URL], OWNER_RUN)).toBe(MAIL);
    });

    it("strips in a collaborator's run only a server the owner also saved, once the owner's exclusion went stale", () => {
        const edited = { exclude: [`${mcpServerKey("https://docs.example/old") ?? ""}:*`] };

        // The owner no longer has the excluded address, and does not have the collaborator's docs server: it keeps its tools.
        expect(selectionServerKey(edited, docs, [DOCS_URL], { runs: false, serverKeys: [] })).toBe(DOCS);
        // The owner saved the docs address too: it may be the server they excluded and then moved, so it keeps none.
        expect(selectionServerKey(edited, docs, [DOCS_URL], { runs: false, serverKeys: [DOCS] })).toBe("");
        // An exclusion the owner's saved servers still have is not stale: the collaborator's other server keeps its tools.
        expect(selectionServerKey({ exclude: [`${DOCS}:*`] }, { url: "https://other" }, ["https://other"], { runs: false, serverKeys: [DOCS] })).toBe(
            mcpServerKey("https://other"),
        );
        // An exact key still names the collaborator's server at the same address.
        expect(
            selectionKeeps({ exclude: [`${DOCS}:*`] }, "mcp_docs__read", {
                server: selectionServerKey({ exclude: [`${DOCS}:*`] }, docs, [DOCS_URL], { runs: false, serverKeys: [DOCS] }),
                tool: "read",
            }),
        ).toBe(false);
    });

    it("gives no key for an address that cannot be encoded, rather than throwing", () => {
        expect(mcpServerKey("https://x/\u{D800}")).toBeUndefined();
        expect(selectionServerKey({ exclude: [] }, { url: "https://x/\u{D800}" }, [], OWNER_RUN)).toBe("");
    });
});
