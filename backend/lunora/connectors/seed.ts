/**
 * Connector Definitions Seeding
 *
 * Upserts the built-in connector catalogue by slug: missing rows are inserted,
 * existing ones are brought in line with this file. Safe to run repeatedly, and
 * the way to ship a catalogue change.
 *
 * Usage:
 *   cd backend && ./node_modules/.bin/lunora run connectors_seed:seed
 *
 * Every entry points at the PROVIDER'S OWN hosted remote MCP server; OAuth is
 * discovered from that server (`lib/mcp-oauth.ts`). Endpoints and their auth
 * shapes as verified on 2026-09-23:
 *
 * - Notion  https://mcp.notion.com/mcp — supports Dynamic Client Registration,
 *   so it needs no operator setup. https://developers.notion.com/docs/get-started-with-mcp
 * - GitHub  https://api.githubcopilot.com/mcp/ — no DCR; the operator registers
 *   an OAuth App (or GitHub App) and sets GITHUB_CONNECTOR_CLIENT_ID/SECRET.
 *   https://github.com/github/github-mcp-server
 * - Slack   https://mcp.slack.com/mcp — no DCR; needs a Slack app
 *   (SLACK_CONNECTOR_CLIENT_ID/SECRET), and Slack only admits Marketplace-listed
 *   or workspace-internal apps. https://docs.slack.dev/ai/slack-mcp-server/
 * - Google Drive https://drivemcp.googleapis.com/mcp/v1 and
 *   Gmail https://gmailmcp.googleapis.com/mcp/v1 — no DCR; a Google Cloud "Web
 *   application" OAuth client (GOOGLE_CONNECTOR_CLIENT_ID/SECRET), and both are
 *   in the Workspace Developer Preview, so beta.
 *   https://developers.google.com/workspace/guides/configure-mcp-servers
 *
 * The redirect URI every pre-registered app must allow is
 * `${SITE_URL}/dashboard/settings/connectors/callback`.
 */
import { v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { withoutUndefined } from "../lib/patch";

type ConnectorSeed = Omit<Doc<"connectorDefinitions">, "_creationTime" | "_id">;

/** Google only issues a refresh token for offline access, and only re-issues one on a fresh consent. */
const GOOGLE_OFFLINE = [
    { key: "access_type", value: "offline" },
    { key: "prompt", value: "consent" },
];

export const CONNECTOR_CATALOG: ConnectorSeed[] = [
    {
        capabilities: ["read", "write", "search", "create"],
        category: "productivity",
        description: "Search, read, create and update pages and databases in your Notion workspace",
        docsUrl: "https://developers.notion.com/docs/get-started-with-mcp",
        icon: "notion",
        isBuiltIn: true,
        isPremium: false,
        mcpProtocol: "http",
        mcpWorkerUrl: "https://mcp.notion.com/mcp",
        name: "Notion",
        oauthProvider: "notion",
        oauthScopes: [],
        requiresOAuth: true,
        slug: "notion",
        status: "active",
        toolCategories: ["pages", "databases", "search"],
    },
    {
        availabilityNote: "Requires a GitHub OAuth App registered by the operator.",
        capabilities: ["read", "write", "search"],
        category: "development",
        description: "Search repositories, issues and pull requests; create issues and comments",
        docsUrl: "https://github.com/github/github-mcp-server",
        icon: "github",
        isBuiltIn: true,
        isPremium: false,
        mcpProtocol: "http",
        mcpWorkerUrl: "https://api.githubcopilot.com/mcp/",
        name: "GitHub",
        oauthClientEnvPrefix: "GITHUB_CONNECTOR",
        oauthProvider: "github",
        oauthScopes: ["repo", "read:org", "read:user"],
        requiresOAuth: true,
        slug: "github",
        status: "beta",
        toolCategories: ["repos", "issues", "pull-requests"],
    },
    {
        availabilityNote: "Slack only admits Marketplace-listed or workspace-internal apps, and a workspace admin may need to approve it.",
        capabilities: ["read", "write", "search"],
        category: "communication",
        description: "Search conversations, read channels and threads, and send messages",
        docsUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
        icon: "slack",
        isBuiltIn: true,
        isPremium: false,
        mcpProtocol: "http",
        mcpWorkerUrl: "https://mcp.slack.com/mcp",
        name: "Slack",
        oauthClientEnvPrefix: "SLACK_CONNECTOR",
        oauthProvider: "slack",
        oauthScopes: ["search:read.public", "search:read.private", "channels:history", "groups:history", "users:read", "chat:write"],
        requiresOAuth: true,
        slug: "slack",
        status: "beta",
        toolCategories: ["messages", "channels", "search"],
    },
    {
        availabilityNote: "Google's Drive MCP server is in the Workspace Developer Preview.",
        capabilities: ["read", "search"],
        category: "productivity",
        description: "Search and read files in your Google Drive",
        docsUrl: "https://developers.google.com/workspace/drive/api/reference/mcp",
        icon: "google-drive",
        isBuiltIn: true,
        isPremium: false,
        mcpProtocol: "http",
        mcpWorkerUrl: "https://drivemcp.googleapis.com/mcp/v1",
        name: "Google Drive",
        oauthAuthorizeParams: GOOGLE_OFFLINE,
        oauthClientEnvPrefix: "GOOGLE_CONNECTOR",
        oauthProvider: "google",
        oauthScopes: ["https://www.googleapis.com/auth/drive.readonly"],
        requiresOAuth: true,
        slug: "google-drive",
        status: "beta",
        toolCategories: ["files", "search", "folders"],
    },
    {
        availabilityNote: "Google's Gmail MCP server is in the Workspace Developer Preview.",
        capabilities: ["read", "search", "write"],
        category: "communication",
        description: "Search and read email, and draft replies",
        docsUrl: "https://developers.google.com/workspace/gmail/api/reference/mcp",
        icon: "gmail",
        isBuiltIn: true,
        isPremium: false,
        mcpProtocol: "http",
        mcpWorkerUrl: "https://gmailmcp.googleapis.com/mcp/v1",
        name: "Gmail",
        oauthAuthorizeParams: GOOGLE_OFFLINE,
        oauthClientEnvPrefix: "GOOGLE_CONNECTOR",
        oauthProvider: "google",
        oauthScopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
        requiresOAuth: true,
        slug: "gmail",
        status: "beta",
        toolCategories: ["emails", "labels", "drafts"],
    },
];

export const seed = internalMutation
    .input({})
    .output(v.object({ inserted: v.number(), updated: v.number() }))
    .mutation(async ({ ctx }) => {
        let inserted = 0;
        let updated = 0;

        for (const entry of CONNECTOR_CATALOG) {
            const existing = await ctx.db.connectorDefinitions.findUnique({ where: { slug: entry.slug } });

            if (existing) {
                // A patch brings every field listed here up to date. It cannot drop
                // an optional field this file stops setting (Lunora refuses
                // `undefined` in a patch) — that takes a one-off migration.
                await ctx.db.patch(existing._id, { ...withoutUndefined(entry) });
                updated += 1;
            } else {
                await ctx.db.insert("connectorDefinitions", entry);
                inserted += 1;
            }
        }

        console.log(`Connector catalogue: ${String(inserted)} inserted, ${String(updated)} updated`);

        return { inserted, updated };
    });
