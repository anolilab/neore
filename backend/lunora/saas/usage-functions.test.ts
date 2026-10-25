/**
 * The user-facing usage and budget-alert actions: every gateway call is scoped
 * to the signed-in caller (never an id from the arguments), the usage window is
 * clamped to 1-90 days, and a rule is created under the caller's active
 * organization.
 *
 * The gateway client is replaced by recording fakes; the handlers run against a
 * hand-built action context.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_LENGTH } from "../lib/validators";

const gateway = vi.hoisted(() => {
    return {
        createNotificationRule: vi.fn(),
        deleteNotificationRule: vi.fn(),
        getUserUsageFromGateway: vi.fn(),
        listNotificationRules: vi.fn(),
    };
});

vi.mock("../chat/lib/gateway-client", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../chat/lib/gateway-client")>()), ...gateway };
});

const session = vi.hoisted(() => {
    return { current: undefined as unknown };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const fake = async () => session.current;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: fake,
        getSessionUserForQuery: fake,
        getSessionUserForQueryLite: fake,
        getSessionUserWithAnonymous: fake,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

const { createMyNotificationRule, deleteMyNotificationRule, getMyUsage, listMyNotificationRules } = await import("./usage-functions");

const CALLER = "user-caller";
const STRANGER = "user-stranger";

const sessionOf = (activeOrganization: { id: string; role: string } | null = null) => {
    return { activeOrganization, email: "c@example.com", id: CALLER, isAdmin: false, name: "C", userId: CALLER };
};

type Handler = (ctx: object, args: object) => Promise<unknown>;

const call = async (procedure: unknown, args: object): Promise<unknown> =>
    await (procedure as { handler: Handler }).handler({ auth: { getIdentity: async () => null, userId: CALLER }, db: {}, log: { event: vi.fn() } }, args);

const rule = (overrides: object = {}) => {
    return {
        action: "notify",
        createdAt: "2026-01-01T00:00:00Z",
        id: "rule_1",
        isActive: true,
        lastTriggeredAt: null,
        metric: "daily_cost",
        modelFilter: null,
        name: "Budget",
        orgId: null,
        period: "day",
        threshold: 5,
        userId: CALLER,
        ...overrides,
    };
};

beforeEach(() => {
    for (const mock of Object.values(gateway)) {
        mock.mockReset();
    }

    session.current = sessionOf();
    gateway.getUserUsageFromGateway.mockResolvedValue({
        byModel: {},
        dailyBreakdown: [],
        period: "30d",
        totalCompletionTokens: 0,
        totalCostMicrodollars: 0,
        totalPromptTokens: 0,
        totalRequests: 0,
    });
});

describe("getMyUsage", () => {
    it("reads the caller's usage and ignores any user id in the arguments", async () => {
        await call(getMyUsage, { days: 7, userId: STRANGER });

        expect(gateway.getUserUsageFromGateway).toHaveBeenCalledExactlyOnceWith(expect.anything(), CALLER, 7);
    });

    it("defaults to a 30-day window", async () => {
        await call(getMyUsage, {});

        expect(gateway.getUserUsageFromGateway.mock.calls[0]?.[2]).toBe(30);
    });

    it.each([
        [0, 1],
        [-5, 1],
        [1, 1],
        [90, 90],
        [91, 90],
        [10_000, 90],
        [7.9, 7],
    ])("clamps %d days to %d", async (days, expected) => {
        await call(getMyUsage, { days });

        expect(gateway.getUserUsageFromGateway.mock.calls[0]?.[2]).toBe(expected);
    });

    it("returns what the gateway answered", async () => {
        const usage = {
            byModel: { m: { cost: 1, requests: 1, tokens: 2 } },
            dailyBreakdown: [],
            period: "7d",
            totalCompletionTokens: 1,
            totalCostMicrodollars: 5,
            totalPromptTokens: 1,
            totalRequests: 1,
        };

        gateway.getUserUsageFromGateway.mockResolvedValue(usage);

        await expect(call(getMyUsage, { days: 7 })).resolves.toEqual(usage);
    });
});

describe("listMyNotificationRules", () => {
    it("lists the caller's rules only", async () => {
        gateway.listNotificationRules.mockResolvedValue([rule()]);

        await expect(call(listMyNotificationRules, { userId: STRANGER })).resolves.toEqual([rule()]);

        expect(gateway.listNotificationRules).toHaveBeenCalledExactlyOnceWith(expect.anything(), CALLER);
    });
});

describe("createMyNotificationRule", () => {
    beforeEach(() => {
        gateway.createNotificationRule.mockResolvedValue(rule());
    });

    it("creates the rule for the caller with the documented defaults", async () => {
        await call(createMyNotificationRule, { metric: "daily_cost", name: "Budget", threshold: 5 });

        expect(gateway.createNotificationRule).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
            action: "notify",
            metric: "daily_cost",
            modelFilter: undefined,
            name: "Budget",
            orgId: undefined,
            period: "day",
            threshold: 5,
            userId: CALLER,
        });
    });

    it("scopes the rule to the caller's active organization, never one from the arguments", async () => {
        session.current = sessionOf({ id: "org-1", role: "member" });

        await call(createMyNotificationRule, { metric: "request_count", name: "Volume", orgId: "org-other", period: "hour", threshold: 100, userId: STRANGER });

        expect(gateway.createNotificationRule).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            expect.objectContaining({ orgId: "org-1", period: "hour", userId: CALLER }),
        );
    });

    it("keeps the action and model filter it was given", async () => {
        await call(createMyNotificationRule, { action: "notify_and_block", metric: "token_count", modelFilter: "gpt", name: "Cap", threshold: 1 });

        expect(gateway.createNotificationRule).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            expect.objectContaining({ action: "notify_and_block", modelFilter: "gpt" }),
        );
    });
});

describe("deleteMyNotificationRule", () => {
    it("deletes the rule as the caller, so the gateway can refuse another user's", async () => {
        await expect(call(deleteMyNotificationRule, { ruleId: "rule_1", userId: STRANGER })).resolves.toBeNull();

        expect(gateway.deleteNotificationRule).toHaveBeenCalledExactlyOnceWith(expect.anything(), "rule_1", CALLER);
    });

    it("surfaces a gateway refusal instead of reporting success", async () => {
        gateway.deleteNotificationRule.mockRejectedValue(new Error("not found"));

        await expect(call(deleteMyNotificationRule, { ruleId: "rule_9" })).rejects.toThrow("not found");
    });
});

describe("input bounds", () => {
    const argsOf = (procedure: unknown) => (procedure as { args: Record<string, { parse: (value: unknown) => unknown }> }).args;

    it("refuses an over-long rule id, name and model filter", () => {
        expect(() => argsOf(deleteMyNotificationRule).ruleId!.parse("x".repeat(MAX_LENGTH.id + 1))).toThrow();
        expect(() => argsOf(createMyNotificationRule).name!.parse("x".repeat(MAX_LENGTH.short + 1))).toThrow();
        expect(() => argsOf(createMyNotificationRule).modelFilter!.parse("x".repeat(MAX_LENGTH.long + 1))).toThrow();
    });

    it("refuses an unknown metric, period and action", () => {
        expect(() => argsOf(createMyNotificationRule).metric!.parse("gpu_hours")).toThrow();
        expect(() => argsOf(createMyNotificationRule).period!.parse("year")).toThrow();
        expect(() => argsOf(createMyNotificationRule).action!.parse("shutdown")).toThrow();
    });
});
