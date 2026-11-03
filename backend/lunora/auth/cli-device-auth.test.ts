/**
 * The CLI's device-code sign-in, end to end through better-auth's real handler
 * (`auth.handler`) with its in-memory store: the same plugin code, endpoints,
 * state machine and one-time claim that run in production, minus D1.
 */
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { anonymous } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_KEY_OPTIONS } from "../auth";
import type { ApiKeyAuthApi } from "../public-api/identity";
import { DEFAULT_API_SCOPES } from "../public-api/scopes";
import type { MintedCliKey } from "./cli-device-auth";
import { CLI_CLIENT_ID, cleanHostname, cliDeviceAuth, cliKeyName, MAX_CLI_KEYS_PER_USER } from "./cli-device-auth";

const BASE_URL = "http://localhost:3000";

const KEY_PATTERN = /^nk_/;

const USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

const build = () => {
    const database = memoryAdapter({ account: [], apikey: [], deviceCode: [], rateLimit: [], session: [], user: [], verification: [] });
    const auth = betterAuth({
        baseURL: BASE_URL,
        database,
        emailAndPassword: { enabled: true },
        plugins: [
            apiKey(API_KEY_OPTIONS),
            anonymous(),
            ...cliDeviceAuth({
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

    return { auth, database };
};

type Harness = ReturnType<typeof build>;

const rowsOf = async <T extends object = object>(harness: Harness, model: string): Promise<T[]> => {
    const context = await harness.auth.$context;

    return await context.adapter.findMany<T>({ model });
};

const statusOf = async (pending: Promise<{ response: Response }>): Promise<number> => {
    const { response } = await pending;

    return response.status;
};

const errorOf = async (pending: Promise<{ body: object }>): Promise<unknown> => {
    const { body } = await pending;

    return (body as { error?: unknown }).error;
};

const call = async (
    harness: Harness,
    path: string,
    init: { body?: unknown; cookie?: string; method?: string } = {},
): Promise<{ body: Record<string, unknown>; response: Response }> => {
    const response = await harness.auth.handler(
        new Request(`${BASE_URL}/api/auth${path}`, {
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            headers: { "content-type": "application/json", origin: BASE_URL, ...(init.cookie && { cookie: init.cookie }) },
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
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
        body: { email: `person${String(counter)}@example.test`, name: "Person", password: "correct horse battery" },
    });

    expect(response.status).toBe(200);

    return { cookie: cookieOf(response), userId: (body["user"] as { id: string }).id };
};

const requestCode = async (harness: Harness, hostname = "devbox") => {
    const { body, response } = await call(harness, "/device/code", { body: { client_id: CLI_CLIENT_ID, hostname } });

    expect(response.status).toBe(200);

    return body as {
        device_code: string;
        expires_in: number;
        interval: number;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
    };
};

const poll = async (harness: Harness, deviceCode: string) =>
    await call(harness, "/device/key", { body: { client_id: CLI_CLIENT_ID, device_code: deviceCode } });

/** What the web page does: open the code while signed in (which claims it), then approve it. */
const approve = async (harness: Harness, cookie: string, userCode: string) => {
    const look = await call(harness, `/device?user_code=${userCode}`, { cookie });

    expect(look.response.status).toBe(200);

    return { approved: await call(harness, "/device/approve", { body: { userCode }, cookie }), look };
};

describe("device-code sign-in for the CLI", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("issues a code with the plugin's defaults: 30 minutes, a 5 second interval, an 8 character code", async () => {
        const harness = build();
        const code = await requestCode(harness);

        expect(code.expires_in).toBe(1800);
        expect(code.interval).toBe(5);
        expect(code.user_code).toMatch(USER_CODE_PATTERN);
        expect(code.verification_uri).toBe(`${BASE_URL}/auth/device`);
        expect(code.verification_uri_complete).toBe(`${BASE_URL}/auth/device?user_code=${code.user_code}`);
    });

    it("runs the whole flow: pending, approve, then a read-only key named for the host, returned once", async () => {
        const harness = build();
        const person = await signUp(harness);
        const code = await requestCode(harness, "devbox.example");

        const pending = await poll(harness, code.device_code);

        expect(pending.response.status).toBe(400);
        expect(pending.body["error"]).toBe("authorization_pending");

        const { approved, look } = await approve(harness, person.cookie, code.user_code);

        // The owner sees what is being approved: the client and the host's name.
        expect(look.body).toMatchObject({ client_id: CLI_CLIENT_ID, hostname: "devbox.example", status: "pending" });
        expect(approved.response.status).toBe(200);

        // The plugin refuses a poll inside the 5 second interval.
        const early = await poll(harness, code.device_code);

        expect(early.body["error"]).toBe("slow_down");

        vi.setSystemTime(Date.now() + 6000);

        const redeemed = await poll(harness, code.device_code);

        expect(redeemed.response.status).toBe(200);
        expect(redeemed.body["api_key"]).toEqual(expect.stringMatching(KEY_PATTERN));

        const verified = await (harness.auth.api as unknown as ApiKeyAuthApi).verifyApiKey({ body: { key: redeemed.body["api_key"] as string } });

        expect(verified.valid).toBe(true);
        expect(verified.key?.referenceId).toBe(person.userId);
        expect(verified.key?.permissions).toEqual(DEFAULT_API_SCOPES);

        const keys = await rowsOf<{ name: string }>(harness, "apikey");

        expect(keys.map((key) => key.name)).toEqual(["Neore CLI on devbox.example"]);
    });

    it("answers a second redemption of the same code with invalid_grant and mints no second key", async () => {
        const harness = build();
        const person = await signUp(harness);
        const code = await requestCode(harness);

        await approve(harness, person.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        expect(await statusOf(poll(harness, code.device_code))).toBe(200);

        vi.setSystemTime(Date.now() + 6000);

        const again = await poll(harness, code.device_code);

        expect(again.response.status).toBe(400);
        expect(again.body["error"]).toBe("invalid_grant");

        const keys = await rowsOf(harness, "apikey");

        expect(keys).toHaveLength(1);
    });

    it("mints exactly one key when two polls race for the same approved code", async () => {
        const harness = build();
        const person = await signUp(harness);
        const code = await requestCode(harness);

        await approve(harness, person.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        const results = await Promise.all([poll(harness, code.device_code), poll(harness, code.device_code)]);
        const keys = await rowsOf(harness, "apikey");

        expect(keys.length).toBeLessThanOrEqual(1);
        expect(results.filter((result) => result.response.status === 200)).toHaveLength(keys.length);
    });

    it("cannot approve a code twice, nor deny one that was approved", async () => {
        const harness = build();
        const person = await signUp(harness);
        const code = await requestCode(harness);

        expect(await statusOf(approve(harness, person.cookie, code.user_code).then(({ approved }) => approved))).toBe(200);

        const second = await call(harness, "/device/approve", { body: { userCode: code.user_code }, cookie: person.cookie });
        const deny = await call(harness, "/device/deny", { body: { userCode: code.user_code }, cookie: person.cookie });

        expect(second.response.status).toBe(400);
        expect(second.body["error"]).toBe("invalid_request");
        expect(deny.response.status).toBe(400);
    });

    it("cannot approve a code after the key was handed out", async () => {
        const harness = build();
        const person = await signUp(harness);
        const code = await requestCode(harness);

        await approve(harness, person.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);
        await poll(harness, code.device_code);

        const late = await call(harness, "/device/approve", { body: { userCode: code.user_code }, cookie: person.cookie });

        expect(late.response.status).toBe(400);
        expect(late.body["error"]).toBe("invalid_request");
    });

    it("refuses an expired code at the approval page and at the poll", async () => {
        const harness = build();
        const person = await signUp(harness);
        const code = await requestCode(harness);

        vi.setSystemTime(Date.now() + 31 * 60 * 1000);

        const look = await call(harness, `/device?user_code=${code.user_code}`, { cookie: person.cookie });
        const approveLate = await call(harness, "/device/approve", { body: { userCode: code.user_code }, cookie: person.cookie });
        const polled = await poll(harness, code.device_code);

        expect(look.body["error"]).toBe("expired_token");
        expect(approveLate.body["error"]).toBe("expired_token");
        expect(polled.body["error"]).toBe("expired_token");
    });

    it("tells the CLI the code was denied, once", async () => {
        const harness = build();
        const person = await signUp(harness);
        const code = await requestCode(harness);

        await call(harness, `/device?user_code=${code.user_code}`, { cookie: person.cookie });
        expect(await statusOf(call(harness, "/device/deny", { body: { userCode: code.user_code }, cookie: person.cookie }))).toBe(200);

        vi.setSystemTime(Date.now() + 6000);

        const denied = await poll(harness, code.device_code);

        expect(denied.body["error"]).toBe("access_denied");

        vi.setSystemTime(Date.now() + 6000);

        expect(await errorOf(poll(harness, code.device_code))).toBe("invalid_grant");
    });

    it("lets only the person who opened the code approve it", async () => {
        const harness = build();
        const owner = await signUp(harness);
        const stranger = await signUp(harness);
        const code = await requestCode(harness);

        await call(harness, `/device?user_code=${code.user_code}`, { cookie: owner.cookie });

        const attempt = await call(harness, "/device/approve", { body: { userCode: code.user_code }, cookie: stranger.cookie });

        expect(attempt.response.status).toBe(403);

        // And the stranger never sees what the code is for.
        const peek = await call(harness, `/device?user_code=${code.user_code}`, { cookie: stranger.cookie });

        expect(peek.body).not.toHaveProperty("hostname");
    });

    it("refuses to approve without a session", async () => {
        const harness = build();
        const code = await requestCode(harness);

        expect(await statusOf(call(harness, "/device/approve", { body: { userCode: code.user_code } }))).toBe(401);
    });

    it("never turns a CLI code into a browser session through the stock token route", async () => {
        const harness = build();
        const person = await signUp(harness);
        const code = await requestCode(harness);

        await approve(harness, person.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        const stock = await call(harness, "/device/token", {
            body: { client_id: CLI_CLIENT_ID, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
        });

        expect(stock.response.status).toBe(400);
        expect(stock.body["error"]).toBe("invalid_grant");
        expect(stock.body).not.toHaveProperty("access_token");

        // The refusal did not spend the code: the CLI's own route still redeems it.
        vi.setSystemTime(Date.now() + 6000);
        expect(await statusOf(poll(harness, code.device_code))).toBe(200);
    });

    it("refuses a guest account at approval and leaves the code unspent", async () => {
        const harness = build();
        const guest = await call(harness, "/sign-in/anonymous", { body: {} });
        const cookie = cookieOf(guest.response);
        const code = await requestCode(harness);

        await call(harness, `/device?user_code=${code.user_code}`, { cookie });

        const attempt = await call(harness, "/device/approve", { body: { userCode: code.user_code }, cookie });

        expect(attempt.response.status).toBe(403);
        expect(await errorOf(poll(harness, code.device_code))).toBe("authorization_pending");
    });

    it("accepts only the CLI client and refuses a pre-bound user or a scope", async () => {
        const harness = build();

        expect(await errorOf(call(harness, "/device/code", { body: { client_id: "someone-else" } }))).toBe("invalid_client");
        expect(await errorOf(call(harness, "/device/code", { body: { client_id: CLI_CLIENT_ID, user_id: "victim" } }))).toBe("invalid_request");
        expect(await errorOf(call(harness, "/device/code", { body: { client_id: CLI_CLIENT_ID, scope: "admin" } }))).toBe("invalid_scope");
    });

    it("refuses a poll with the wrong client id", async () => {
        const harness = build();
        const code = await requestCode(harness);
        const wrong = await call(harness, "/device/key", { body: { client_id: "other", device_code: code.device_code } });

        expect(wrong.body["error"]).toBe("invalid_grant");
    });

    it("clears lapsed codes when a new one is issued", async () => {
        const harness = build();

        await requestCode(harness);
        vi.setSystemTime(Date.now() + 31 * 60 * 1000);
        await requestCode(harness);

        expect(await rowsOf(harness, "deviceCode")).toHaveLength(1);
    });

    it("refuses a new key when the person already has the maximum, leaving the code unspent", async () => {
        const harness = build();
        const person = await signUp(harness);
        const context = await harness.auth.$context;

        for (let index = 0; index < MAX_CLI_KEYS_PER_USER; index += 1) {
            await context.adapter.create({
                data: { createdAt: new Date(), enabled: true, key: `hash${String(index)}`, referenceId: person.userId, updatedAt: new Date() },
                model: "apikey",
            });
        }

        const code = await requestCode(harness);

        await approve(harness, person.cookie, code.user_code);
        vi.setSystemTime(Date.now() + 6000);

        const refused = await poll(harness, code.device_code);

        expect(refused.response.status).toBe(403);
        expect(refused.body["error"]).toBe("access_denied");
    });
});

describe("hostname handling", () => {
    it("reduces the host's own name to host-name characters and caps the key name at 32", () => {
        expect(cleanHostname("my-laptop.local")).toBe("my-laptop.local");
        expect(cleanHostname("<img src=x onerror=alert(1)>‮ evil\n")).toBe("imgsrcxonerroralert1evil");
        expect(cleanHostname("")).toBe("unknown-host");
        expect(cleanHostname(undefined)).toBe("unknown-host");
        expect(cliKeyName("a".repeat(100))).toHaveLength(32);
        expect(cliKeyName("devbox")).toBe("Neore CLI on devbox");
    });
});
