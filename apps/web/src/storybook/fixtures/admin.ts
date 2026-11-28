import { api } from "@neore/backend/api";

import { ago, DAY, HOUR, MINUTE, STORY_NOW } from "../clock";
import type { LunoraFixture } from "../lunora";
import { lunora } from "../lunora";

const day = (offset: number): string => new Date(STORY_NOW - offset * DAY).toISOString().slice(0, 10);

const USERS = [
    {
        _creationTime: ago(3 * HOUR),
        _id: "user_1",
        email: "ada@example.com",
        image: null,
        isAdmin: false,
        isAnonymous: false,
        isBanned: false,
        name: "Ada Lovelace",
    },
    {
        _creationTime: ago(9 * HOUR),
        _id: "user_2",
        email: "grace@example.com",
        image: null,
        isAdmin: true,
        isAnonymous: false,
        isBanned: false,
        name: "Grace Hopper",
    },
    {
        _creationTime: ago(DAY),
        _id: "user_3",
        email: "guest-7f3a@anonymous.neore.test",
        image: null,
        isAdmin: false,
        isAnonymous: true,
        isBanned: false,
        name: null,
    },
    {
        _creationTime: ago(3 * DAY),
        _id: "user_4",
        banReason: "Spam",
        email: "sam@example.com",
        image: null,
        isAdmin: false,
        isAnonymous: false,
        isBanned: true,
        name: "Sam Rivera",
    },
    {
        _creationTime: ago(6 * DAY),
        _id: "user_5",
        email: "alan@example.com",
        image: null,
        isAdmin: false,
        isAnonymous: false,
        isBanned: false,
        name: "Alan Turing",
    },
] as const;

const GROWTH = [3, 5, 2, 8, 6, 4, 7];

const growth = (scale: number) => GROWTH.map((count, index) => ({ count: Math.round(count * scale), date: day(6 - index) }));

const AUDIT_LOGS = [
    { action: "user.ban", adminEmail: "grace@example.com", details: JSON.stringify({ reason: "Spam" }), targetUserEmail: "sam@example.com", ago: 20 * MINUTE },
    {
        action: "user.role.update",
        adminEmail: "grace@example.com",
        details: JSON.stringify({ newRole: "admin" }),
        targetUserEmail: "ada@example.com",
        ago: 2 * HOUR,
    },
    { action: "user.impersonate.start", adminEmail: "grace@example.com", targetUserEmail: "alan@example.com", ago: 5 * HOUR },
    { action: "user.impersonate.stop", adminEmail: "grace@example.com", targetUserEmail: "alan@example.com", ago: 5 * HOUR - 8 * MINUTE },
    { action: "user.sessions.revoke", adminEmail: "ada@example.com", targetUserEmail: "sam@example.com", ago: DAY },
    { action: "admin.grant", adminEmail: "grace@example.com", targetUserEmail: "ada@example.com", ago: 2 * DAY },
    { action: "user.unban", adminEmail: "ada@example.com", targetUserEmail: "alan@example.com", ago: 4 * DAY },
] as const;

/** One breakdown entry; the scan's counts for a group and age band. */
const band = (group: "active" | "archived" | "other" | "pinned", sinceDays: number, threads: number) => {
    return {
        approxBytes: threads * 180_000,
        group,
        largeToolBytes: threads * 20_000,
        largeToolRows: Math.round(threads / 10),
        messageRows: threads * 24,
        sinceDays,
        threads,
        toolBytes: threads * 60_000,
    };
};

const QUARTERS = Array.from({ length: 96 }, (_, index) => {
    const promptTokens = 40_000 + ((index * 7919) % 30_000);

    return {
        cachedTokens: Math.round(promptTokens * (0.55 + ((index * 31) % 30) / 100)),
        promptTokens,
        requests: 120 + ((index * 13) % 60),
        start: new Date(STORY_NOW - (96 - index) * 15 * MINUTE).toISOString(),
    };
});

const FEEDBACK = [
    {
        _id: "feedback_1",
        createdAt: ago(2 * HOUR),
        images: [],
        kind: "problem",
        message: "The model picker closes as soon as I scroll inside it.",
        pagePath: "/chat/thread-1",
        sender: { email: "ada@example.com", image: null, name: "Ada Lovelace", userId: "user_1" },
    },
    {
        _id: "feedback_2",
        createdAt: ago(DAY),
        images: [],
        kind: "idea",
        message: "Let me pin a project to the top of the sidebar.",
        pagePath: null,
        sender: { email: "alan@example.com", image: null, name: "Alan Turing", userId: "user_5" },
    },
    {
        _id: "feedback_3",
        createdAt: ago(3 * DAY),
        images: [],
        kind: "other",
        message: "Thanks for the new look, the composer feels much calmer.",
        pagePath: "/chat",
        sender: { email: null, image: null, name: null, userId: "user_gone" },
    },
] as const;

