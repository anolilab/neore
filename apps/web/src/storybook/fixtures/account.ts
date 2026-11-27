import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { http, HttpResponse } from "msw";
import type { HttpHandler } from "msw";

import { DAY, HOUR, ago } from "../clock";
import type { LunoraFixture } from "../lunora";
import { lunora } from "../lunora";
import { ORGANIZATION } from "../session";

const CREATED_AT = "2026-01-15T09:00:00.000Z";

const day = (daysAgo: number): string => new Date(ago(daysAgo * DAY)).toISOString().slice(0, 10);

/** Usage tab: a month of spend, per-model totals, a heatmap, skills, projects and two budget alerts. */
export const usageFixtures = (): LunoraFixture[] => {
    const daily = Array.from({ length: 14 }, (_, index) => {
        return {
            completionTokens: 9000 + ((index * 3700) % 8000),
            costMicrodollars: 180_000 + ((index * 97_000) % 420_000),
            date: day(index),
            promptTokens: 41_000 + ((index * 5300) % 30_000),
            requestCount: 12 + ((index * 7) % 23),
        };
    });
    const heatmapDays = Array.from({ length: 120 }, (_, index) => {
        return { costMicrodollars: ((index * 53) % 7) * 90_000, date: day(index), replies: (index * 37) % 9, tokens: ((index * 53) % 7) * 12_000 };
    }).filter((entry) => entry.replies > 0);

    return [
        lunora(api.saas.usage_functions.getMyUsage, {
            byModel: {
                "claude-sonnet-4-5": { cost: 3_420_000, requests: 214, tokens: 1_850_000 },
                "gpt-5": { cost: 1_160_000, requests: 62, tokens: 610_000 },
                "gemini-2.5-flash": { cost: 140_000, requests: 98, tokens: 420_000 },
            },
            dailyBreakdown: daily,
            period: "30d",
            totalCompletionTokens: 612_000,
            totalCostMicrodollars: 4_720_000,
            totalPromptTokens: 2_268_000,
            totalRequests: 374,
        }),
        lunora(api.saas.usage_functions.listMyNotificationRules, [
            {
                action: "notify",
                createdAt: new Date(ago(40 * DAY)).toISOString(),
                id: "rule_monthly",
                isActive: true,
                lastTriggeredAt: new Date(ago(3 * DAY)).toISOString(),
                metric: "monthly_cost",
                modelFilter: null,
                name: "Monthly $10 limit",
                orgId: null,
                period: "month",
                threshold: 10_000_000,
                userId: "user_pro",
            },
            {
                action: "notify_and_block",
                createdAt: new Date(ago(12 * DAY)).toISOString(),
                id: "rule_requests",
                isActive: true,
                lastTriggeredAt: null,
                metric: "request_count",
                modelFilter: "gpt-5",
                name: "GPT-5 requests per day",
                orgId: null,
                period: "day",
                threshold: 80,
                userId: "user_pro",
            },
        ]),
        lunora(api.usage.backfill.getUsageBackfillStatus, "done"),
        lunora(api.usage.activity.getActivityHeatmap, { days: heatmapDays } as never),
        lunora(api.usage.activity.getSkillBreakdown, {
            skills: [
                { costMicrodollars: 2_900_000, replies: 190, skillKey: "default", tokens: 1_700_000 },
                { costMicrodollars: 640_000, replies: 31, skillKey: "daily-brief", tokens: 380_000 },
                { costMicrodollars: 310_000, replies: 22, skillKey: "skill_research", skillName: "Deep research", tokens: 290_000 },
            ],
            truncated: false,
        } as never),
        lunora(api.usage.activity.getProjectBreakdown, {
            noProject: { costMicrodollars: 1_250_000, replies: 88, tokens: 700_000 },
            projects: [
                { costMicrodollars: 2_140_000, projectKey: "project_site", replies: 121, title: "Marketing site", tokens: 1_100_000 },
                { costMicrodollars: 880_000, projectKey: "project_cli", replies: 54, title: "CLI rewrite", tokens: 480_000 },
            ],
            total: { costMicrodollars: 4_270_000, replies: 263, tokens: 2_280_000 },
            truncated: false,
        } as never),
    ];
};

