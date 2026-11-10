import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run } from "./cli";
import { EXIT } from "./client";
import type { Context } from "./commands";
import { readConfig } from "./config";

const API = "https://api.test";

const GRANT = {
    device_code: "dc-secret",
    expires_in: 1800,
    interval: 5,
    user_code: "ABCDEFGH",
    verification_uri: "https://app.test/auth/device",
    verification_uri_complete: "https://app.test/auth/device?user_code=ABCDEFGH",
};

const oauth = (error: string, status = 400, description = "why") => Response.json({ error, error_description: description }, { status });

describe("neore login --device", () => {
    let directory: string;
    let configFile: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "neore-device-"));
        configFile = join(directory, "config.json");
    });

    afterEach(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    /** A fake API: each route answers from its queue (the last answer repeats); the clock only moves when the CLI sleeps. */
    const setup = (routes: Record<string, Response[]>, options: { clockStepMs?: number } = {}) => {
        const calls: { body: unknown; path: string }[] = [];
        const sleeps: number[] = [];
        const redirects: (string | undefined)[] = [];
        let clock = 0;
        const stdout: string[] = [];
        const stderr: string[] = [];

        const fetchImpl = (async (url: string, init: RequestInit) => {
            const { pathname } = new URL(url);

            if (pathname.startsWith("/api/auth/")) {
                redirects.push(init.redirect);
            }

            calls.push({ body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, path: pathname });

            const queue = routes[pathname] ?? [];
            const answer = queue.length > 1 ? queue.shift() : queue[0];

            if (!answer) {
                throw new Error(`unexpected request to ${pathname}`);
            }

            // A fresh response each time: a cloned body is a tee, and cancelling one branch (the CLI does) waits on the other.
            return new Response(await answer.clone().text(), { headers: answer.headers, status: answer.status });
        }) as unknown as typeof fetch;

        const context: Context = {
            configFile,
            fetch: fetchImpl,
            hostname: "devbox",
            io: {
                env: { NO_COLOR: "1" } as NodeJS.ProcessEnv,
                stderr: {
                    isTTY: false,
                    write: (chunk: string) => {
                        stderr.push(chunk);
                    },
                },
                stdout: {
                    isTTY: false,
                    write: (chunk: string) => {
                        stdout.push(chunk);
                    },
                },
            },
            now: () => clock,
            readFile: async () => new Uint8Array(),
            readLine: async () => null,
            readStdin: async () => null,
            sleep: async (ms) => {
                sleeps.push(ms);
                clock += options.clockStepMs ?? ms;
            },
            stdinIsTTY: true,
        };

        return { calls, context, redirects, sleeps, stderr: () => stderr.join(""), stdout: () => stdout.join("") };
    };

    const grant = Response.json(GRANT);
    const me = Response.json({ scopes: ["threads:read"], userId: "u1" });

    it("shows the URL and code, waits through pending and slow_down, and saves the key 0600", async () => {
        const api = setup({
            "/api/auth/device/code": [grant],
            "/api/auth/device/key": [oauth("authorization_pending"), oauth("slow_down"), Response.json({ api_key: "nk_new", token_type: "api_key" })],
            "/api/v1/me": [me],
        });

        expect(await run(["login", "--device", "--api-url", API], api.context)).toBe(EXIT.ok);

        expect(api.calls[0]).toEqual({ body: { client_id: "neore-cli", hostname: "devbox" }, path: "/api/auth/device/code" });
        expect(api.stderr()).toContain("https://app.test/auth/device");
        expect(api.stderr()).toContain("ABCD-EFGH");
        expect(api.stderr()).not.toContain("dc-secret");
        expect(api.sleeps).toEqual([5000, 5000, 10_000]);
        expect(api.stderr()).toContain("Signing in to api.test");
        expect(api.stderr()).not.toContain("previous key");
        // The code, poll and revoke bodies carry secrets, so none of them may follow a redirect.
        expect(api.redirects).toEqual(["error", "error", "error", "error"]);
        expect(api.stdout() + api.stderr()).not.toContain("nk_new");
        expect(await readConfig(configFile)).toEqual({ apiKey: "nk_new", apiUrl: API });

        const { mode } = await stat(configFile);

        expect(mode & 0o777).toBe(0o600);
    });

    it("keeps the poll interval when the server has an outage, and clamps a hostile interval and lifetime", async () => {
        const outage = setup({
            "/api/auth/device/code": [grant],
            "/api/auth/device/key": [Response.json({}, { status: 503 }), Response.json({ api_key: "nk_new" })],
            "/api/v1/me": [me],
        });

        expect(await run(["login", "--device", "--api-url", API], outage.context)).toBe(EXIT.ok);
        expect(outage.sleeps).toEqual([5000, 5000]);

        const hostile = setup(
            {
                "/api/auth/device/code": [Response.json({ ...GRANT, expires_in: 1e9, interval: 1e9 })],
                "/api/auth/device/key": [oauth("slow_down"), oauth("authorization_pending")],
            },
            { clockStepMs: 600_000 },
        );

        expect(await run(["login", "--device", "--api-url", API], hostile.context)).toBe(EXIT.error);
        expect(hostile.stderr()).toContain("expired");
        expect(hostile.sleeps.length).toBeLessThanOrEqual(7);
        expect(new Set(hostile.sleeps)).toEqual(new Set([60_000]));
    });

    it("notes that the previous key is still valid after replacing it", async () => {
        await writeFile(configFile, JSON.stringify({ apiKey: "nk_old", apiUrl: API }));

        const api = setup({ "/api/auth/device/code": [grant], "/api/auth/device/key": [Response.json({ api_key: "nk_new" })], "/api/v1/me": [me] });

        expect(await run(["login", "--device", "--api-url", API], api.context)).toBe(EXIT.ok);
        expect(api.stderr()).toContain("previous key is still valid");
        expect(await readConfig(configFile)).toEqual({ apiKey: "nk_new", apiUrl: API });
    });

    it("accepts http only for localhost", async () => {
        const local = setup({ "/api/auth/device/code": [grant], "/api/auth/device/key": [Response.json({ api_key: "nk_new" })], "/api/v1/me": [me] });

        expect(await run(["login", "--device", "--api-url", "http://localhost:8788"], local.context)).toBe(EXIT.ok);
    });

    it("ends with the reason when the code is denied or already used", async () => {
        const denied = setup({ "/api/auth/device/code": [grant], "/api/auth/device/key": [oauth("access_denied", 403)] });

        expect(await run(["login", "--device", "--api-url", API], denied.context)).toBe(EXIT.error);
        expect(denied.stderr()).toContain("denied");

        const used = setup({ "/api/auth/device/code": [grant], "/api/auth/device/key": [oauth("invalid_grant")] });

        expect(await run(["login", "--device", "--api-url", API], used.context)).toBe(EXIT.error);
        expect(used.stderr()).toContain("already used");
        expect(await readConfig(configFile)).toEqual({});

        const hostile = setup({ "/api/auth/device/code": [grant], "/api/auth/device/key": [oauth("access_denied", 403, "no\u{1B}[2Jpe")] });

        expect(await run(["login", "--device", "--api-url", API], hostile.context)).toBe(EXIT.error);
        expect(hostile.stderr()).toContain("no[2Jpe");
        expect(hostile.stderr()).not.toContain("\u{1B}");
    });

    it("stops when the code's lifetime runs out while waiting", async () => {
        const api = setup({ "/api/auth/device/code": [grant], "/api/auth/device/key": [oauth("authorization_pending")] }, { clockStepMs: 600_000 });

        expect(await run(["login", "--device", "--api-url", API], api.context)).toBe(EXIT.error);
        expect(api.stderr()).toContain("expired");
    });

    it("gives up with the rate-limit exit code after repeated 429s", async () => {
        const api = setup({ "/api/auth/device/code": [grant], "/api/auth/device/key": [Response.json({}, { status: 429 })] });

        expect(await run(["login", "--device", "--api-url", API], api.context)).toBe(EXIT.rateLimited);
    });

    it("revokes the issued key when it cannot be checked, and says so", async () => {
        const api = setup({
            "/api/auth/device/code": [grant],
            "/api/auth/device/key": [Response.json({ api_key: "nk_new" })],
            "/api/auth/device/revoke": [Response.json({ revoked: true })],
            "/api/v1/me": [Response.json({ error: { code: "invalid_api_key", message: "bad" } }, { status: 401 })],
        });

        expect(await run(["login", "--device", "--api-url", API], api.context)).toBe(EXIT.auth);
        expect(api.calls.at(-1)).toEqual({ body: { api_key: "nk_new" }, path: "/api/auth/device/revoke" });
        expect(api.stderr()).toContain("was revoked");
        expect(await readConfig(configFile)).toEqual({});
    });

    it("revokes the issued key when it cannot be saved, and leaves the old config alone", async () => {
        await writeFile(configFile, JSON.stringify({ apiKey: "nk_old", apiUrl: API }));
        await chmod(directory, 0o500);

        try {
            const api = setup({
                "/api/auth/device/code": [grant],
                "/api/auth/device/key": [Response.json({ api_key: "nk_new" })],
                "/api/auth/device/revoke": [Response.json({ revoked: true })],
                "/api/v1/me": [me],
            });

            expect(await run(["login", "--device", "--api-url", API], api.context)).toBe(EXIT.error);
            expect(api.calls.at(-1)).toEqual({ body: { api_key: "nk_new" }, path: "/api/auth/device/revoke" });
            expect(api.stderr()).toContain("was revoked");
            expect(await readConfig(configFile)).toEqual({ apiKey: "nk_old", apiUrl: API });
        } finally {
            await chmod(directory, 0o700);
        }
    });

    it("tells the person to revoke the key in Settings when the revoke fails too", async () => {
        const api = setup({
            "/api/auth/device/code": [grant],
            "/api/auth/device/key": [Response.json({ api_key: "nk_new" })],
            "/api/auth/device/revoke": [oauth("invalid_grant")],
            "/api/v1/me": [Response.json({ error: { code: "invalid_api_key", message: "bad" } }, { status: 401 })],
        });

        expect(await run(["login", "--device", "--api-url", API], api.context)).toBe(EXIT.auth);
        expect(api.stderr()).toContain("revoke it in Settings");
    });

    it("refuses --device with --key, and a plain-http API URL, before sending anything", async () => {
        const withKey = setup({});

        expect(await run(["login", "--device", "--key", "nk_1", "--api-url", API], withKey.context)).toBe(EXIT.usage);
        expect(withKey.calls).toEqual([]);

        const insecure = setup({});

        // eslint-disable-next-line unicorn/prefer-https -- the plain-http refusal is what is under test
        expect(await run(["login", "--device", "--api-url", "http://api.test"], insecure.context)).toBe(EXIT.usage);
        expect(insecure.calls).toEqual([]);
    });

    it("rejects a sign-in code with terminal control characters", async () => {
        const api = setup({ "/api/auth/device/code": [Response.json({ ...GRANT, user_code: "AB\u{1B}[2JCD" })] });

        expect(await run(["login", "--device", "--api-url", API], api.context)).toBe(EXIT.error);
        expect(api.stderr()).not.toContain("\u{1B}");
    });
});
