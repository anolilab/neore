import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run } from "./cli";
import { ApiError, EXIT, exitCodeFor } from "./client";
import type { Context } from "./commands";
import { readConfig, writeConfig } from "./config";
import type { DeviceCode, DeviceFlowDependencies } from "./device-login";
import { DEV_INSECURE_LOOPBACK_VAR, formatUserCode, pollForKey, requestDeviceCode } from "./device-login";

const BASE = "https://api.test";

const CODE_RESPONSE = {
    device_code: "dev-code",
    expires_in: 1800,
    interval: 5,
    user_code: "ABCDEFGH",
    verification_uri: "https://app.test/auth/device",
    verification_uri_complete: "https://app.test/auth/device?user_code=ABCDEFGH",
};

const oauthError = (error: string, status = 400, description = "") => Response.json({ error, error_description: description }, { status });

/** A fake clock whose `sleep` advances it, and a fetch that plays the scripted answers in order. */
const harness = (answers: ((() => Response) | Error)[]) => {
    const log: { body: unknown; path: string; sleptBefore: number }[] = [];
    let clock = 0;
    let lastSleep = 0;
    const remaining = [...answers];

    const dependencies: DeviceFlowDependencies = {
        fetch: (async (url: string, init: RequestInit) => {
            log.push({ body: JSON.parse(String(init.body)), path: new URL(url).pathname, sleptBefore: lastSleep });

            const next = remaining.shift();

            if (!next) {
                throw new Error("unexpected extra request");
            }

            if (next instanceof Error) {
                throw next;
            }

            return next();
        }) as unknown as typeof fetch,
        now: () => clock,
        sleep: async (ms) => {
            lastSleep = ms;
            clock += ms;
        },
    };

    return { deps: dependencies, log };
};

const code = (overrides: Partial<DeviceCode> = {}): DeviceCode => {
    return {
        deviceCode: "dev-code",
        expiresAtMs: 1_800_000,
        intervalMs: 5000,
        userCode: "ABCDEFGH",
        verificationUri: "https://app.test/auth/device",
        verificationUriComplete: "https://app.test/auth/device?user_code=ABCDEFGH",
        ...overrides,
    };
};

describe("requestDeviceCode", () => {
    it("posts the hostname and returns the code with the server's expiry and interval", async () => {
        const { deps, log } = harness([() => Response.json(CODE_RESPONSE)]);

        const result = await requestDeviceCode(deps, `${BASE}/`, "devbox");

        expect(log).toEqual([{ body: { client_id: "neore-cli", hostname: "devbox" }, path: "/api/auth/device/code", sleptBefore: 0 }]);
        expect(result).toMatchObject({ deviceCode: "dev-code", expiresAtMs: 1_800_000, intervalMs: 5000, userCode: "ABCDEFGH" });
    });

    it.each([
        ["an infinite expires_in", '{"device_code":"d","user_code":"U","verification_uri":"https://a.test/x","expires_in":1e999,"interval":5}'],
        ["a zero expires_in", '{"device_code":"d","user_code":"U","verification_uri":"https://a.test/x","expires_in":0,"interval":5}'],
        ["an infinite interval", '{"device_code":"d","user_code":"U","verification_uri":"https://a.test/x","expires_in":1800,"interval":1e999}'],
        ["a negative interval", '{"device_code":"d","user_code":"U","verification_uri":"https://a.test/x","expires_in":1800,"interval":-5}'],
        ["a string interval", '{"device_code":"d","user_code":"U","verification_uri":"https://a.test/x","expires_in":1800,"interval":"5"}'],
    ])("ends with invalid_response, before any poll, for %s", async (_name, raw) => {
        const { deps, log } = harness([() => new Response(raw, { headers: { "Content-Type": "application/json" }, status: 200 })]);

        const error = await requestDeviceCode(deps, BASE, "devbox").catch((error_: unknown) => error_);

        expect(error).toMatchObject({ code: "invalid_response" });
        expect(exitCodeFor(error)).toBe(EXIT.error);
        expect(log).toHaveLength(1);
    });

    it("defaults the interval when the server sends none", async () => {
        const { deps } = harness([() => Response.json({ ...CODE_RESPONSE, interval: undefined })]);

        expect(await requestDeviceCode(deps, BASE, "devbox")).toMatchObject({ intervalMs: 5000 });
    });

    it("names an old server that has no device sign-in", async () => {
        const { deps } = harness([() => new Response("not found", { status: 404 })]);

        await expect(requestDeviceCode(deps, BASE, "devbox")).rejects.toMatchObject({ code: "device_login_unsupported" });
    });

    it("maps 429 to rate_limited (exit 5) and a refused connection to network_error (exit 6)", async () => {
        const limited = harness([() => new Response("slow down", { status: 429 })]);
        const down = harness([new TypeError("fetch failed")]);

        const first = await requestDeviceCode(limited.deps, BASE, "devbox").catch((error: unknown) => error);
        const second = await requestDeviceCode(down.deps, BASE, "devbox").catch((error: unknown) => error);

        expect(exitCodeFor(first)).toBe(EXIT.rateLimited);
        expect(exitCodeFor(second)).toBe(EXIT.network);
    });
});

