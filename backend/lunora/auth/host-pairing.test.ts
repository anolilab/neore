/**
 * A headless machine pairs itself by code (`neore-host pair`), end to end through better-auth's real handler with its
 * in-memory store. The device registration is a recording fake here; `devices/headless-pairing.test.ts` drives the
 * real one on the harness.
 */
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { anonymous } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_KEY_OPTIONS } from "../auth";
import type { ApiKeyAuthApi } from "../public-api/identity";
import { DEFAULT_API_SCOPES } from "../public-api/scopes";
import { MAX_API_KEYS_PER_USER } from "./api-key-limits";
import type { MintedCliKey } from "./cli-device-auth";
import { CLI_CLIENT_ID, cliDeviceAuth, HOST_CLIENT_ID } from "./cli-device-auth";

const BASE_URL = "http://localhost:3000";

const SECRET = "a".repeat(64);

interface Registration {
    codeId: string;
    name: string;
    platform: string;
    userId: string;
}

const build = (options: { precheck?: (userId: string) => Promise<void>; register?: () => Promise<void>; withHostPairing?: boolean } = {}) => {
    const registrations: Registration[] = [];
    const attempts: string[] = [];
    const database = memoryAdapter({ account: [], apikey: [], deviceCode: [], rateLimit: [], session: [], user: [], verification: [] });
    const auth = betterAuth({
        baseURL: BASE_URL,
        database,
        emailAndPassword: { enabled: true },
        plugins: [
            apiKey(API_KEY_OPTIONS),
            anonymous(),
            ...cliDeviceAuth({
                ...(options.withHostPairing !== false && {
                    hostPairing: {
                        precheck: options.precheck ?? (async () => undefined),
                        register: async (input) => {
                            attempts.push(input.codeId);
                            await options.register?.();
                            registrations.push(input);

                            return { deviceId: `device-${String(registrations.length)}`, secret: SECRET };
                        },
                    },
                }),
                mintApiKey: async ({ expiresInSeconds, name, userId }): Promise<MintedCliKey> =>
                    await (auth.api as unknown as ApiKeyAuthApi).createApiKey({
                        body: { expiresIn: expiresInSeconds, name, permissions: DEFAULT_API_SCOPES as Record<string, string[]>, userId },
                    }),
            }),
        ],
        rateLimit: { enabled: false },
        secret: "a-test-secret-that-is-long-enough-for-better-auth",
        telemetry: { enabled: false },
    });

    return { attempts, auth, registrations };
};

type Harness = ReturnType<typeof build>;

const call = async (
    harness: Harness,
    path: string,
    init: { body?: unknown; cookie?: string } = {},
): Promise<{ body: Record<string, unknown>; response: Response }> => {
    const response = await harness.auth.handler(
        new Request(`${BASE_URL}/api/auth${path}`, {
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            headers: { "content-type": "application/json", origin: BASE_URL, ...(init.cookie && { cookie: init.cookie }) },
            method: init.body === undefined ? "GET" : "POST",
        }),
    );
    const text = await response.text();

    return { body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, response };
};

const cookieOf = (response: Response): string =>
    response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";", 1)[0])
        .join("; ");

let counter = 0;

const signUp = async (harness: Harness): Promise<{ cookie: string; userId: string }> => {
    counter += 1;

    const { body, response } = await call(harness, "/sign-up/email", {
        body: { email: `owner${String(counter)}@example.test`, name: "Owner", password: "correct horse battery" },
    });

    expect(response.status).toBe(200);

    return { cookie: cookieOf(response), userId: (body["user"] as { id: string }).id };
};

const guest = async (harness: Harness): Promise<string> => {
    const { response } = await call(harness, "/sign-in/anonymous", { body: {} });

    expect(response.status).toBe(200);

    return cookieOf(response);
};

const hostBody = { client_id: HOST_CLIENT_ID, hostname: "build-box.lan", platform: "linux", storage: "file" };

