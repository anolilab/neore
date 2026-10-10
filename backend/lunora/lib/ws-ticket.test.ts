import { DatabaseSync } from "node:sqlite";

import type { D1PreparedStatementLike } from "@lunora/d1";
import { beforeEach, describe, expect, it } from "vitest";

import {
    handleWsTicketRequest,
    issueWsTicket,
    purgeExpiredWsTickets,
    redeemWsTicket,
    resetWsTicketTableForTests,
    WS_TICKET_PATH,
    WS_TICKET_TTL_MS,
} from "./ws-ticket";

/**
 * The slice of D1 the ticket store uses, over a real in-memory SQLite. Holds
 * better-auth's `session` table with a live session for every user the tests
 * redeem for, since a redeem requires one.
 */
const createDatabase = () => {
    const sqlite = new DatabaseSync(":memory:");

    sqlite.exec(`CREATE TABLE "session" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "expiresAt" REAL NOT NULL)`);

    for (const [id, userId] of [["s1", "u1"] as const, ["sa", "user-a"], ["sb", "user-b"]]) {
        sqlite.prepare(`INSERT INTO "session" ("id", "userId", "expiresAt") VALUES (?, ?, ?)`).run(id, userId, Date.now() + 60_000);
    }

    return {
        prepare: (sql: string): D1PreparedStatementLike => {
            const statement = (values: unknown[]): D1PreparedStatementLike => {
                const prepared = sqlite.prepare(sql);

                return {
                    all: async <T>() => {
                        return { results: prepared.all(...(values as never[])) as T[], success: true };
                    },
                    bind: (...next: unknown[]) => statement(next),
                    first: async <T>() => (prepared.get(...(values as never[])) ?? null) as T | null,
                    raw: async () => [],
                    run: async () => {
                        prepared.run(...(values as never[]));

                        return { success: true };
                    },
                };
            };

            return statement([]);
        },
        sqlite,
    };
};

describe("ws tickets", () => {
    let database: ReturnType<typeof createDatabase>;

    beforeEach(() => {
        resetWsTicketTableForTests();
        database = createDatabase();
    });

    it("redeems a ticket for the identity it was minted for", async () => {
        const ticket = await issueWsTicket(database, { sessionId: "s1", userId: "u1" });

        await expect(redeemWsTicket(database, ticket)).resolves.toStrictEqual({ sessionId: "s1", userId: "u1" });
    });

    it("is single-use", async () => {
        const ticket = await issueWsTicket(database, { userId: "u1" });

        await expect(redeemWsTicket(database, ticket)).resolves.toStrictEqual({ userId: "u1" });
        await expect(redeemWsTicket(database, ticket)).resolves.toBeNull();
    });

    it("refuses an expired ticket, and consumes it", async () => {
        const now = 1_000_000;
        const ticket = await issueWsTicket(database, { userId: "u1" }, now);

        await expect(redeemWsTicket(database, ticket, now + WS_TICKET_TTL_MS)).resolves.toBeNull();
        await expect(redeemWsTicket(database, ticket, now)).resolves.toBeNull();
    });

    it("binds each ticket to its own user", async () => {
        const forA = await issueWsTicket(database, { userId: "user-a" });
        const forB = await issueWsTicket(database, { userId: "user-b" });

        expect(forA).not.toBe(forB);
        await expect(redeemWsTicket(database, forB)).resolves.toStrictEqual({ userId: "user-b" });
        await expect(redeemWsTicket(database, forA)).resolves.toStrictEqual({ userId: "user-a" });
    });

    it("refuses a ticket whose session was deleted after the mint (sign-out, account deletion)", async () => {
        const ticket = await issueWsTicket(database, { sessionId: "s1", userId: "u1" });

        // What `revokeUserSessions`, the account-deletion workflow's first step, does.
        database.sqlite.prepare(`DELETE FROM "session" WHERE "userId" = ?`).run("u1");

        await expect(redeemWsTicket(database, ticket)).resolves.toBeNull();
        // Consumed all the same: a session restored later cannot revive it.
        database.sqlite.prepare(`INSERT INTO "session" ("id", "userId", "expiresAt") VALUES ('s1', 'u1', 0)`).run();
        await expect(redeemWsTicket(database, ticket)).resolves.toBeNull();
    });

    it("refuses a session-less ticket once the user has no session left", async () => {
        const ticket = await issueWsTicket(database, { userId: "user-a" });

        database.sqlite.prepare(`DELETE FROM "session" WHERE "userId" = ?`).run("user-a");

        await expect(redeemWsTicket(database, ticket)).resolves.toBeNull();
    });

    it("refuses a ticket naming another user's session", async () => {
        const ticket = await issueWsTicket(database, { sessionId: "sb", userId: "user-a" });

        await expect(redeemWsTicket(database, ticket)).resolves.toBeNull();
    });

    it("refuses, rather than throws, when the session table cannot be read", async () => {
        const ticket = await issueWsTicket(database, { sessionId: "s1", userId: "u1" });

        database.sqlite.exec(`DROP TABLE "session"`);

        await expect(redeemWsTicket(database, ticket)).resolves.toBeNull();
    });

    it("refuses a ticket it never minted", async () => {
        await issueWsTicket(database, { userId: "u1" });

        await expect(redeemWsTicket(database, "forged")).resolves.toBeNull();
    });

    it("stores only the hash, and sweeps expired rows on the next mint", async () => {
        const ticket = await issueWsTicket(database, { userId: "u1" }, 0);

        await issueWsTicket(database, { userId: "u2" }, WS_TICKET_TTL_MS);

        const rows = database.sqlite.prepare(`SELECT "hash", "userId" FROM "wsTicket"`).all() as { hash: string; userId: string }[];

        expect(rows.map((row) => row.userId)).toStrictEqual(["u2"]);
        expect(rows.some((row) => row.hash === ticket)).toBe(false);
    });
});

