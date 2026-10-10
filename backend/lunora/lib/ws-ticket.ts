import type { D1DatabaseLike } from "@lunora/d1";

/** Where the browser mints a ticket before each live-query socket (re)connect. */
export const WS_TICKET_PATH = "/_lunora/ws-ticket";

/** How long a minted ticket may wait for its upgrade. A connect follows the mint at once. */
export const WS_TICKET_TTL_MS = 30_000;

/** Who a ticket was minted for — the identity its upgrade resolves to. */
export interface WsTicketIdentity {
    sessionId?: string;
    userId: string;
}

type TicketDatabase = Pick<D1DatabaseLike, "prepare">;

/**
 * Raw SQL rather than a `schema.ts` table, for two reasons:
 *
 * - The ticket is redeemed inside `resolveIdentity`, which runs before any
 *   procedure and so has no `ctx.db`.
 * - Single use needs take-and-delete in ONE statement. The ORM facade has no
 *   delete-returning, and `findFirst` + `delete` on a `.global()` table is two
 *   D1 round trips with no Durable Object input gate between them — two
 *   upgrades racing on one ticket could both win (the same reason `rateLimits`
 *   is not `.global()`, see AGENTS.md).
 *
 * The table is created LAZILY by the statement below, once per isolate, before
 * the first mint, redeem or purge touches it — the same model as Lunora's own
 * `.global()` tables and `ensureGlobalTables`. There is no migration and no
 * schema baseline entry, so local dev, CI (tests run it against in-memory
 * SQLite) and a fresh deploy all get it on first use with no extra step, and
 * `lunora build`'s drift gate never sees it.
 *
 * Only the SHA-256 of a ticket is stored, so a leaked row cannot be replayed.
 * Retention: a row lives until it is redeemed, or at most ~1 minute past its
 * 30s expiry — every mint sweeps expired rows, and so does the Worker's cron
 * tick (`purgeExpiredWsTickets` in `src/server.ts#scheduled`), which covers a
 * quiet period with no mints. That bound is what the GDPR notes rely on
 * (`gdpr/README.md`): account deletion does not have to visit this table.
 * What it cannot bound is a ticket minted just BEFORE the deletion — so a
 * redeem also requires the session behind the ticket to still exist
 * (`hasLiveSession`). Deletion revokes every session in its first step, and so
 * does a sign-out, which makes both end an unredeemed ticket at once.
 */
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS "wsTicket" ("hash" TEXT PRIMARY KEY NOT NULL, "userId" TEXT NOT NULL, "sessionId" TEXT, "expiresAt" INTEGER NOT NULL)`;

let ensured: Promise<unknown> | undefined;

const ensureTable = async (database: TicketDatabase): Promise<void> => {
    // Memoised per isolate, like `ensureGlobalTables`; a failure clears it so the
    // next request retries instead of caching a broken database.
    ensured ??= database
        .prepare(CREATE_TABLE)
        .run()
        .catch((error: unknown) => {
            ensured = undefined;

            throw error;
        });

    await ensured;
};

/** For tests: forget that this isolate created the table. */
export const resetWsTicketTableForTests = (): void => {
    ensured = undefined;
};

const sha256 = async (value: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const randomTicket = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));

    return btoa(String.fromCodePoint(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
};

/** Deletes every expired ticket, redeemed or not. Run on each mint and on the cron tick. */
export const purgeExpiredWsTickets = async (database: TicketDatabase, now = Date.now()): Promise<void> => {
    await ensureTable(database);
    await database.prepare(`DELETE FROM "wsTicket" WHERE "expiresAt" <= ?`).bind(now).run();
};

/** Mints a single-use ticket bound to `identity`, and sweeps expired ones. */
export const issueWsTicket = async (database: TicketDatabase, identity: WsTicketIdentity, now = Date.now()): Promise<string> => {
    const ticket = randomTicket();

    await purgeExpiredWsTickets(database, now);
    await database
        .prepare(`INSERT INTO "wsTicket" ("hash", "userId", "sessionId", "expiresAt") VALUES (?, ?, ?, ?)`)
        .bind(await sha256(ticket), identity.userId, identity.sessionId ?? null, now + WS_TICKET_TTL_MS)
        .run();

    return ticket;
};

/**
 * Whether the session a ticket was minted under still exists: that exact
 * session when the ticket names one, else any session of the user (a bearer
 * minted before `sid` was added names none). Reads better-auth's `session`
 * table, which lives in the same D1 database. Expiry is not re-checked — the
 * caller was verified at mint, 30s ago at most; what this catches is a session
 * DELETED since, by sign-out, revocation or account deletion
 * (`gdpr_steps_deletion_steps.revokeUserSessions`). A failed read refuses the
 * ticket: the upgrade then falls through to the cookie, like a spent one.
 */
const hasLiveSession = async (database: TicketDatabase, identity: WsTicketIdentity): Promise<boolean> => {
    try {
        const row =
            identity.sessionId === undefined
                ? await database.prepare(`SELECT 1 AS "live" FROM "session" WHERE "userId" = ? LIMIT 1`).bind(identity.userId).first()
                : await database
                      .prepare(`SELECT 1 AS "live" FROM "session" WHERE "id" = ? AND "userId" = ? LIMIT 1`)
                      .bind(identity.sessionId, identity.userId)
                      .first();

        return row !== null;
    } catch {
        return false;
    }
};

/**
 * Exchanges a ticket for the identity it was minted for — once. The row is
 * deleted by the same statement that reads it, so two upgrades racing on one
 * ticket cannot both win. An expired ticket is consumed and refused, and so is
 * one whose session has been deleted since it was minted.
 */
export const redeemWsTicket = async (database: TicketDatabase, ticket: string, now = Date.now()): Promise<WsTicketIdentity | null> => {
    await ensureTable(database);

    const row = await database
        .prepare(`DELETE FROM "wsTicket" WHERE "hash" = ? RETURNING "userId", "sessionId", "expiresAt"`)
        .bind(await sha256(ticket))
        .first<{ expiresAt: number; sessionId: string | null; userId: string }>();

    if (!row || row.expiresAt <= now) {
        return null;
    }

    const identity: WsTicketIdentity = { userId: row.userId, ...(row.sessionId !== null && { sessionId: row.sessionId }) };

    return (await hasLiveSession(database, identity)) ? identity : null;
};

/**
 * `POST /_lunora/ws-ticket` — answers `{ ticket }` for an authenticated caller,
 * 401 for anyone else. `undefined` for every other request, so the caller falls
 * through to the app.
 */
export const handleWsTicketRequest = async (
    request: Request,
    database: TicketDatabase,
    resolveIdentity: (request: Request) => Promise<WsTicketIdentity | null>,
): Promise<Response | undefined> => {
    if (new URL(request.url).pathname !== WS_TICKET_PATH) {
        return undefined;
    }

    const headers = { "cache-control": "no-store" };

    if (request.method !== "POST") {
        return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } }, { headers: { ...headers, allow: "POST" }, status: 405 });
    }

    const identity = await resolveIdentity(request);

    if (!identity) {
        return Response.json({ error: { code: "UNAUTHENTICATED", message: "A ticket needs a signed-in caller" } }, { headers, status: 401 });
    }

    const ticket = await issueWsTicket(database, { sessionId: identity.sessionId, userId: identity.userId });

    return Response.json({ expiresInMs: WS_TICKET_TTL_MS, ticket }, { headers });
};
