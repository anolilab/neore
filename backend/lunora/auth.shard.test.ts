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
});
