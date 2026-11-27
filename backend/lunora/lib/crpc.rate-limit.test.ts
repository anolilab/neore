import { describe, expect, it, vi } from "vitest";

import { rateLimit } from "./crpc";
import { getUserTier } from "./rate-limiter";

const guard = vi.hoisted(() => vi.fn((_context: unknown) => Promise.resolve()));

vi.mock("./rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./rate-limiter")>()),
        rateLimitGuard: guard,
    };
});

/** The user the middleware handed to the guard on its last call. */
const guardedUser = (): Parameters<typeof getUserTier>[0] => {
    const [context] = guard.mock.calls.at(-1) ?? [];

    return (context as { user: Parameters<typeof getUserTier>[0] }).user;
};

describe("rateLimit middleware", () => {
    it("hands the admin flag to the guard, so an admin without a plan is counted as premium", async () => {
        guard.mockClear();
        const next = vi.fn(() => Promise.resolve("done"));
        const ctx = { user: { email: "admin@example.com", isAdmin: true, name: "admin", userId: "admin-1" } };

        const result = await rateLimit("connectors/access")({ ctx, next } as never);

        expect(result).toBe("done");
        expect(guard).toHaveBeenCalledTimes(1);
        expect(getUserTier(guardedUser())).toBe("premium");
    });

    it("counts a signed-in user without admin or plan as free", async () => {
        guard.mockClear();
        const ctx = { user: { email: "user@example.com", isAdmin: false, name: "user", userId: "user-1" } };

        await rateLimit("connectors/access")({ ctx, next: () => Promise.resolve() } as never);

        expect(getUserTier(guardedUser())).toBe("free");
    });
});