/** Devices tab: two paired computers and a server, and a few audited calls. */
export const deviceFixtures = (): LunoraFixture[] => [
    lunora(api.devices.functions.listDevices, [
        {
            _id: "device_laptop",
            appVersion: "1.14.2",
            createdAt: ago(60 * DAY),
            lastSeenAt: ago(2 * 60 * 1000),
            name: "Ada's MacBook Pro",
            platform: "macos",
            toolNames: ["read_file", "write_file", "run_command", "search_files"],
            updateRequired: false,
        },
        {
            _id: "device_desktop",
            appVersion: "1.13.0",
            createdAt: ago(30 * DAY),
            lastSeenAt: ago(3 * DAY),
            name: "Studio desktop",
            platform: "linux",
            toolNames: ["read_file", "run_command"],
            updateRequired: false,
        },
        {
            _id: "device_build",
            createdAt: ago(9 * DAY),
            lastSeenAt: ago(HOUR),
            name: "build-box",
            platform: "linux",
            toolNames: ["run_command"],
            transport: "ssh",
            updateRequired: false,
            viaDeviceId: "device_laptop",
        },
    ] as never),
    lunora(api.devices.functions.listDeviceCalls, [
        {
            _id: "call_1",
            createdAt: ago(5 * HOUR),
            deviceId: "device_laptop",
            deviceName: "Ada's MacBook Pro",
            input: '{"command":"pnpm test"}',
            output: "Tests passed",
            status: "completed",
            taintedBy: [],
            toolName: "run_command",
        },
        {
            _id: "call_2",
            createdAt: ago(2 * DAY),
            deviceId: "device_build",
            deviceName: "build-box",
            input: '{"command":"git pull"}',
            status: "denied",
            taintedBy: [],
            toolName: "run_command",
        },
    ] as never),
];

/** Connectors tab: a catalogue with one connected, one expired and one not yet connected. */
export const connectorFixtures = (): LunoraFixture[] => [
    lunora(api.connectors.user_connectors.listConnectorCatalog, [
        {
            category: "developer",
            configured: true,
            connection: {
                accountLabel: "ada-lovelace",
                connectedAt: ago(20 * DAY),
                connectorDefinitionId: "def_github",
                hasRefreshToken: true,
                id: "conn_github",
                scopes: ["repo", "read:user"],
                status: "connected",
            },
            description: "Read repositories, issues and pull requests.",
            docsUrl: "https://docs.github.com",
            icon: "github",
            id: "def_github",
            isPremium: false,
            name: "GitHub",
            requestedScopes: ["repo", "read:user"],
            requiresOAuth: true,
            slug: "github",
            status: "active",
        },
        {
            category: "productivity",
            configured: true,
            connection: {
                accountLabel: "ada@neore.test",
                connectedAt: ago(90 * DAY),
                connectorDefinitionId: "def_gmail",
                hasRefreshToken: false,
                id: "conn_gmail",
                lastError: "The access token expired.",
                scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
                status: "expired",
                tokenExpiresAt: ago(2 * DAY),
            },
            description: "Search and read your email.",
            icon: "gmail",
            id: "def_gmail",
            isPremium: false,
            name: "Gmail",
            requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
            requiresOAuth: true,
            slug: "gmail",
            status: "active",
        },
        {
            category: "productivity",
            configured: true,
            connection: null,
            description: "Search and edit pages in your workspace.",
            icon: "notion",
            id: "def_notion",
            isPremium: true,
            name: "Notion",
            requestedScopes: ["read_content", "update_content"],
            requiresOAuth: true,
            slug: "notion",
            status: "beta",
        },
        {
            category: "communication",
            configured: false,
            connection: null,
            description: "Post and read messages in your channels.",
            icon: "slack",
            id: "def_slack",
            isPremium: false,
            name: "Slack",
            requestedScopes: [],
            requiresOAuth: true,
            slug: "slack",
            status: "active",
        },
    ] as never),
];

/** Messenger tab: Telegram connected and paired, Slack paused, the rest not connected. */
export const messengerFixtures = (): LunoraFixture[] => [
    lunora(api.messenger.functions.getConnections, [
        {
            _creationTime: ago(10 * DAY),
            _id: "messenger_telegram" as Id<"messengerConnections">,
            connectedAt: ago(10 * DAY),
            displayName: "Neore bot",
            lastMessageAt: ago(3 * HOUR),
            metadata: {},
            paired: true,
            pairingCodeExpiresAt: null,
            platform: "telegram",
            platformChatId: null,
            platformUserId: null,
            platformUsername: "neore_ada_bot",
            replyTools: { enabled: true, groups: ["search"] },
            status: "active",
            userId: "user_pro",
        },
        {
            _creationTime: ago(4 * DAY),
            _id: "messenger_slack" as Id<"messengerConnections">,
            connectedAt: ago(4 * DAY),
            displayName: null,
            lastMessageAt: null,
            metadata: {},
            paired: false,
            pairingCodeExpiresAt: null,
            platform: "slack",
            platformChatId: null,
            platformUserId: null,
            platformUsername: null,
            replyTools: { enabled: false, groups: [] },
            status: "paused",
            userId: "user_pro",
        },
    ] as never),
];