describe(purgeExpiredWsTickets, () => {
    let database: ReturnType<typeof createDatabase>;
    const userIds = () => (database.sqlite.prepare(`SELECT "userId" FROM "wsTicket" ORDER BY "userId"`).all() as { userId: string }[]).map((row) => row.userId);

    beforeEach(() => {
        resetWsTicketTableForTests();
        database = createDatabase();
    });

    it("deletes expired, never-redeemed tickets and keeps live ones", async () => {
        await issueWsTicket(database, { sessionId: "s1", userId: "expired" }, 0);
        await issueWsTicket(database, { userId: "live" }, 10_000);

        await purgeExpiredWsTickets(database, WS_TICKET_TTL_MS);

        expect(userIds()).toStrictEqual(["live"]);
    });

    it("deletes a ticket exactly at its expiry", async () => {
        await issueWsTicket(database, { userId: "u1" }, 0);

        await purgeExpiredWsTickets(database, WS_TICKET_TTL_MS);

        expect(userIds()).toStrictEqual([]);
    });

    it("creates the table on a database nothing has touched (fresh deploy, cron first)", async () => {
        await expect(purgeExpiredWsTickets(database)).resolves.toBeUndefined();
        expect(userIds()).toStrictEqual([]);
    });
});

describe(handleWsTicketRequest, () => {
    const post = (path = WS_TICKET_PATH) => new Request(`http://x${path}`, { method: "POST" });

    beforeEach(() => {
        resetWsTicketTableForTests();
    });

    it("mints a ticket for the resolved caller", async () => {
        const database = createDatabase();
        const response = await handleWsTicketRequest(post(), database, async () => {
            return { sessionId: "s1", userId: "u1" };
        });

        expect(response?.status).toBe(200);
        expect(response?.headers.get("cache-control")).toBe("no-store");

        const { ticket } = (await response!.json()) as { ticket: string };

        await expect(redeemWsTicket(database, ticket)).resolves.toStrictEqual({ sessionId: "s1", userId: "u1" });
    });

    it("refuses an anonymous caller", async () => {
        const response = await handleWsTicketRequest(post(), createDatabase(), async () => null);

        expect(response?.status).toBe(401);
    });

    it("refuses anything but POST", async () => {
        const response = await handleWsTicketRequest(new Request(`http://x${WS_TICKET_PATH}`), createDatabase(), async () => {
            return { userId: "u1" };
        });

        expect(response?.status).toBe(405);
    });

    it("leaves every other path to the app", async () => {
        await expect(
            handleWsTicketRequest(post("/_lunora/rpc"), createDatabase(), async () => {
                return { userId: "u1" };
            }),
        ).resolves.toBeUndefined();
    });
});
