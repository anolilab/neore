import { shareLinkBucket } from "./rate-limiter";
import { createDbStore, RateLimiter } from "lunorash/ratelimit";
import { describe, expect, it } from "vitest";

import { getRateLimitKey, getUserTier, RATE_LIMIT_CONFIGS } from "./rate-limiter";
import { compareStrings } from "./collections";

describe("getUserTier", () => {
    it("should return 'public' for null user", () => {
        expect(getUserTier(null)).toBe("public");
    });

    it("should return 'premium' for admin users", () => {
        expect(getUserTier({ isAdmin: true })).toBe("premium");
    });

    it("should return 'premium' for users with a plan", () => {
        expect(getUserTier({ plan: "pro" as any })).toBe("premium");
    });

    it("should return 'premium' when both admin and plan are set", () => {
        expect(getUserTier({ isAdmin: true, plan: "pro" as any })).toBe("premium");
    });

    it("should return 'free' for regular users without plan", () => {
        expect(getUserTier({})).toBe("free");
        expect(getUserTier({ isAdmin: false })).toBe("free");
    });
});

describe("getRateLimitKey", () => {
    it("should append tier suffix for operation-specific keys", () => {
        expect(getRateLimitKey("chat/message", "free")).toBe("chat/message:free");
        expect(getRateLimitKey("chat/message", "premium")).toBe("chat/message:premium");
        expect(getRateLimitKey("auth/failure", "public")).toBe("auth/failure:public");
    });

    it("should return base key unchanged for general limits", () => {
        expect(getRateLimitKey("free", "free")).toBe("free");
        expect(getRateLimitKey("premium", "premium")).toBe("premium");
        expect(getRateLimitKey("public", "public")).toBe("public");
        expect(getRateLimitKey("scraper", "free")).toBe("scraper");
        expect(getRateLimitKey("vercel", "premium")).toBe("vercel");
    });

    it("should work for all tier types", () => {
        const tiers = ["free", "premium", "public"] as const;

        for (const tier of tiers) {
            const key = getRateLimitKey("organization/create", tier);

            expect(key).toBe(`organization/create:${tier}`);
        }
    });
});

describe("RATE_LIMIT_CONFIGS", () => {
    // `@lunora/ratelimit` validates a config when the limiter is built, per
    // request — `shards` passed every typecheck and then failed every call.
    it("every config is accepted by @lunora/ratelimit", () => {
        const store = createDbStore({ db: {} as never });

        for (const [name, config] of Object.entries(RATE_LIMIT_CONFIGS)) {
            expect(() => new RateLimiter({ config: { [name]: config }, store }), name).not.toThrow();
        }
    });

    it("should have configs for all base tiers", () => {
        expect(RATE_LIMIT_CONFIGS.free).toBeDefined();
        expect(RATE_LIMIT_CONFIGS.premium).toBeDefined();
        expect(RATE_LIMIT_CONFIGS.public).toBeDefined();
    });

    it("should have tiered configs for chat operations", () => {
        expect(RATE_LIMIT_CONFIGS["chat/message:free"]).toBeDefined();
        expect(RATE_LIMIT_CONFIGS["chat/message:premium"]).toBeDefined();
        expect(RATE_LIMIT_CONFIGS["chat/message:public"]).toBeDefined();
    });

    it("should have tiered configs for auth operations", () => {
        expect(RATE_LIMIT_CONFIGS["auth/failure:free"]).toBeDefined();
        expect(RATE_LIMIT_CONFIGS["auth/failure:premium"]).toBeDefined();
        expect(RATE_LIMIT_CONFIGS["auth/failure:public"]).toBeDefined();
    });

    /**
     * The previous version of this test listed six operations by hand. That is
     * why it passed while `skills/create`, `skills/update`, `skills/delete`,
     * `skills/invoke` and `workflow/execute` were absent from the table
     * entirely — every one of those threw `Unknown rate limit config` on every
     * call. A hand-maintained list cannot catch a MISSING entry, because the
     * entry is missing from the list too.
     *
     * So enumerate instead. A base name that exists for one tier but not the
     * other is a limit that works for half the userbase and 500s for the rest,
     * and `getRateLimitKey` builds that key at runtime where no type sees it.
     */
    it("every tiered limit covers both tiers an authenticated caller can produce", () => {
        const tiers = new Map<string, Set<string>>();

        for (const key of Object.keys(RATE_LIMIT_CONFIGS)) {
            const separator = key.lastIndexOf(":");

            if (separator === -1) {
                continue;
            }

            const base = key.slice(0, separator);

            tiers.set(base, (tiers.get(base) ?? new Set()).add(key.slice(separator + 1)));
        }

        expect(tiers.size).toBeGreaterThan(60);

        const incomplete = [...tiers]
            .filter(([, present]) => !present.has("free") || !present.has("premium"))
            .map(([base, present]) => `${base} has only [${[...present].toSorted(compareStrings).join(", ")}]`);

        expect(incomplete).toEqual([]);
    });

    /**
     * `getUserTier(null)` returns `"public"`, but only seven bases define a
     * `:public` variant — so `getRateLimitKey("chat/create", "public")` names a
     * key that does not exist, and an anonymous call to it fails with
     * `Unknown rate limit config`. Most `rateLimit()` call sites sit on
     * `authMutation` / `authAction`, where the user is never null. The bases
     * listed here are the ones an unauthenticated (or user-less bare-builder)
     * caller can reach. Inventing `:public` limits for the rest would be guessing
     * at policy; a new public call site adds its base here alongside its entry.
     */
    it("documents which limits are reachable by an unauthenticated caller", () => {
        const publicBases = Object.keys(RATE_LIMIT_CONFIGS)
            .filter((key) => key.endsWith(":public"))
            .map((key) => key.slice(0, -":public".length))
            .toSorted(compareStrings);

        expect(publicBases).toEqual([
            "api/usage",
            "auth/failure",
            "browser/action",
            "changelog/read",
            "chat/message",
            "chat/promptImprovement",
            "messenger/inbound",
            "sandbox/execute",
            "share/view",
        ]);
    });

    it("premium limits should be higher than free limits", () => {
        // Token bucket configs have a 'rate' property; fixed window configs have a 'limit' property
        // Both are ResolvedAlgorithm objects from the rate limiter
        const freeConfig = RATE_LIMIT_CONFIGS["chat/create:free"] as any;
        const premiumConfig = RATE_LIMIT_CONFIGS["chat/create:premium"] as any;

        // The limit/rate for premium should be >= free
        const freeLimit = freeConfig.limit ?? freeConfig.rate ?? 0;
        const premiumLimit = premiumConfig.limit ?? premiumConfig.rate ?? 0;

        expect(premiumLimit).toBeGreaterThanOrEqual(freeLimit);
    });
});

describe("shareLinkBucket", () => {
    it("names a share link without storing its token", async () => {
        expect.assertions(2);

        const bucket = await shareLinkBucket("secret-share-token-abc");

        expect(bucket).toMatch(/^share:[0-9a-f]{64}$/u);
        expect(bucket).not.toContain("secret-share-token");
    });

    it("is stable for one token and distinct across tokens", async () => {
        expect.assertions(2);

        expect(await shareLinkBucket("token-a")).toBe(await shareLinkBucket("token-a"));
        expect(await shareLinkBucket("token-a")).not.toBe(await shareLinkBucket("token-b"));
    });
});