export interface AdminFixtureOptions {
    /** Gateway analytics for the period; `false` leaves it empty. */
    gateway?: boolean;
}

/**
 * What the admin pages read: the dashboard, user list, audit log, cleanup, feedback, gateway
 * analytics and the provider cache readings. Spread after `userFixtures()`; the admin persona is what the route's layout needs.
 */
export const adminFixtures = (options: AdminFixtureOptions = {}): LunoraFixture[] => [
    lunora(api.auth.admin.getDashboardStats, {
        recentUsers: USERS.map(({ _creationTime, _id, email, image, isAnonymous, name }) => {
            return { _creationTime, _id, email, image, isAnonymous, name };
        }),
        totalAdmins: 3,
        totalAnonymousUsers: 412,
        totalBannedUsers: 2,
        totalRegularUsers: 1284,
        totalUsers: 1696,
        userGrowth: { all: growth(1), anonymous: growth(0.6), regular: growth(0.4) },
    }),
    lunora(api.auth.admin.getAllUsers, ({ role, search, userType }) => {
        const matches = USERS.filter((user) => {
            return (
                (role !== "admin" || user.isAdmin) &&
                (role !== "user" || !user.isAdmin) &&
                (userType !== "anonymous" || user.isAnonymous) &&
                (userType !== "user" || !user.isAnonymous) &&
                (!search || user.email.includes(search.toLowerCase()) || (user.name?.toLowerCase().includes(search.toLowerCase()) ?? false))
            );
        });

        return { continueCursor: "next", isDone: false, page: matches.map((user) => ({ ...user })) };
    }),
    lunora(api.admin.audit_log.getAuditLogs, ({ action }) => {
        const rows = AUDIT_LOGS.filter((entry) => action === undefined || entry.action === action);

        return {
            continueCursor: null,
            isDone: true,
            logs: rows.map((entry, index) => {
                return {
                    _creationTime: ago(entry.ago),
                    _id: `audit_${index}`,
                    action: entry.action,
                    adminEmail: entry.adminEmail,
                    adminId: "user_admin",
                    details: "details" in entry ? entry.details : null,
                    targetUserEmail: entry.targetUserEmail,
                    targetUserId: "user_target",
                    timestamp: ago(entry.ago),
                };
            }),
        };
    }),
    lunora(api.admin.cleanup.getCleanupConfig, { batchSize: 100, isEnabled: true, thresholdDays: 30 }),
    lunora(api.admin.cleanup.previewCleanup, { eligibleCount: 37, thresholdDays: 30 }),
    lunora(api.admin.cleanup.listCleanupLogs, {
        continueCursor: null,
        isDone: true,
        logs: [
            {
                _creationTime: ago(DAY),
                _id: "log_1",
                deletedCount: 41,
                durationMs: 1830,
                eligibleCount: 41,
                mode: "execute",
                runAt: ago(DAY),
                triggeredBy: "scheduled",
            },
            {
                _creationTime: ago(2 * DAY),
                _id: "log_2",
                deletedCount: 0,
                durationMs: 420,
                eligibleCount: 52,
                mode: "dry_run",
                runAt: ago(2 * DAY),
                triggeredBy: "grace@example.com",
            },
            {
                _creationTime: ago(8 * DAY),
                _id: "log_3",
                deletedCount: 38,
                durationMs: 1610,
                eligibleCount: 38,
                mode: "execute",
                runAt: ago(8 * DAY),
                triggeredBy: "scheduled",
            },
        ],
    }),
    lunora(api.admin.cleanup.getShardFootprint, {
        abandonedShards: 0,
        approxBytes: 2_480_000_000,
        breakdown: [
            band("active", 0, 5400),
            band("active", 3, 2100),
            band("active", 7, 1500),
            band("active", 14, 900),
            band("active", 30, 1200),
            band("archived", 0, 800),
            band("archived", 30, 450),
            band("archived", 90, 220),
            band("archived", 365, 60),
            band("pinned", 0, 140),
            band("other", 0, 95),
        ],
        continueCursor: null,
        incompleteShards: 0,
        isDone: true,
        largestShardBytes: [310_000_000, 240_000_000, 180_000_000],
        largestThreadRows: [4210, 3180, 2750, 1900],
        messageRows: 328_000,
        pendingShards: 0,
        shards: 64,
        threads: 12_865,
    }),
    lunora(api.admin.gateway_analytics.getGatewayAnalytics, ({ period }) => {
        const empty = options.gateway === false;

        return {
            costTrend: empty
                ? []
                : Array.from({ length: 7 }, (_, index) => ({
                      costMicrodollars: 1_200_000 + ((index * 937_000) % 4_000_000),
                      date: day(6 - index),
                      requestCount: 3000 + index * 410,
                  })),
            modelBreakdown: empty
                ? []
                : [
                      { avgLatencyMs: 1420, costMicrodollars: 9_400_000, count: 8120, errorCount: 12, modelId: "claude-sonnet-5-5", provider: "anthropic" },
                      { avgLatencyMs: 880, costMicrodollars: 3_100_000, count: 5340, errorCount: 0, modelId: "gpt-5-mini", provider: "openai" },
                      { avgLatencyMs: 2310, costMicrodollars: 1_250_000, count: 640, errorCount: 3, modelId: "gemini-3-pro", provider: "google" },
                  ],
            overview: empty
                ? { avgLatencyMs: 0, cacheHitRate: 0, errorRate: 0, totalCostMicrodollars: 0, totalRequests: 0 }
                : { avgLatencyMs: 1260, cacheHitRate: 0.38, errorRate: 0.0012, totalCostMicrodollars: 13_750_000, totalRequests: 14_100 },
            period: period ?? "24h",
            providerHealth: empty
                ? []
                : [
                      {
                          avgLatency5mMs: 1380,
                          circuitBreakerUntil: null,
                          errorRate5m: 0.002,
                          lastFailureAt: null,
                          lastSuccessAt: new Date(ago(MINUTE)).toISOString(),
                          modelApiId: "claude-sonnet-5-5",
                          provider: "anthropic",
                          status: "healthy",
                      },
                      {
                          avgLatency5mMs: 3100,
                          circuitBreakerUntil: null,
                          errorRate5m: 0.08,
                          lastFailureAt: new Date(ago(3 * MINUTE)).toISOString(),
                          lastSuccessAt: new Date(ago(4 * MINUTE)).toISOString(),
                          modelApiId: "gemini-3-pro",
                          provider: "google",
                          status: "degraded",
                      },
                      {
                          avgLatency5mMs: 0,
                          circuitBreakerUntil: new Date(STORY_NOW + 10 * MINUTE).toISOString(),
                          errorRate5m: 1,
                          lastFailureAt: new Date(ago(MINUTE)).toISOString(),
                          lastSuccessAt: null,
                          modelApiId: "grok-5",
                          provider: "xai",
                          status: "offline",
                      },
                  ],
            tierDistribution: empty
                ? []
                : [
                      { count: 5200, tier: "simple" },
                      { count: 6100, tier: "standard" },
                      { count: 2200, tier: "complex" },
                      { count: 600, tier: "reasoning" },
                  ],
        };
    }),
    lunora(api.feedback.admin.listFeedback, ({ kind }) => {
        return {
            continueCursor: null,
            isDone: true,
            page: FEEDBACK.filter((item) => kind === undefined || item.kind === kind).map((item) => ({ ...item, images: [] })),
        } as never;
    }),
    lunora(api.admin.gateway_analytics.getProviderCacheReadingsForAdmin, ({ days }) => {
        return {
            all: { cachedTokens: 9_800_000, promptTokens: 21_400_000, requests: 17_900 },
            days: days ?? 7,
            models: [
                { cachedTokens: 6_100_000, modelId: "claude-sonnet-5-5", promptTokens: 9_800_000, provider: "anthropic", requests: 8120 },
                { cachedTokens: 2_300_000, modelId: "gpt-5-mini", promptTokens: 6_900_000, provider: "openai", requests: 5340 },
                { cachedTokens: 400_000, modelId: "gemini-3-pro", promptTokens: 2_200_000, provider: "google", requests: 640 },
            ],
            pairs: 3,
            quarters: QUARTERS,
            since: new Date(ago((days ?? 7) * DAY)).toISOString(),
        };
    }),
];
