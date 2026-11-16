/**
 * The MCP App proxy's cap, read for real from the request (`readRequestPermissionCap`): the caller's sign-in names a
 * session, the session an organization, and that organization's policy the cap. The other proxy tests inject the cap;
 * these fail if that lookup stops reaching the organization's policy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { callMCPToolFromAppHttpAction } from "./mcp-apps";

const state = vi.hoisted(() => {
    return {
        configured: false,
        connects: 0,
    };
});

vi.mock("../../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => {
            return { _id: "alice" };
        },
    };
});

vi.mock("../../lib/rate-limiter", () => {
    return {
        checkRateLimit: async () => {
            return { ok: true };
        },
    };
});

vi.mock("../../connectors/lib/user-mcp-servers", () => {
    return {
        findUserMcpServer: async () => null,
        findUserMcpServerIdentity: async (_ctx: unknown, _userId: string, name: string) =>
            state.configured && name === "Notion" ? { connectorSlug: "notion", name } : null,
    };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
    return {
        Client: class {
            async close() {}

            async connect() {
                state.connects += 1;
            }
        },
    };
});

/** A signed-in request whose sign-in is `identity`; its session lies in `organizationId`, whose policy sets `cap`. */
const contextFor = (identity: Record<string, unknown>, organizationId: string | null, cap: "ask" | "auto" | "off") => {
    const reads: { args: unknown; name: string }[] = [];

    const runQuery = async (reference: unknown, args: unknown) => {
        if (reference === internal.auth.session_organization.getSessionOrganizationForCap) {
            reads.push({ args, name: "session" });

            return { organizationId };
        }

        if (reference === internal.auth.organization_policy.getPermissionCapQuery) {
            reads.push({ args, name: "policy" });

            return cap;
        }

        // The member's own tool permissions: none set.
        return {};
    };

    return { context: { auth: { getIdentity: async () => identity, userId: "alice" }, runQuery } as never, reads };
};

const call = async (context: never) =>
    await callMCPToolFromAppHttpAction(
        context,
        new Request("https://backend.example.com/mcp/tool", {
            body: JSON.stringify({ arguments: {}, serverName: "Notion", toolName: "search" }),
            method: "POST",
        }),
    );

beforeEach(() => {
    state.configured = true;
    state.connects = 0;
});

describe("MCP App proxy cap read from the request", () => {
    it("refuses a web session's call under its organization's ask cap, after reading that organization's policy", async () => {
        const { context, reads } = contextFor({ sessionId: "session-1", userId: "alice" }, "org-a", "ask");
        const response = await call(context);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("organization's tool policy") });
        expect(reads).toStrictEqual([
            { args: { sessionId: "session-1", userId: "alice" }, name: "session" },
            { args: { organizationId: "org-a" }, name: "policy" },
        ]);
        expect(state.connects).toBe(0);
    });

    it("reads an app grant's sign-in the same way, and refuses under its organization's off cap", async () => {
        const { context, reads } = contextFor({ grantSessionId: "grant-1", userId: "alice" }, "org-a", "off");
        const response = await call(context);

        expect(response.status).toBe(403);
        expect(reads).toStrictEqual([
            { args: { sessionId: "grant-1", userId: "alice" }, name: "session" },
            { args: { organizationId: "org-a" }, name: "policy" },
        ]);
    });

    it("lets a personal-space session's call past the cap, reading no policy", async () => {
        state.configured = false;

        const { context, reads } = contextFor({ sessionId: "session-1", userId: "alice" }, null, "off");
        const response = await call(context);

        // Past the cap the server is looked up, and this one is not configured.
        expect(response.status).toBe(404);
        expect(reads).toStrictEqual([{ args: { sessionId: "session-1", userId: "alice" }, name: "session" }]);
    });
});