/** Privacy tab: a data summary and no export yet. */
export const privacyFixtures = (): LunoraFixture[] => [
    lunora(api.gdpr.functions.getGdprStatus, { deletion: null, export: null } as never),
    lunora(api.gdpr.functions.getDataAccessSummary, {
        dataSummary: { files: 14, gdprRequests: 0, hasSettings: true, prompts: 6 },
        profile: { createdAt: Date.parse(CREATED_AT), email: "pro@neore.test", emailVerified: true, name: "Ada Lovelace" },
    } as never),
];

/** Billing tab: a Pro personal plan. */
export const billingFixtures = (): LunoraFixture[] => [lunora(api.billing.checkout.getMyPlan, { baseTier: "pro", creemCustomerId: "cust_storybook" } as never)];

/** Organizations, members, invitations and teams for the `org-member` persona; `billingOwner` lets that persona edit the billing settings. */
export const organizationFixtures = ({ billingOwner = false }: { billingOwner?: boolean } = {}): LunoraFixture[] => [
    lunora(api.auth.organization.listUserInvitations, [
        {
            expiresAt: ago(-5 * DAY),
            id: "inv_1",
            inviterName: "Grace Hopper",
            organizationName: "Northwind Labs",
            organizationSlug: "northwind",
            role: "member",
        },
    ]),
    lunora(api.auth.team.listTeams, [
        { createdAt: ago(40 * DAY), id: "team_research", memberCount: 4, name: "Research", updatedAt: ago(2 * DAY) },
        { createdAt: ago(20 * DAY), id: "team_platform", memberCount: 2, name: "Platform", updatedAt: ago(1 * DAY) },
    ] as never),
    lunora(api.auth.billing.getBillingInfo, {
        allowedModels: ["claude-sonnet-4-5", "gpt-5"],
        baseTier: "pro",
        billingEmail: "billing@acme.test",
        creditsPerUser: 500,
        creemCustomerId: null,
        creemSubscriptionId: null,
        isOwner: billingOwner,
    } as never),
];

/** better-auth REST lists the account and security tabs read: sessions, linked accounts, device sessions, passkeys. */
export const authListHandlers = (): HttpHandler[] => [
    http.get("*/api/auth/list-accounts", () =>
        HttpResponse.json([
            {
                accountId: "user-pro",
                createdAt: CREATED_AT,
                id: "account-credential",
                providerId: "credential",
                scopes: [],
                updatedAt: CREATED_AT,
                userId: "user_pro",
            },
        ]),
    ),
    http.get("*/api/auth/list-sessions", () =>
        HttpResponse.json([
            {
                createdAt: new Date(ago(2 * HOUR)).toISOString(),
                expiresAt: "2099-01-01T00:00:00.000Z",
                id: "session_pro",
                ipAddress: "203.0.113.7",
                token: "storybook-pro",
                updatedAt: new Date(ago(5 * 60 * 1000)).toISOString(),
                userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                userId: "user_pro",
            },
            {
                createdAt: new Date(ago(6 * DAY)).toISOString(),
                expiresAt: "2099-01-01T00:00:00.000Z",
                id: "session_phone",
                ipAddress: "198.51.100.23",
                token: "storybook-phone",
                updatedAt: new Date(ago(1 * DAY)).toISOString(),
                userAgent:
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
                userId: "user_pro",
            },
        ]),
    ),
];

/** The active organization with a fuller roster and a pending invitation than the shared session handler has. */
export const organizationHandlers = (): HttpHandler[] => [
    http.get("*/api/auth/organization/get-full-organization", () => {
        const member = (id: string, role: string, name: string, email: string, createdDaysAgo: number) => {
            return {
                createdAt: new Date(ago(createdDaysAgo * DAY)).toISOString(),
                id: `member_${id}`,
                organizationId: ORGANIZATION.id,
                role,
                user: { email, id: `user_${id}`, image: null, name },
                userId: `user_${id}`,
            };
        };

        return HttpResponse.json({
            ...ORGANIZATION,
            createdAt: CREATED_AT,
            invitations: [
                {
                    email: "margaret@acme.test",
                    expiresAt: new Date(ago(-6 * DAY)).toISOString(),
                    id: "invitation_margaret",
                    inviterId: "user_owner",
                    organizationId: ORGANIZATION.id,
                    role: "member",
                    status: "pending",
                },
            ],
            members: [
                member("owner", "owner", "Katherine Johnson", "katherine@acme.test", 120),
                member("org-member", "admin", "Alan Turing", "org-member@neore.test", 90),
                member("dorothy", "member", "Dorothy Vaughan", "dorothy@acme.test", 40),
                member("mary", "member", "Mary Jackson", "mary@acme.test", 12),
            ],
        });
    }),
];