const requestHostCode = async (harness: Harness, body: Record<string, unknown> = hostBody) => {
    const { body: code, response } = await call(harness, "/device/code", { body });

    expect(response.status).toBe(200);

    return code as { device_code: string; user_code: string };
};

const redeem = async (harness: Harness, deviceCode: string) =>
    await call(harness, "/device/host", { body: { client_id: HOST_CLIENT_ID, device_code: deviceCode } });

const errorOf = async (harness: Harness, deviceCode: string): Promise<unknown> => {
    const { body } = await redeem(harness, deviceCode);

    return body["error"];
};

const statusOf = async (harness: Harness, deviceCode: string): Promise<number> => {
    const { response } = await redeem(harness, deviceCode);

    return response.status;
};

/** What the web page does: open the code while signed in (which claims it), then approve it. */
const approve = async (harness: Harness, cookie: string, userCode: string) => {
    const look = await call(harness, `/device?user_code=${userCode}`, { cookie });

    expect(look.response.status).toBe(200);

    return { approved: await call(harness, "/device/approve", { body: { userCode }, cookie }), look };
};

describe("pairing a headless machine by code", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("registers the machine for the approving account and hands it the secret once", async () => {
        const harness = build();
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        expect(await errorOf(harness, code.device_code)).toBe("authorization_pending");

        const { approved, look } = await approve(harness, owner.cookie, code.user_code);

        // The approval page learns who is asking and where the secret will live, from the code alone.
        expect(look.body).toMatchObject({ client_id: HOST_CLIENT_ID, hostname: "build-box.lan", platform: "linux", status: "pending", storage: "file" });
        expect(approved.response.status).toBe(200);
        // The approval answer carries no secret: the browser never sees one.
        expect(JSON.stringify(approved.body)).not.toContain(SECRET);

        vi.setSystemTime(Date.now() + 6000);

        const redeemed = await redeem(harness, code.device_code);

        expect(redeemed.response.status).toBe(200);
        expect(redeemed.response.headers.get("cache-control")).toBe("no-store");
        expect(redeemed.body).toEqual({
            account: "o***@example.test",
            device_id: "device-1",
            name: "build-box.lan",
            secret: SECRET,
            token_type: "device_secret",
        });
        expect(harness.registrations).toEqual([{ codeId: expect.any(String), name: "build-box.lan", platform: "linux", userId: owner.userId }]);
    });

    it("registers once however many times the code is redeemed", async () => {
        const harness = build();
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        expect(await statusOf(harness, code.device_code)).toBe(200);
        vi.setSystemTime(Date.now() + 6000);

        const again = await redeem(harness, code.device_code);

        expect(again.response.status).toBe(400);
        expect(again.body["error"]).toBe("invalid_grant");
        expect(harness.registrations).toHaveLength(1);
    });

    it("refuses a code that names no platform or no storage, and an unknown platform", async () => {
        const harness = build();

        for (const body of [
            { client_id: HOST_CLIENT_ID, hostname: "x" },
            { ...hostBody, storage: "somewhere" },
            { ...hostBody, platform: "plan9" },
        ]) {
            const { response } = await call(harness, "/device/code", { body });

            expect(response.status).toBe(400);
        }
    });

    it("refuses a host code when the server does not offer host pairing", async () => {
        const harness = build({ withHostPairing: false });
        const { response } = await call(harness, "/device/code", { body: hostBody });

        expect(response.status).toBe(400);
    });

    it("keeps the two kinds of code apart: neither redeems at the other's route", async () => {
        const harness = build();
        const owner = await signUp(harness);
        const hostCode = await requestHostCode(harness);
        const { body: cliCode } = await call(harness, "/device/code", { body: { client_id: CLI_CLIENT_ID, hostname: "laptop" } });

        await approve(harness, owner.cookie, hostCode.user_code);
        await approve(harness, owner.cookie, cliCode["user_code"] as string);
        vi.setSystemTime(Date.now() + 6000);

        const hostAtKey = await call(harness, "/device/key", { body: { device_code: hostCode.device_code } });
        const cliAtHost = await redeem(harness, cliCode["device_code"] as string);

        expect(hostAtKey.body["error"]).toBe("invalid_grant");
        expect(cliAtHost.body["error"]).toBe("invalid_grant");
        expect(harness.registrations).toHaveLength(0);

        // The stock token route would hand out a browser session; it is refused for every code.
        const stock = await call(harness, "/device/token", {
            body: { client_id: HOST_CLIENT_ID, device_code: hostCode.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
        });

        expect(stock.response.status).toBe(400);
    });

    it("lets only the account that opened the code approve it", async () => {
        const harness = build();
        const owner = await signUp(harness);
        const other = await signUp(harness);
        const code = await requestHostCode(harness);

        await call(harness, `/device?user_code=${code.user_code}`, { cookie: owner.cookie });

        const stolen = await call(harness, "/device/approve", { body: { userCode: code.user_code }, cookie: other.cookie });

        expect(stolen.response.status).toBeGreaterThanOrEqual(400);

        vi.setSystemTime(Date.now() + 6000);

        expect(await errorOf(harness, code.device_code)).toBe("authorization_pending");
    });

    it("refuses a guest's approval", async () => {
        const harness = build();
        const cookie = await guest(harness);
        const code = await requestHostCode(harness);

        await call(harness, `/device?user_code=${code.user_code}`, { cookie });

        const { response } = await call(harness, "/device/approve", { body: { userCode: code.user_code }, cookie });

        expect(response.status).toBe(403);
        expect(harness.registrations).toHaveLength(0);
    });

    it("does not hold a machine's pairing to the API key cap, which only a CLI sign-in spends", async () => {
        const harness = build();
        const owner = await signUp(harness);
        const context = await harness.auth.$context;

        for (let index = 0; index < MAX_API_KEYS_PER_USER; index += 1) {
            await context.adapter.create({
                data: { createdAt: new Date(), enabled: true, key: `cap${String(index)}`, referenceId: owner.userId, updatedAt: new Date() },
                model: "apikey",
            });
        }

        const code = await requestHostCode(harness);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        expect(await statusOf(harness, code.device_code)).toBe(200);
    });

    it("does not let a guest's lookup bind a code, so the owner can still approve it", async () => {
        const harness = build();
        const cookie = await guest(harness);
        const code = await requestHostCode(harness);
        const lookup = await call(harness, `/device?user_code=${code.user_code}`, { cookie });

        expect(lookup.response.status).toBe(403);

        const owner = await signUp(harness);
        const seen = await call(harness, `/device?user_code=${code.user_code}`, { cookie: owner.cookie });

        expect(seen.response.status).toBe(200);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        expect(await statusOf(harness, code.device_code)).toBe(200);
    });

    it("leaves the code unspent when the account cannot take another device", async () => {
        let full = true;
        const harness = build({
            precheck: async () => {
                if (full) {
                    throw Object.assign(new Error("At most 10 devices can be paired. Remove one first."), { code: "BAD_REQUEST" });
                }
            },
        });
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        const refused = await redeem(harness, code.device_code);

        expect(refused.response.status).toBe(403);
        expect(refused.body["error"]).toBe("device_limit");
        expect(refused.body["error_description"]).toContain("At most 10 devices");
        expect(harness.registrations).toHaveLength(0);

        // The person frees a slot; the same code still works.
        full = false;
        vi.setSystemTime(Date.now() + 6000);

        expect(await statusOf(harness, code.device_code)).toBe(200);
        expect(harness.registrations).toHaveLength(1);
    });

    it("answers a failed precheck as a retryable 5xx, keeping the code unspent and the cause private", async () => {
        let down = true;
        const harness = build({
            precheck: async () => {
                if (down) {
                    throw new Error("shard stub timed out at internal-host:9229");
                }
            },
        });
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        const failed = await redeem(harness, code.device_code);

        expect(failed.response.status).toBe(500);
        expect(failed.body["error"]).toBe("server_error");
        expect(JSON.stringify(failed.body)).not.toContain("internal-host");

        down = false;
        vi.setSystemTime(Date.now() + 6000);

        expect(await statusOf(harness, code.device_code)).toBe(200);
        expect(harness.registrations).toHaveLength(1);
    });

    it("tells the machine which account approved it, masked", async () => {
        const harness = build();
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        const { body } = await redeem(harness, code.device_code);

        expect(body["account"]).toBe("o***@example.test");
    });

    it("puts the code back when registering fails for a reason of ours, so the next poll can finish", async () => {
        let flaky = true;
        const harness = build({
            register: async () => {
                if (flaky) {
                    throw new Error("durable object reset at internal-host:9229");
                }
            },
        });
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        const failed = await redeem(harness, code.device_code);

        expect(failed.response.status).toBe(500);
        expect(failed.body["error"]).toBe("server_error");
        expect(JSON.stringify(failed.body)).not.toContain("internal-host");
        expect(harness.registrations).toHaveLength(0);

        flaky = false;
        vi.setSystemTime(Date.now() + 6000);

        expect(await statusOf(harness, code.device_code)).toBe(200);
        expect(harness.registrations).toHaveLength(1);
    });

    it("registers the retry of a failed registration under the same code id, so one device results", async () => {
        let calls = 0;
        const harness = build({
            register: async () => {
                calls += 1;

                if (calls === 1) {
                    // The device was made, then the reply was lost.
                    throw new Error("timed out after commit");
                }
            },
        });
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);
        const lost = await redeem(harness, code.device_code);

        expect(lost.response.status).toBe(500);
        vi.setSystemTime(Date.now() + 6000);
        expect(await statusOf(harness, code.device_code)).toBe(200);

        // Both attempts carried the id of the one code, which is what lets the real registration find its device.
        expect(harness.attempts).toHaveLength(2);
        expect(harness.attempts[0]?.length).toBeGreaterThan(0);
        expect(harness.attempts[1]).toBe(harness.attempts[0]);
        expect(harness.registrations).toHaveLength(1);
    });

    it("keeps the code unspent while a full account at registration tells the machine to wait", async () => {
        let full = true;
        const harness = build({
            register: async () => {
                if (full) {
                    throw Object.assign(new Error("At most 10 devices can be paired. Remove one first."), { code: "BAD_REQUEST" });
                }
            },
        });
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        const waiting = await redeem(harness, code.device_code);

        expect(waiting.response.status).toBe(403);
        expect(waiting.body["error"]).toBe("device_limit");

        // A slot is freed: the same code completes the pairing.
        full = false;
        vi.setSystemTime(Date.now() + 6000);

        expect(await statusOf(harness, code.device_code)).toBe(200);
        expect(harness.registrations).toHaveLength(1);
    });

    it("keeps a deliberate refusal at registration final", async () => {
        const harness = build({
            register: async () => {
                throw Object.assign(new Error("This account is being deleted"), { code: "FORBIDDEN" });
            },
        });
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        const refused = await redeem(harness, code.device_code);

        expect(refused.response.status).toBe(403);
        expect(refused.body["error"]).toBe("access_denied");

        vi.setSystemTime(Date.now() + 6000);
        const again = await redeem(harness, code.device_code);

        expect(again.body["error"]).toBe("invalid_grant");
    });

    it("refuses a code that expired", async () => {
        const harness = build();
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        await approve(harness, owner.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 31 * 60_000);

        const { body } = await redeem(harness, code.device_code);

        expect(body["error"]).toBe("expired_token");
        expect(harness.registrations).toHaveLength(0);
    });

    it("answers a denied code with access_denied and registers nothing", async () => {
        const harness = build();
        const owner = await signUp(harness);
        const code = await requestHostCode(harness);

        await call(harness, `/device?user_code=${code.user_code}`, { cookie: owner.cookie });
        await call(harness, "/device/deny", { body: { userCode: code.user_code }, cookie: owner.cookie });
        vi.setSystemTime(Date.now() + 6000);

        expect(await errorOf(harness, code.device_code)).toBe("access_denied");
        expect(harness.registrations).toHaveLength(0);
    });
});
