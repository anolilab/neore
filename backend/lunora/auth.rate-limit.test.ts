/**
 * `AUTH_RATE_LIMIT_CUSTOM_RULES` exempts `/get-session` and `/sign-in-methods`
 * from better-auth's per-IP limiter and nothing else. These drive better-auth's REAL limiter
 * (`onRequestRateLimit`, reached through `auth.handler`) with the options
 * `@lunora/auth` resolves from ours, so both halves are pinned against the code
 * that enforces them, not against a copy of its rules:
 *
 * - `get-session` never answers 429, however many reads one IP sends;
 * - nor does `sign-in-methods`, which the `/sign-in` prefix rule would
 *   otherwise hold to 3 per 10 s;
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
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_RATE_LIMIT_CUSTOM_RULES } from "./auth";
import { cliDeviceAuth } from "./auth/cli-device-auth";

const BASE_URL = "http://localhost:3000";

/**
 * `@lunora/auth` resolves NO trusted client-IP header unless the app sets one, and better-auth then keys every
 * request of a path on one shared bucket (127.0.0.1 under test, "no-trusted-ip" otherwise). These tests need the
 * per-address behaviour they describe, so they name the header the requests carry.
 */
const IP_OPTIONS = { advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } } };

const buildLimitedAuth = (customRules: typeof AUTH_RATE_LIMIT_CUSTOM_RULES = AUTH_RATE_LIMIT_CUSTOM_RULES) => {
    const resolved = resolveAuthOptions({
        baseURL: BASE_URL,
        database: memoryAdapter({ account: [], rateLimit: [], session: [], user: [], verification: [] }),
        emailAndPassword: { enabled: true },
        plugins: [anonymous()],
        rateLimit: { customRules },
        secret: "a-test-secret-that-is-long-enough-for-lunora-auth",
        ...IP_OPTIONS,
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

    // Every chat page reads it to decide between guest chat and the signed-out chat. Under the `/sign-in` prefix rule
    // the 4th read in 10 s from one IP answered 429, which the app reads as invite-only: guests turned away.
    it("never answers sign-in-methods with 429", async () => {
        const auth = buildLimitedAuth();
        const ip = nextIp();

        const result = await statuses(auth, 20, () => request("/sign-in-methods", ip));

        expect(result.filter((status) => status === 429)).toHaveLength(0);
    });

    it("answers sign-in-methods with 429 after 3 reads when the override is absent", async () => {
        const auth = buildLimitedAuth({});
        const ip = nextIp();

        const result = await statuses(auth, 5, () => request("/sign-in-methods", ip));

        expect(result.indexOf(429)).toBe(3);
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

describe("CLI device sign-in rate limits", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const buildDeviceAuth = () => {
        const resolved = resolveAuthOptions({
            baseURL: BASE_URL,
            database: memoryAdapter({ account: [], deviceCode: [], rateLimit: [], session: [], user: [], verification: [] }),
            plugins: [
                ...cliDeviceAuth({
                    mintApiKey: async () => {
                        return { id: "k", key: "nk_x" };
                    },
                }),
            ],
            rateLimit: { customRules: AUTH_RATE_LIMIT_CUSTOM_RULES },
            secret: "a-test-secret-that-is-long-enough-for-lunora-auth",
            ...IP_OPTIONS,
        });

        return betterAuth({ ...resolved, rateLimit: { ...resolved.rateLimit, enabled: true, storage: "memory" } });
    };

    const poll = (ip: string) =>
        request("/device/key", ip, { body: JSON.stringify({ client_id: "neore-cli", device_code: "not-a-real-code" }), method: "POST" });

    it("never limits a CLI polling every 5 seconds for the whole 30 minutes a code lives", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));

        const auth = buildDeviceAuth();
        const ip = nextIp();
        const result: number[] = [];

        for (let index = 0; index < 360; index += 1) {
            const response = await auth.handler(poll(ip));

            result.push(response.status);
            await response.body?.cancel();
            vi.setSystemTime(Date.now() + 5000);
        }

        expect(result.filter((status) => status === 429)).toHaveLength(0);
    }, 120_000);

    it("does not lock out several people polling at once from one shared address", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-03T15:00:00Z"));

        const auth = buildDeviceAuth();
        const ip = nextIp();
        const result: number[] = [];

        // Five people behind one office address, each polling every 5 s, so a request arrives about every second.
        for (let index = 0; index < 360; index += 1) {
            const response = await auth.handler(poll(ip));

            result.push(response.status);
            await response.body?.cancel();
            vi.setSystemTime(Date.now() + 1000);
        }

        expect(result.filter((status) => status === 429)).toHaveLength(0);
    }, 120_000);

    it("gives a headless machine's pairing poll no per-address rule, like the CLI's", () => {
        expect(AUTH_RATE_LIMIT_CUSTOM_RULES["/device/host"]).toBe(false);
    });

    it("lets two people behind one address both get a code and be answered on their polls", async () => {
        const auth = buildDeviceAuth();
        const ip = nextIp();
        const codes = [];

        for (const hostname of ["alice-laptop", "bob-laptop"]) {
            const response = await auth.handler(request("/device/code", ip, { body: JSON.stringify({ client_id: "neore-cli", hostname }), method: "POST" }));

            expect(response.status).toBe(200);
            codes.push((await response.json()) as { device_code: string });
        }

        for (const { device_code: deviceCode } of codes) {
            const response = await auth.handler(
                request("/device/key", ip, { body: JSON.stringify({ client_id: "neore-cli", device_code: deviceCode }), method: "POST" }),
            );

            expect(response.status).toBe(400);
            expect(((await response.json()) as { error: string }).error).toBe("authorization_pending");
        }
    });

    it("limits issuing codes to 60 a minute per address", async () => {
        const auth = buildDeviceAuth();
        const ip = nextIp();
        const result = await statuses(auth, 62, () =>
            request("/device/code", ip, { body: JSON.stringify({ client_id: "neore-cli", hostname: "devbox" }), method: "POST" }),
        );

        expect(result.slice(0, 60).every((status) => status === 200)).toBe(true);
        expect(result.slice(60)).toStrictEqual([429, 429]);
    });

    it("limits deny retries", async () => {
        const auth = buildDeviceAuth();
        const ip = nextIp();
        const deny = await statuses(auth, 12, () => request("/device/deny", ip, { body: JSON.stringify({ userCode: "ABCDEFGH" }), method: "POST" }));

        expect(deny.slice(10)).toStrictEqual([429, 429]);
        expect(deny.slice(0, 10)).not.toContain(429);
    });

    it("limits approve retries", async () => {
        const auth = buildDeviceAuth();
        const ip = nextIp();
        const approve = await statuses(auth, 12, () => request("/device/approve", ip, { body: JSON.stringify({ userCode: "ABCDEFGH" }), method: "POST" }));

        expect(approve.slice(10)).toStrictEqual([429, 429]);
    });
});
