import { beforeEach, describe, expect, it, vi } from "vitest";

import { seedAdminInvitationLinks } from "./invitations";
import { createSeedInvitationsHandler } from "./seed-invitations-http";

/** An in-memory `signUpInvitation` table: email → row, with the token kept in the clear for assertions. */
const store = vi.hoisted(() => {
    return {
        minted: 0,
        rows: new Map<
            string,
            { acceptedAt: Date | null; createdAt: Date; email: string; expiresAt: Date; id: string; invitedBy: string | null; token: string }
        >(),
    };
});

vi.mock("../env", () => {
    return { ADMIN: "Owner@Example.com, second@example.com,owner@example.com", SITE_URL: "https://app.example.com/" };
});

vi.mock("../auth", () => {
    return {
        getAuth: () => {
            return {};
        },
    };
});

vi.mock("@lunora/auth", () => {
    return {
        createSignUpInvitation: async (_auth: unknown, input: { email: string; expiresInSeconds?: number; invitedBy?: string }) => {
            store.minted += 1;

            const row = {
                acceptedAt: null,
                createdAt: new Date(),
                email: input.email,
                expiresAt: new Date(Date.now() + (input.expiresInSeconds ?? 60) * 1000),
                id: input.email,
                invitedBy: input.invitedBy ?? null,
                token: `token-${String(store.minted)}`,
            };

            store.rows.set(input.email, row);

            return row;
        },
        listSignUpInvitations: async () => [...store.rows.values()],
        pruneSignUpInvitations: async () => 0,
        revokeSignUpInvitation: async () => undefined,
    };
});

const TOKEN = "s3cret-admin-token";

const post = (headers: Record<string, string> = {}, query = ""): Request =>
    new Request(`https://backend.example.com/admin/seed-invitations${query}`, { headers, method: "POST" });

const makeHandler = (overrides: Partial<Parameters<typeof createSeedInvitationsHandler>[0]> = {}) => {
    const seed = vi.fn(async () => []);
    const rateLimit = vi.fn(async () => {
        return { ok: true };
    });

    return { handler: createSeedInvitationsHandler({ adminToken: () => TOKEN, rateLimit, seed, ...overrides }), rateLimit, seed };
};

describe("POST /admin/seed-invitations — auth", () => {
    it("answers 401 without a token and never seeds", async () => {
        const { handler, seed } = makeHandler();
        const response = await handler(post());

        expect(response.status).toBe(401);
        expect(seed).not.toHaveBeenCalled();
    });

    it("answers 401 for a wrong token, and for the right token without the Bearer scheme", async () => {
        const { handler, seed } = makeHandler();

        const wrong = await handler(post({ authorization: "Bearer wrong" }));
        const noScheme = await handler(post({ authorization: TOKEN }));

        expect(wrong.status).toBe(401);
        expect(noScheme.status).toBe(401);
        expect(seed).not.toHaveBeenCalled();
    });

    it("fails closed with 503 when LUNORA_ADMIN_TOKEN is unset, even for an empty bearer", async () => {
        const { handler, seed } = makeHandler({ adminToken: () => "" });

        const response = await handler(post({ authorization: "Bearer " }));

        expect(response.status).toBe(503);
        expect(seed).not.toHaveBeenCalled();
    });

    it("charges the rate limit before the token check, so guessing is throttled", async () => {
        const rateLimit = vi.fn(async () => {
            return { ok: false, retryAfter: 90_000 };
        });
        const { handler, seed } = makeHandler({ rateLimit });
        const response = await handler(post({ authorization: `Bearer ${TOKEN}`, "cf-connecting-ip": "203.0.113.9" }));

        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("90");
        expect(rateLimit).toHaveBeenCalledWith("203.0.113.9");
        expect(seed).not.toHaveBeenCalled();
    });

    it("seeds with the right token and passes ?reissue through", async () => {
        const { handler, seed } = makeHandler();

        const response = await handler(post({ authorization: `Bearer ${TOKEN}` }));

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(seed).toHaveBeenLastCalledWith({ reissue: false });

        await handler(post({ authorization: `bearer ${TOKEN}` }, "?reissue=1"));

        expect(seed).toHaveBeenLastCalledWith({ reissue: true });
    });
});

describe("seedAdminInvitationLinks — idempotency", () => {
    beforeEach(() => {
        store.rows.clear();
        store.minted = 0;
    });

    it("issues one link per distinct ADMIN address on the first run", async () => {
        const seeded = await seedAdminInvitationLinks();

        expect(seeded).toStrictEqual([
            { email: "owner@example.com", signUpUrl: "https://app.example.com/auth/sign-up?invite=token-1", status: "issued" },
            { email: "second@example.com", signUpUrl: "https://app.example.com/auth/sign-up?invite=token-2", status: "issued" },
        ]);
    });

    it("does not re-mint on a second run, so the links already sent keep working", async () => {
        await seedAdminInvitationLinks();

        const again = await seedAdminInvitationLinks();

        expect(again).toStrictEqual([
            { email: "owner@example.com", status: "pending" },
            { email: "second@example.com", status: "pending" },
        ]);
        expect(store.minted).toBe(2);
        expect(store.rows.get("owner@example.com")?.token).toBe("token-1");
    });

    it("leaves a spent invitation alone even with reissue, and re-mints only pending ones", async () => {
        await seedAdminInvitationLinks();
        store.rows.get("owner@example.com")!.acceptedAt = new Date();

        const reissued = await seedAdminInvitationLinks({ reissue: true });

        expect(reissued).toStrictEqual([
            { email: "owner@example.com", status: "registered" },
            { email: "second@example.com", signUpUrl: "https://app.example.com/auth/sign-up?invite=token-3", status: "issued" },
        ]);
        expect(store.rows.get("owner@example.com")?.acceptedAt).not.toBeNull();
    });

    it("re-issues an expired invitation without being asked", async () => {
        await seedAdminInvitationLinks();
        store.rows.get("second@example.com")!.expiresAt = new Date(Date.now() - 1000);

        const seeded = await seedAdminInvitationLinks();

        expect(seeded.map((entry) => entry.status)).toStrictEqual(["pending", "issued"]);
    });
});
