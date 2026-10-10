/**
 * `AUTH_RATE_LIMIT_CUSTOM_RULES` exempts `/get-session` from better-auth's
 * per-IP limiter and nothing else. These drive better-auth's REAL limiter
 * (`onRequestRateLimit`, reached through `auth.handler`) with the options
 * `@lunora/auth` resolves from ours, so both halves are pinned against the code
 * that enforces them, not against a copy of its rules:
 *
 * - `get-session` never answers 429, however many reads one IP sends;
 * - `/sign-in/*` (anonymous sign-in included) still does after 3 in 10 s;
 * - `@lunora/auth`'s catch-all still limits every other path.
 *
 * Storage is better-auth's in-memory store rather than D1: the RULE lookup is
 * the same whichever store counts, and the store is not what changed.
 */
import { resolveAuthOptions } from "@lunora/auth";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { anonymous } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import { AUTH_RATE_LIMIT_CUSTOM_RULES } from "./auth";

const BASE_URL = "http://localhost:3000";

const buildLimitedAuth = (customRules: typeof AUTH_RATE_LIMIT_CUSTOM_RULES = AUTH_RATE_LIMIT_CUSTOM_RULES) => {
    const resolved = resolveAuthOptions({
        baseURL: BASE_URL,
        database: memoryAdapter({ account: [], rateLimit: [], session: [], user: [], verification: [] }),
        emailAndPassword: { enabled: true },
        plugins: [anonymous()],
        rateLimit: { customRules },
        secret: "a-test-secret-that-is-long-enough-for-lunora-auth",
    });

    return betterAuth({
        ...resolved,
        // Counted in memory for the test; the rules under test are unchanged.
        rateLimit: { ...resolved.rateLimit, enabled: true, storage: "memory" },
    });
};

const ips = { issued: 0 };

/** A fresh client IP per test: better-auth's memory store is module-global and keys on IP + path. */
const nextIp = (): string => {
    ips.issued += 1;

    return `203.0.113.${String(ips.issued)}`;
};

const request = (path: string, ip: string, init: RequestInit = {}): Request =>
    new Request(`${BASE_URL}/api/auth${path}`, {
        ...init,
        headers: { "cf-connecting-ip": ip, "content-type": "application/json", origin: BASE_URL, ...init.headers },
    });

const statuses = async (auth: ReturnType<typeof buildLimitedAuth>, count: number, make: () => Request): Promise<number[]> => {
    const result: number[] = [];

    for (let index = 0; index < count; index += 1) {
        const response = await auth.handler(make());

        result.push(response.status);
        await response.body?.cancel();
    }

    return result;
};

describe("better-auth rate limit rules", () => {
    it("lets our overrides match before @lunora/auth's catch-all", () => {
        const resolved = resolveAuthOptions({ baseURL: BASE_URL, rateLimit: { customRules: AUTH_RATE_LIMIT_CUSTOM_RULES }, secret: "x".repeat(40) });
        const keys = Object.keys(resolved.rateLimit?.customRules ?? {});

        expect(keys[0]).toBe("/get-session");
        expect(keys).toContain("/**");
    });

    it("never answers get-session with 429, well past the default 100-request budget", async () => {
        const auth = buildLimitedAuth();
        const ip = nextIp();

        const result = await statuses(auth, 150, () => request("/get-session", ip));

        expect(result.filter((status) => status === 429)).toHaveLength(0);
    });

    // The control: without the override the same 150 reads DO hit 429, so the test above can fail.
    it("answers get-session with 429 after 100 reads when the override is absent", async () => {
        const auth = buildLimitedAuth({});
        const ip = nextIp();

        const result = await statuses(auth, 150, () => request("/get-session", ip));

        expect(result.indexOf(429)).toBe(100);
    });

    it("still limits anonymous sign-in to 3 per 10 s", async () => {
        const auth = buildLimitedAuth();
        const ip = nextIp();

        const result = await statuses(auth, 5, () => request("/sign-in/anonymous", ip, { body: "{}", method: "POST" }));

        expect(result.slice(0, 3)).not.toContain(429);
        expect(result.slice(3)).toStrictEqual([429, 429]);
    });

    it("still limits email sign-in to 3 per 10 s and names the wait", async () => {
        const auth = buildLimitedAuth();
        const ip = nextIp();
        const signIn = () =>
            request("/sign-in/email", ip, { body: JSON.stringify({ email: "nobody@example.com", password: crypto.randomUUID() }), method: "POST" });

        await statuses(auth, 3, signIn);

        const limited = await auth.handler(signIn());

        expect(limited.status).toBe(429);
        // The web client's retry honours this header (`apps/web/src/lib/auth/session-read.ts`).
        expect(Number(limited.headers.get("X-Retry-After"))).toBeGreaterThan(0);
    });

    it("keeps the catch-all limit on every other path", async () => {
        const auth = buildLimitedAuth();
        const ip = nextIp();

        const result = await statuses(auth, 101, () => request("/ok", ip));

        expect(result.at(-1)).toBe(429);
    });
});
