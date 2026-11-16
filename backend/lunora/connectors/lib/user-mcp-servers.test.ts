/**
 * Finding a server by name from the stored lists alone, as the MCP app proxy does under a cap: the user's own server wins a
 * name clash, as in `findUserMcpServer`, and no token is resolved.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { findUserMcpServerIdentity } from "./user-mcp-servers";

vi.mock("./grant-runtime", () => {
    return {
        getConnectorMcpServers: vi.fn(),
        withMcpServerGrants: vi.fn(),
    };
});

const ctxWith = (saved: { name: string }[], grants: { name: string; slug: string }[]) => {
    return {
        runQuery: vi.fn(async (reference: unknown) => {
            if (reference === internal.auth.functions.getMCPServersQuery) {
                return saved;
            }

            if (reference === internal.connectors.store.listConnectorGrants) {
                return grants;
            }

            throw new Error("unexpected query");
        }),
    };
};

describe("findUserMcpServerIdentity", () => {
    it("names the user's own server when a connector shares its name", async () => {
        const ctx = ctxWith([{ name: "Notion" }], [{ name: "Notion", slug: "notion" }]);

        await expect(findUserMcpServerIdentity(ctx as never, "alice", "Notion")).resolves.toStrictEqual({ name: "Notion" });
    });

    it("names a connector by its slug", async () => {
        const ctx = ctxWith([], [{ name: "Notion", slug: "notion" }]);

        await expect(findUserMcpServerIdentity(ctx as never, "alice", "Notion")).resolves.toStrictEqual({ connectorSlug: "notion", name: "Notion" });
    });

    it("finds nothing for a name the user has no server for", async () => {
        await expect(findUserMcpServerIdentity(ctxWith([], []) as never, "alice", "Elsewhere")).resolves.toBeNull();
    });
});
