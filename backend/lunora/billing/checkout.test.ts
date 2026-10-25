/**
 * Who may start a checkout and open the customer portal.
 *
 * The handlers run directly against a hand-built action context: `ctx.payments`
 * (the Creem adapter) is a recording fake, `ctx.runQuery` answers the billing
 * subject from a map, and the session is whatever the test sets. Nothing here
 * reaches Creem.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
    return {
        CREEM_API_KEY: "creem_key",
        CREEM_PRODUCT_PRO: "prod_pro",
        CREEM_PRODUCT_PRO_YEARLY: "prod_pro_year",
        CREEM_PRODUCT_TEAM: "prod_team",
        CREEM_PRODUCT_TEAM_YEARLY: "",
        CREEM_YEARLY_CHECKOUT: "",
        SITE_URL: "https://app.example.com/",
    };
});

// Getters, so a test can flip a variable after the module has imported it.
vi.mock("../env", async (importOriginal) => {
    const original = await importOriginal<typeof import("../env")>();

    return Object.defineProperties(
        { ...original },
        Object.fromEntries(Object.keys(env).map((key) => [key, { enumerable: true, get: () => env[key as keyof typeof env] }])),
    );
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

const { createCheckout, openCustomerPortal } = await import("./checkout");

interface Subject {
    baseTier: "enterprise" | "free" | "pro";
    creemCustomerId: string | null;
    creemPurchaserId: string | null;
    creemSubscriptionId: string | null;
    exists: boolean;
    isAnonymous: boolean;
    seats: number;
}

const subject = (overrides: Partial<Subject> = {}): Subject => {
    return {
        baseTier: "free",
        creemCustomerId: null,
        creemPurchaserId: null,
        creemSubscriptionId: null,
        exists: true,
        isAnonymous: false,
        seats: 1,
        ...overrides,
    };
};

const OWNER = "user-owner";
const OTHER_OWNER = "user-other-owner";
const ORG = "org-1";

const sessionOf = (userId: string, activeOrganization: { id: string; role: string } | null = null) => {
    return { activeOrganization, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, userId };
};

const subjects = new Map<string, Subject>();
const createCheckoutSession = vi.fn(async (_input: Record<string, unknown>) => {
    return { url: "https://checkout.example.com/c1" };
});
const createPortalSession = vi.fn(async (_input: Record<string, unknown>) => {
    return { url: "https://portal.example.com/p1" };
});

const context = (userId: string) => {
    return {
        auth: { getIdentity: async () => null, userId },
        db: {},
        log: { event: vi.fn() },
        payments: { adapter: { createCheckout: createCheckoutSession, createPortalSession } },
        runQuery: vi.fn(async (_reference: unknown, { id, kind }: { id: string; kind: string }) => subjects.get(`${kind}:${id}`) ?? subject({ exists: false })),
    };
};

type Handler = (ctx: object, args: object) => Promise<unknown>;

const checkout = async (userId: string, args: { interval?: "month" | "year"; plan: "pro" | "team" }) =>
    await (createCheckout as unknown as { handler: Handler }).handler(context(userId), args);

const portal = async (userId: string, args: { subject: "organization" | "user" }) =>
    await (openCustomerPortal as unknown as { handler: Handler }).handler(context(userId), args);

beforeEach(() => {
    subjects.clear();
    createCheckoutSession.mockClear();
    createPortalSession.mockClear();
    env.CREEM_API_KEY = "creem_key";
    env.CREEM_YEARLY_CHECKOUT = "";
    env.CREEM_PRODUCT_TEAM_YEARLY = "";
    session.current = sessionOf(OWNER);
});

describe("createCheckout", () => {
    it("starts a Pro checkout for the caller, on their own user id", async () => {
        subjects.set(`user:${OWNER}`, subject());

        await expect(checkout(OWNER, { plan: "pro" })).resolves.toStrictEqual({ url: "https://checkout.example.com/c1" });

        expect(createCheckoutSession).toHaveBeenCalledExactlyOnceWith({
            metadata: { purchaserId: OWNER },
            mode: "subscription",
            priceId: "prod_pro",
            quantity: 1,
            referenceId: OWNER,
            successUrl: "https://app.example.com/chat?settings=true&settingsTab=auth-billing",
        });
    });

    it("starts a Team checkout for the active organization, one seat per member", async () => {
        session.current = sessionOf(OWNER, { id: ORG, role: "owner" });
        subjects.set(`organization:${ORG}`, subject({ seats: 4 }));

        await checkout(OWNER, { plan: "team" });

        expect(createCheckoutSession).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ metadata: { purchaserId: OWNER }, priceId: "prod_team", quantity: 4, referenceId: ORG }),
        );
    });

    it.each(["admin", "member"])("refuses a Team checkout to an organization %s", async (role) => {
        session.current = sessionOf(OWNER, { id: ORG, role });
        subjects.set(`organization:${ORG}`, subject());

        await expect(checkout(OWNER, { plan: "team" })).rejects.toMatchObject({ code: "FORBIDDEN" });

        expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("refuses a Team checkout with no active organization", async () => {
        await expect(checkout(OWNER, { plan: "team" })).rejects.toMatchObject({ code: "FORBIDDEN" });

        expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("refuses a guest account", async () => {
        subjects.set(`user:${OWNER}`, subject({ isAnonymous: true }));

        await expect(checkout(OWNER, { plan: "pro" })).rejects.toMatchObject({ code: "FORBIDDEN" });

        expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("refuses a subject that does not exist", async () => {
        await expect(checkout(OWNER, { plan: "pro" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it.each(["pro", "enterprise"] as const)("refuses a subject already on %s", async (baseTier) => {
        subjects.set(`user:${OWNER}`, subject({ baseTier }));

        await expect(checkout(OWNER, { plan: "pro" })).rejects.toMatchObject({ code: "CONFLICT" });

        expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("refuses a plan whose product is not configured", async () => {
        subjects.set(`user:${OWNER}`, subject());
        env.CREEM_PRODUCT_PRO = "";

        try {
            await expect(checkout(OWNER, { plan: "pro" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
        } finally {
            env.CREEM_PRODUCT_PRO = "prod_pro";
        }

        expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("refuses everything while Creem has no API key", async () => {
        subjects.set(`user:${OWNER}`, subject());
        env.CREEM_API_KEY = "";

        await expect(checkout(OWNER, { plan: "pro" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    });

    it("refuses a yearly checkout while the yearly gate is off", async () => {
        subjects.set(`user:${OWNER}`, subject());

        await expect(checkout(OWNER, { interval: "year", plan: "pro" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });

        expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("refuses a yearly checkout for a plan with no yearly product, even with the gate on", async () => {
        subjects.set(`user:${OWNER}`, subject());
        env.CREEM_YEARLY_CHECKOUT = "true";

        await expect(checkout(OWNER, { interval: "year", plan: "team" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    });

    it("sells the yearly product once the gate is on", async () => {
        subjects.set(`user:${OWNER}`, subject());
        env.CREEM_YEARLY_CHECKOUT = "true";

        await checkout(OWNER, { interval: "year", plan: "pro" });

        expect(createCheckoutSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ priceId: "prod_pro_year", referenceId: OWNER }));
    });
});

describe("createCheckout input", () => {
    const { plan, interval } = (createCheckout as unknown as { args: Record<"interval" | "plan", { parse: (value: unknown) => unknown }> }).args;

    it("accepts only the two paid plans and the two intervals", () => {
        expect(plan.parse("pro")).toBe("pro");
        expect(plan.parse("team")).toBe("team");
        expect(interval.parse("year")).toBe("year");
    });

    it.each(["enterprise", "free", "", "PRO"])("refuses the unknown plan %j before any handler runs", (value) => {
        expect(() => plan.parse(value)).toThrow();
    });

    it("refuses an unknown interval", () => {
        expect(() => interval.parse("week")).toThrow();
    });
});

describe("openCustomerPortal", () => {
    it("opens the caller's own Pro portal on their Creem customer", async () => {
        subjects.set(`user:${OWNER}`, subject({ baseTier: "pro", creemCustomerId: "cus_1", creemPurchaserId: OWNER }));

        await expect(portal(OWNER, { subject: "user" })).resolves.toStrictEqual({ url: "https://portal.example.com/p1" });

        expect(createPortalSession).toHaveBeenCalledExactlyOnceWith({
            customerId: "cus_1",
            referenceId: OWNER,
            returnUrl: "https://app.example.com/chat?settings=true&settingsTab=auth-billing",
        });
    });

    it("never reads another user's row: the id is the caller's, not an argument", async () => {
        subjects.set(`user:${OWNER}`, subject({ creemCustomerId: "cus_mine", creemPurchaserId: OWNER }));
        subjects.set(`user:${OTHER_OWNER}`, subject({ creemCustomerId: "cus_theirs", creemPurchaserId: OTHER_OWNER }));

        await portal(OWNER, { subject: "user" });

        expect(createPortalSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ customerId: "cus_mine", referenceId: OWNER }));
    });

    it("opens a Team portal for the owner who subscribed", async () => {
        session.current = sessionOf(OWNER, { id: ORG, role: "owner" });
        subjects.set(`organization:${ORG}`, subject({ baseTier: "pro", creemCustomerId: "cus_team", creemPurchaserId: OWNER }));

        await portal(OWNER, { subject: "organization" });

        expect(createPortalSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ customerId: "cus_team", referenceId: ORG }));
    });

    it("refuses another owner of the same organization: the customer is the purchaser's own", async () => {
        session.current = sessionOf(OTHER_OWNER, { id: ORG, role: "owner" });
        subjects.set(`organization:${ORG}`, subject({ baseTier: "pro", creemCustomerId: "cus_team", creemPurchaserId: OWNER }));

        await expect(portal(OTHER_OWNER, { subject: "organization" })).rejects.toMatchObject({ code: "FORBIDDEN" });

        expect(createPortalSession).not.toHaveBeenCalled();
    });

    it.each(["admin", "member"])("refuses a Team portal to an organization %s", async (role) => {
        session.current = sessionOf(OWNER, { id: ORG, role });
        subjects.set(`organization:${ORG}`, subject({ creemCustomerId: "cus_team", creemPurchaserId: OWNER }));

        await expect(portal(OWNER, { subject: "organization" })).rejects.toMatchObject({ code: "FORBIDDEN" });

        expect(createPortalSession).not.toHaveBeenCalled();
    });

    it("answers NOT_FOUND when the subject never subscribed", async () => {
        subjects.set(`user:${OWNER}`, subject());

        await expect(portal(OWNER, { subject: "user" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses while Creem has no API key", async () => {
        env.CREEM_API_KEY = "";

        await expect(portal(OWNER, { subject: "user" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    });
});
