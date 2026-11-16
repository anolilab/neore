/**
 * Which Durable Object the auth hooks land on is a data-placement property the
 * unit harness cannot see: it is one database, so a hook writing to the wrong
 * shard passes every other test. This drives the REAL `createShardClient` over a
 * fake namespace and records the name each call resolves.
 *
 * The expected shard is the user's own: every request of theirs lands there
 * (`src/shard-routing.ts`), so defaults seeded anywhere else are never read and
 * a cascade run anywhere else deletes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lunora/auth", async (importOriginal) => {
    const original = await importOriginal<typeof import("@lunora/auth")>();

    // `createAuth` needs a live D1; returning the options exposes the hooks.
    return {
        ...original,
        createAuth: (options: unknown) => options,
        lunoraD1Adapter: () => {
            return {};
        },
    };
});

const fakeShardNamespace = (names: string[]) => {
    const stub = { fetch: async () => Response.json({ result: null }) };

    return {
        get: (id: string) => {
            names.push(id);

            return stub;
        },
        idFromName: (name: string) => name,
    };
};

interface Hooks {
    databaseHooks: {
        user: { create: { after: (user: { id: string }) => Promise<void> }; update: { after: (user: { id: string }) => Promise<void> } };
    };
}

// Each test re-imports `./auth` cold after `vi.resetModules()`; under full-suite
// load that import alone can exceed the 5s default.
describe("auth hook shard placement", { timeout: 30_000 }, () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("seeds defaults and promotes admins on the user's own shard", async () => {
        const names: string[] = [];
        const { buildAuth } = await import("./auth");
        const auth = buildAuth({
            AUTH_SECRET: "test-secret-not-the-default",
            DB: {} as never,
            SHARD: fakeShardNamespace(names) as never,
        }) as unknown as Hooks;

        await auth.databaseHooks.user.create.after({ id: "user-a" });
        await auth.databaseHooks.user.update.after({ id: "user-a" });

        expect(names).toStrictEqual(["user-a", "user-a"]);
    });

    it("runs the deletion cascade on the user's shard, where their rows live", async () => {
        const names: string[] = [];
        const { deleteUserCascade } = await import("./auth");

        await deleteUserCascade({ AUTH_SECRET: "test-secret-not-the-default", DB: {} as never, SHARD: fakeShardNamespace(names) as never }, "user-a");

        expect(names).toStrictEqual(["user-a"]);
    });

    it("issues a headless machine's code and serves its pairing route", async () => {
        const { betterAuth } = await import("better-auth");
        const { memoryAdapter } = await import("better-auth/adapters/memory");
        const { buildAuth } = await import("./auth");
        const names: string[] = [];
        const built = buildAuth({ AUTH_SECRET: "test-secret-not-the-default", DB: {} as never, SHARD: fakeShardNamespace(names) as never }) as unknown as {
            plugins: { id: string }[];
        };
        // The production device-code plugins, as `buildAuth` wires them.
        const auth = betterAuth({
            baseURL: "http://localhost:3000",
            database: memoryAdapter({ deviceCode: [], rateLimit: [], session: [], user: [], verification: [] }),
            plugins: built.plugins.filter(({ id }) => id === "device-authorization" || id === "neore-cli-device-key") as never,
            rateLimit: { enabled: false },
            secret: "a-test-secret-that-is-long-enough-for-better-auth",
            telemetry: { enabled: false },
        });
        const post = async (path: string, body: unknown) =>
            await auth.handler(
                new Request(`http://localhost:3000/api/auth${path}`, {
                    body: JSON.stringify(body),
                    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
                    method: "POST",
                }),
            );

        const host = await post("/device/code", { client_id: "neore-host", hostname: "box", platform: "linux", storage: "file" });

        const pairing = await post("/device/host", { client_id: "neore-host", device_code: "x" });
        // The CLI's own sign-in still issues.
        const cli = await post("/device/code", { client_id: "neore-cli", hostname: "box" });

        expect(host.status).toBe(200);
        // The route exists: the plugin answers an unknown code itself.
        expect(pairing.status).toBe(400);
        expect(((await pairing.json()) as { error: string }).error).toBe("invalid_grant");
        expect(cli.status).toBe(200);
    });

    it("runs both steps of a pairing on the approving account's own shard", async () => {
        const names: string[] = [];
        const { betterAuth } = await import("better-auth");
        const { memoryAdapter } = await import("better-auth/adapters/memory");
        const { buildAuth } = await import("./auth");
        const namespace = {
            get: (id: string) => {
                names.push(id);

                return { fetch: async () => Response.json({ result: { deviceId: "device-1", secret: "s".repeat(64) } }) };
            },
            idFromName: (name: string) => name,
        };
        const built = buildAuth({ AUTH_SECRET: "test-secret-not-the-default", DB: {} as never, SHARD: namespace as never }) as unknown as {
            plugins: { id: string }[];
        };
        const now = new Date();
        const auth = betterAuth({
            baseURL: "http://localhost:3000",
            database: memoryAdapter({
                deviceCode: [
                    {
                        clientId: "neore-host",
                        deviceCode: "approved-device-code",
                        expiresAt: new Date(now.getTime() + 600_000),
                        hostname: "box",
                        id: "code-1",
                        platform: "linux",
                        status: "approved",
                        storage: "file",
                        userCode: "ABCDEFGH",
                        userId: "user-a",
                    },
                ],
                rateLimit: [],
                session: [],
                user: [{ createdAt: now, email: "a@example.test", emailVerified: true, id: "user-a", name: "A", updatedAt: now }],
                verification: [],
            }),
            plugins: built.plugins.filter(({ id }) => id === "device-authorization" || id === "neore-cli-device-key") as never,
            rateLimit: { enabled: false },
            secret: "a-test-secret-that-is-long-enough-for-better-auth",
            telemetry: { enabled: false },
        });
        const response = await auth.handler(
            new Request("http://localhost:3000/api/auth/device/host", {
                body: JSON.stringify({ client_id: "neore-host", device_code: "approved-device-code" }),
                headers: { "content-type": "application/json", origin: "http://localhost:3000" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(200);
        // The check before the code is spent and the registration after it, both on the account's shard.
        expect(names).toStrictEqual(["user-a", "user-a"]);
    });

    it("keeps the device-limit marker of a refusal that crosses the shard call", async () => {
        const { createShardClient } = await import("lunorash/runtime");
        const { LunoraError, toErrorBody } = await import("lunorash/errors");
        const { DEVICE_LIMIT_CODE } = await import("./devices/lib/constants");
        // What the shard answers for a thrown LunoraError (`errorToResponse` in @lunora/do builds the same body).
        const refusal = new LunoraError("BAD_REQUEST", "At most 10 devices can be paired. Remove one first.", { data: { code: DEVICE_LIMIT_CODE } });
        const { body, status } = toErrorBody(refusal, { encodeData: (data: unknown) => data });
        const namespace = {
            get: () => {
                return { fetch: async () => Response.json({ error: body }, { status }) };
            },
            idFromName: (name: string) => name,
        };

        const caught = await createShardClient(namespace as never)
            .call("devices/internal:checkHeadlessPairing", {}, { shardKey: "user-a" })
            .catch((error: unknown) => error as { code?: string; data?: { code?: string } });

        expect(caught).toMatchObject({ code: "BAD_REQUEST", data: { code: DEVICE_LIMIT_CODE } });
    });
});