describe("pollForKey", () => {
    it("waits the interval before each poll, keeps going while pending, and returns the key once approved", async () => {
        const { deps, log } = harness([
            () => oauthError("authorization_pending"),
            () => oauthError("authorization_pending"),
            () => Response.json({ api_key: "nk_new", expires_at: 123 }),
        ]);

        const key = await pollForKey(deps, BASE, code());

        expect(key).toEqual({ apiKey: "nk_new", expiresAt: 123 });
        expect(log.map((entry) => [entry.path, entry.sleptBefore, entry.body])).toEqual([
            ["/api/auth/device/key", 5000, { client_id: "neore-cli", device_code: "dev-code" }],
            ["/api/auth/device/key", 5000, { client_id: "neore-cli", device_code: "dev-code" }],
            ["/api/auth/device/key", 5000, { client_id: "neore-cli", device_code: "dev-code" }],
        ]);
    });

    it("lengthens the interval by 5 seconds on slow_down", async () => {
        const { deps, log } = harness([() => oauthError("slow_down"), () => oauthError("slow_down"), () => Response.json({ api_key: "nk_new" })]);

        await pollForKey(deps, BASE, code());

        expect(log.map((entry) => entry.sleptBefore)).toEqual([5000, 10_000, 15_000]);
    });

    it("fails with device_denied (exit 1) when the person denies it", async () => {
        const { deps } = harness([() => oauthError("access_denied", 400, "Access denied")]);

        const error = await pollForKey(deps, BASE, code()).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({ code: "device_denied" });
        expect((error as ApiError).message).toContain("denied");
        expect(exitCodeFor(error)).toBe(EXIT.error);
    });

    it("shows the server's reason when the key limit refuses the sign-in", async () => {
        const reason = "You already have 25 API keys. Revoke one in Settings, then try again.";
        const { deps } = harness([() => oauthError("access_denied", 403, reason)]);

        const error = await pollForKey(deps, BASE, code()).catch((error_: unknown) => error_);

        expect(error).toMatchObject({ code: "device_denied" });
        expect((error as ApiError).message).toContain(reason);
    });

    it("fails with device_expired (exit 1) when the server says the code expired", async () => {
        const { deps } = harness([() => oauthError("expired_token")]);

        const error = await pollForKey(deps, BASE, code()).catch((error_: unknown) => error_);

        expect(error).toMatchObject({ code: "device_expired" });
        expect(exitCodeFor(error)).toBe(EXIT.error);
    });

    it("stops with device_expired at the deadline without another request", async () => {
        const { deps, log } = harness([() => oauthError("authorization_pending"), () => oauthError("authorization_pending")]);

        // Two polls fit before the deadline (10 s, 2 x 5 s), a third does not.
        const error = await pollForKey(deps, BASE, code({ expiresAtMs: 10_001 })).catch((error_: unknown) => error_);

        expect(error).toMatchObject({ code: "device_expired" });
        expect(log).toHaveLength(2);
    });

    it("reports expiry, not a network error, when the wait itself crosses the deadline", async () => {
        const { deps, log } = harness([() => oauthError("authorization_pending"), new TypeError("offline"), new TypeError("offline")]);

        // The first poll (5 s) fits; the next wait ends at 10 s, past the 7 s deadline, with the server unreachable.
        const error = await pollForKey(deps, BASE, code({ expiresAtMs: 7000 })).catch((error_: unknown) => error_);

        expect(error).toMatchObject({ code: "device_expired" });
        expect(log).toHaveLength(1);
    });

    it("fails with device_code_invalid (exit 1) for a code that was already used", async () => {
        const { deps } = harness([() => oauthError("invalid_grant", 400, "Invalid device code")]);

        const error = await pollForKey(deps, BASE, code()).catch((error_: unknown) => error_);

        expect(error).toMatchObject({ code: "device_code_invalid" });
        expect((error as ApiError).message).toContain("already used");
        expect(exitCodeFor(error)).toBe(EXIT.error);
    });

    it("rides out a transient failure, then gives up after repeated ones", async () => {
        const recovered = harness([new TypeError("reset"), () => new Response("bad gateway", { status: 502 }), () => Response.json({ api_key: "nk_new" })]);

        expect(await pollForKey(recovered.deps, BASE, code())).toEqual({ apiKey: "nk_new", expiresAt: null });

        const dead = harness(Array.from({ length: 5 }, () => new TypeError("reset")));
        const error = await pollForKey(dead.deps, BASE, code()).catch((error_: unknown) => error_);

        expect(exitCodeFor(error)).toBe(EXIT.network);
    });

    it("does not lengthen the poll interval for a 5xx, so a brief outage does not slow every later poll", async () => {
        const { deps, log } = harness([
            () => new Response("bad gateway", { status: 502 }),
            () => new Response("bad gateway", { status: 503 }),
            () => oauthError("authorization_pending"),
            () => Response.json({ api_key: "nk_new" }),
        ]);

        expect(await pollForKey(deps, BASE, code())).toEqual({ apiKey: "nk_new", expiresAt: null });
        expect(log.map((entry) => entry.sleptBefore)).toEqual([5000, 5000, 5000, 5000]);
    });

    it("backs off on 429 and reports rate_limited (exit 5) when it persists", async () => {
        const { deps, log } = harness(Array.from({ length: 5 }, () => () => new Response("", { status: 429 })));
        const error = await pollForKey(deps, BASE, code()).catch((error_: unknown) => error_);

        expect(exitCodeFor(error)).toBe(EXIT.rateLimited);
        expect(log.map((entry) => entry.sleptBefore)).toEqual([5000, 10_000, 15_000, 20_000, 25_000]);
    });

    it("stops when cancelled", async () => {
        const { deps, log } = harness([]);
        const controller = new AbortController();

        controller.abort();

        await expect(pollForKey(deps, BASE, code(), controller.signal)).rejects.toMatchObject({ code: "device_cancelled" });
        expect(log).toHaveLength(0);
    });
});

describe("formatUserCode", () => {
    it("groups an 8-character code", () => {
        expect(formatUserCode("ABCDEFGH")).toBe("ABCD-EFGH");
        expect(formatUserCode("ABC")).toBe("ABC");
    });
});

describe("neore login --device", () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "neore-cli-device-"));
    });

    afterEach(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    const contextFor = (script: ((url: string) => Response)[]): Context & { io: { stderr: { text: () => string }; stdout: { text: () => string } } } => {
        let clock = 0;
        const chunks = { stderr: [] as string[], stdout: [] as string[] };
        const remaining = [...script];

        return {
            configFile: join(directory, "config.json"),
            fetch: (async (url: string) => {
                const next = remaining.shift();

                if (!next) {
                    throw new Error(`unexpected request to ${url}`);
                }

                return next(url);
            }) as unknown as typeof fetch,
            hostname: "devbox",
            io: {
                env: { NO_COLOR: "1" } as NodeJS.ProcessEnv,
                stderr: {
                    isTTY: false,
                    text: () => chunks.stderr.join(""),
                    write: (chunk: string) => {
                        chunks.stderr.push(chunk);
                    },
                },
                stdout: {
                    isTTY: false,
                    text: () => chunks.stdout.join(""),
                    write: (chunk: string) => {
                        chunks.stdout.push(chunk);
                    },
                },
            },
            now: () => clock,
            readFile: async () => new Uint8Array(),
            readLine: async () => null,
            readStdin: async () => null,
            sleep: async (ms: number) => {
                clock += ms;
            },
            stdinIsTTY: false,
        } as never;
    };

    it("prints the URL and code, stores the key it is given (0600) and verifies it first", async () => {
        const context = contextFor([
            () => Response.json(CODE_RESPONSE),
            () => oauthError("authorization_pending"),
            () => Response.json({ api_key: "nk_device", expires_at: null }),
            (url) => {
                expect(url).toBe("https://api.test/api/v1/me");

                return Response.json({ apiKeyId: "k1", scopes: ["threads:read"], userId: "u1" });
            },
        ]);

        expect(await run(["login", "--device", "--api-url", BASE, "--confirm-host", "api.test"], context)).toBe(EXIT.ok);

        const printed = context.io.stderr.text();

        expect(printed).toContain("https://app.test/auth/device");
        expect(printed).toContain("ABCD-EFGH");
        expect(context.io.stdout.text()).not.toContain("nk_device");
        expect(await readConfig(context.configFile)).toEqual({ apiKey: "nk_device", apiUrl: BASE });

        if (process.platform !== "win32") {
            const { mode } = await stat(context.configFile);

            expect((mode & 0o777).toString(8)).toBe("600");
        }
    });

    it("exits 1 and saves nothing when the code is denied", async () => {
        const context = contextFor([() => Response.json(CODE_RESPONSE), () => oauthError("access_denied", 400, "Access denied")]);

        expect(await run(["login", "--device", "--api-url", BASE, "--confirm-host", "api.test"], context)).toBe(EXIT.error);
        expect(context.io.stderr.text()).toContain("denied");
        expect(await readConfig(context.configFile)).toEqual({});
    });

    it("exits 2 when --device is combined with --key", async () => {
        const context = contextFor([]);

        expect(await run(["login", "--device", "--key", "nk_x", "--api-url", BASE], context)).toBe(EXIT.usage);
    });

    it("rejects an empty --key with --device before reading config or asking for an API URL", async () => {
        const context = contextFor([]);
        let wasAsked = false;

        context.readLine = async () => {
            wasAsked = true;

            return null;
        };

        expect(await run(["login", "--device", "--key="], context)).toBe(EXIT.usage);
        expect(wasAsked).toBe(false);
    });

    it("revokes the key it was issued when the check afterwards fails, leaving a saved key alone", async () => {
        const requested: { body: unknown; url: string }[] = [];
        const context = contextFor([
            () => Response.json(CODE_RESPONSE),
            () => Response.json({ api_key: "nk_new", expires_at: null }),
            () => Response.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 }),
            () => Response.json({ revoked: true }),
        ]);
        const inner = context.fetch;

        context.fetch = (async (url: string, init?: RequestInit) => {
            requested.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, url });

            return await inner(url, init);
        }) as unknown as typeof fetch;

        await writeConfig({ apiKey: "nk_old", apiUrl: BASE }, context.configFile);

        expect(await run(["login", "--device", "--api-url", BASE, "--confirm-host", "api.test"], context)).not.toBe(EXIT.ok);
        expect(await readConfig(context.configFile)).toEqual({ apiKey: "nk_old", apiUrl: BASE });
        expect(requested.at(-1)).toEqual({ body: { api_key: "nk_new" }, url: "https://api.test/api/auth/device/revoke" });
        expect(context.io.stderr.text()).toContain("it was revoked");
    });

    it("revokes the issued key when it cannot be saved", async () => {
        const requested: string[] = [];
        const context = contextFor([
            () => Response.json(CODE_RESPONSE),
            () => Response.json({ api_key: "nk_new", expires_at: null }),
            () => Response.json({ apiKeyId: "k2", scopes: [], userId: "u1" }),
            () => Response.json({ revoked: true }),
        ]);
        const inner = context.fetch;

        context.fetch = (async (url: string, init?: RequestInit) => {
            requested.push(url);

            return await inner(url, init);
        }) as unknown as typeof fetch;
        // The config folder can be read (nothing saved yet) but not written, so the save fails.
        await mkdir(join(directory, "locked"));
        await chmod(join(directory, "locked"), 0o500);
        context.configFile = join(directory, "locked", "config.json");

        expect(await run(["login", "--device", "--api-url", BASE, "--confirm-host", "api.test"], context)).not.toBe(EXIT.ok);
        expect(requested.at(-1)).toBe("https://api.test/api/auth/device/revoke");
    });

    it("tells the person to revoke the key in Settings when it cannot be revoked from here", async () => {
        const context = contextFor([
            () => Response.json(CODE_RESPONSE),
            () => Response.json({ api_key: "nk_new", expires_at: null }),
            () => Response.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 }),
            () => Response.json({ error: "invalid_grant" }, { status: 400 }),
        ]);

        expect(await run(["login", "--device", "--api-url", BASE, "--confirm-host", "api.test"], context)).not.toBe(EXIT.ok);
        expect(context.io.stderr.text()).toContain("revoke it in Settings");
    });

    it("replaces the saved key once the new one checks out, and says the old one is still valid", async () => {
        const context = contextFor([
            () => Response.json(CODE_RESPONSE),
            () => Response.json({ api_key: "nk_new", expires_at: null }),
            () => Response.json({ apiKeyId: "k2", scopes: ["threads:read"], userId: "u1" }),
        ]);

        await writeConfig({ apiKey: "nk_old", apiUrl: BASE }, context.configFile);

        expect(await run(["login", "--device", "--api-url", BASE, "--confirm-host", "api.test"], context)).toBe(EXIT.ok);
        expect(await readConfig(context.configFile)).toEqual({ apiKey: "nk_new", apiUrl: BASE });
        expect(context.io.stderr.text()).toContain("The key this replaces is still valid");
    });

    // eslint-disable-next-line unicorn/prefer-https -- plain http is the case under test
    it.each(["http://api.example.com", "ftp://api.example.com", "file:///etc/passwd"])("makes no request to %s", async (url) => {
        const context = contextFor([]);

        expect(await run(["login", "--device", "--api-url", url], context)).toBe(EXIT.usage);
    });

    it("refuses plain http to localhost unless the development switch is set, and sends nothing", async () => {
        const requested: string[] = [];
        const context = contextFor([() => Response.json(CODE_RESPONSE)]);
        const inner = context.fetch;

        context.fetch = (async (url: string, init?: RequestInit) => {
            requested.push(url);

            return await inner(url, init);
        }) as unknown as typeof fetch;

        expect(await run(["login", "--device", "--api-url", "http://localhost:8788", "--confirm-host", "localhost:8788"], context)).toBe(EXIT.usage);
        expect(requested).toEqual([]);
    });

    it("accepts plain http to localhost with the development switch", async () => {
        const context = contextFor([() => Response.json({ error: "x" }, { status: 500 })]);

        context.io.env[DEV_INSECURE_LOOPBACK_VAR] = "1";

        expect(await run(["login", "--device", "--api-url", "http://localhost:8788", "--confirm-host", "localhost:8788"], context)).not.toBe(EXIT.usage);
    });

    it("refuses plain http to a foreign host even with the development switch", async () => {
        const context = contextFor([]);

        context.io.env[DEV_INSECURE_LOOPBACK_VAR] = "1";

        // eslint-disable-next-line unicorn/prefer-https -- plain http is the case under test
        expect(await run(["login", "--device", "--api-url", "http://api.example.com", "--confirm-host", "api.example.com"], context)).toBe(EXIT.usage);
    });

    it("validates the base URL before every request of the flow, not only at the command", async () => {
        const { deps, log } = harness([() => Response.json(CODE_RESPONSE)]);

        // eslint-disable-next-line unicorn/prefer-https -- plain http is the case under test
        await expect(requestDeviceCode(deps, "http://api.example.com", "devbox")).rejects.toMatchObject({ name: "UsageError" });
        await expect(pollForKey(deps, "ftp://api.example.com", code())).rejects.toMatchObject({ name: "UsageError" });
        expect(log).toHaveLength(0);
    });

    describe("host confirmation", () => {
        const requests = (script: ((url: string) => Response)[]) => {
            const urls: string[] = [];
            const context = contextFor(
                script.map((answer) => (url: string) => {
                    urls.push(url);

                    return answer(url);
                }),
            );

            return { context, urls };
        };

        it("without a terminal, refuses unless the host is passed, and sends nothing", async () => {
            const { context, urls } = requests([() => Response.json(CODE_RESPONSE)]);

            expect(await run(["login", "--device", "--api-url", BASE], context)).toBe(EXIT.usage);
            expect(context.io.stderr.text()).toContain("run: neore login --device --api-url https://api.test --confirm-host api.test");
            expect(urls).toEqual([]);
        });

        it("refuses a --confirm-host that is not the API host, and sends nothing", async () => {
            const { context, urls } = requests([() => Response.json(CODE_RESPONSE)]);

            expect(await run(["login", "--device", "--api-url", BASE, "--confirm-host", "evil.test"], context)).toBe(EXIT.usage);
            expect(urls).toEqual([]);
        });

        it("on a terminal, continues when the person types the host", async () => {
            const { context, urls } = requests([
                () => Response.json(CODE_RESPONSE),
                () => Response.json({ api_key: "nk_device", expires_at: null }),
                () => Response.json({ apiKeyId: "k1", scopes: [], userId: "u1" }),
            ]);

            context.stdinIsTTY = true;
            context.readLine = async () => " api.test ";

            expect(await run(["login", "--device", "--api-url", BASE], context)).toBe(EXIT.ok);
            expect(context.io.stderr.text()).toContain("sent to api.test");
            expect(urls[0]).toBe("https://api.test/api/auth/device/code");
        });

        it("on a terminal, stops when what is typed is not the host", async () => {
            const { context, urls } = requests([() => Response.json(CODE_RESPONSE)]);

            context.stdinIsTTY = true;
            context.readLine = async () => "api";

            expect(await run(["login", "--device", "--api-url", BASE], context)).toBe(EXIT.usage);
            expect(urls).toEqual([]);
        });
    });

    it("shows a copy-pasteable non-interactive sign-in command in the help", async () => {
        const context = contextFor([]);

        await run(["--help"], context);

        expect(context.io.stdout.text() + context.io.stderr.text()).toContain(
            "neore login --device --api-url https://api.example.com --confirm-host api.example.com",
        );
    });
});
