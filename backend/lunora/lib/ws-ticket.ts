import type { D1DatabaseLike } from "@lunora/d1";
import { LunoraError } from "lunorash/server";

import { isWsReauth, requestWsTicket } from "./request-bearer";

/** Where the browser mints a ticket before each live-query socket (re)connect. */
export const WS_TICKET_PATH = "/_lunora/ws-ticket";

/** How long a minted ticket may wait for its upgrade. A connect follows the mint at once. */
export const WS_TICKET_TTL_MS = 30_000;

/**
 * Who a ticket was minted for — the identity its upgrade resolves to. A web
 * caller's ticket names its session (`sessionId`, the JWT's `sid` or the
 * cookie's); an app grant's names the grant's sign-in (`grantSessionId`, from
 * `gsid`), kept apart from `sessionId` for the reason in `src/bearer-identity.ts`.
 */
export interface WsTicketIdentity {
    grantSessionId?: string;
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
 *   is not `.global()`, see `backend/AGENTS.md`).
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
 * does a sign-out or a grant revoke, which makes each end an unredeemed ticket
 * at once.
 */
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS "wsTicket" ("hash" TEXT PRIMARY KEY NOT NULL, "userId" TEXT NOT NULL, "sessionId" TEXT, "grantSessionId" TEXT, "expiresAt" INTEGER NOT NULL)`;

/**
 * `grantSessionId` came after the table first shipped, and `CREATE TABLE IF NOT
 * EXISTS` leaves an existing table as it is, so the column is added here. On a
 * table that already has it SQLite answers "duplicate column name", which is
 * the expected answer; anything else is a real failure.
 */
const ADD_GRANT_SESSION_COLUMN = `ALTER TABLE "wsTicket" ADD COLUMN "grantSessionId" TEXT`;
const DUPLICATE_COLUMN = /duplicate column/iu;

const addGrantSessionColumn = async (database: TicketDatabase): Promise<void> => {
    try {
        await database.prepare(ADD_GRANT_SESSION_COLUMN).run();
    } catch (error) {
        if (!DUPLICATE_COLUMN.test(error instanceof Error ? error.message : String(error))) {
            throw error;
        }
    }
};

let ensured: Promise<unknown> | undefined;

const ensureTable = async (database: TicketDatabase): Promise<void> => {
    // Memoised per isolate, like `ensureGlobalTables`; a failure clears it so the
    // next request retries instead of caching a broken database.
    ensured ??= (async () => {
        await database.prepare(CREATE_TABLE).run();
        await addGrantSessionColumn(database);
    })().catch((error: unknown) => {
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
        .prepare(`INSERT INTO "wsTicket" ("hash", "userId", "sessionId", "grantSessionId", "expiresAt") VALUES (?, ?, ?, ?, ?)`)
        .bind(await sha256(ticket), identity.userId, identity.sessionId ?? null, identity.grantSessionId ?? null, now + WS_TICKET_TTL_MS)
        .run();

    return ticket;
};

/** A session read that could not answer: neither live nor gone. */
type SessionLiveness = boolean | "unknown";

/**
 * A redeem whose session check could not be read. Thrown, never answered as
 * "signed out": the runtime turns it into a 503 on `/_lunora/ws/reauth`, and
 * `src/server.ts` does the same on the upgrade, so the socket keeps no
 * identity it was not confirmed to have and the client reconnects with a
 * fresh ticket. The ticket itself is already spent, which costs nothing: the
 * client mints a new one for every connect and every re-authentication.
 */
export class WsTicketUnavailableError extends LunoraError {
    public constructor(cause?: unknown) {
        super("SERVICE_UNAVAILABLE", "The live-query session could not be checked; try again", { cause });
    }
}

/** The 503 for a session read that failed; the client retries it. */
export const wsTicketUnavailableResponse = (): Response =>
    Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Try again shortly" } }, { headers: { "cache-control": "no-store" }, status: 503 });

/**
 * The 503 for an RPC or socket call whose caller could not be checked (a session or key read that failed). Its code is
 * one the client's replay retries (`SHARD_UNAVAILABLE`), so a queued write is sent again rather than settled as refused.
 */
export const callerUnavailableResponse = (): Response =>
    Response.json({ error: { code: "SHARD_UNAVAILABLE", message: "Try again shortly" } }, { headers: { "cache-control": "no-store" }, status: 503 });

const readSession = async (database: TicketDatabase, sql: string, values: (number | string)[]): Promise<SessionLiveness> => {
    try {
        const row = await database
            .prepare(sql)
            .bind(...values)
            .first();

        return row !== null;
    } catch (error) {
        console.warn("ws-ticket: the session table could not be read", error);

        return "unknown";
    }
};

/** Whether the session `id` of `userId` still exists and has not expired; `"unknown"` when the read failed. */
const lookUpSession = async (database: TicketDatabase, id: string, userId: string, now = Date.now()): Promise<SessionLiveness> =>
    await readSession(database, `SELECT 1 AS "live" FROM "session" WHERE "id" = ? AND "userId" = ? AND "expiresAt" > ? LIMIT 1`, [id, userId, now]);

/**
 * Whether every sign-in a ticket was minted under still exists: its web session
 * (`sessionId`) and its app grant (`grantSessionId`), each by exact id — so a
 * grant revoked between mint and redeem cannot ride another live session of the
 * user. A ticket naming neither (a bearer minted before `sid` was added) needs
 * any session of the user. Reads better-auth's `session` table, which lives in
 * the same D1 database. A session past its `expiresAt` (ms, as better-auth
 * stores it) counts as gone, so an expired grant whose bearer is still valid
 * gets no ticket and redeems none; beyond that this catches a session DELETED since, by
 * sign-out, a grant revoke or account deletion
 * (`gdpr_steps_deletion_steps.revokeUserSessions`). A gone session wins over a
 * failed read; with none gone, a failed read is `"unknown"`.
 */
const hasLiveSession = async (database: TicketDatabase, identity: WsTicketIdentity): Promise<SessionLiveness> => {
    const named = [identity.sessionId, identity.grantSessionId].filter((id): id is string => id !== undefined);

    if (named.length === 0) {
        return await readSession(database, `SELECT 1 AS "live" FROM "session" WHERE "userId" = ? AND "expiresAt" > ? LIMIT 1`, [identity.userId, Date.now()]);
    }

    const live = await Promise.all(named.map(async (id) => await lookUpSession(database, id, identity.userId)));

    if (live.includes(false)) {
        return false;
    }

    return live.includes("unknown") ? "unknown" : true;
};

/**
 * Exchanges a ticket for the identity it was minted for — once. The row is
 * deleted by the same statement that reads it, so two upgrades racing on one
 * ticket cannot both win. An expired ticket is consumed and refused, and so is
 * one whose session has been deleted since it was minted. When that session
 * cannot be read, it throws {@link WsTicketUnavailableError}.
 */
export const redeemWsTicket = async (database: TicketDatabase, ticket: string, now = Date.now()): Promise<WsTicketIdentity | null> => {
    await ensureTable(database);

    const row = await database
        .prepare(`DELETE FROM "wsTicket" WHERE "hash" = ? RETURNING "userId", "sessionId", "grantSessionId", "expiresAt"`)
        .bind(await sha256(ticket))
        .first<{ expiresAt: number; grantSessionId: string | null; sessionId: string | null; userId: string }>();

    if (!row || row.expiresAt <= now) {
        return null;
    }

    const identity: WsTicketIdentity = {
        userId: row.userId,
        ...(row.sessionId !== null && { sessionId: row.sessionId }),
        ...(row.grantSessionId !== null && { grantSessionId: row.grantSessionId }),
    };

    const live = await hasLiveSession(database, identity);

    if (live === "unknown") {
        throw new WsTicketUnavailableError();
    }

    return live ? identity : null;
};

/**
 * Who a request's live-query ticket stands for, else `fallback` (the bearer,
 * then the cookie).
 *
 * A spent, expired or forged ticket on the socket's UPGRADE falls through, the
 * way a stale bearer does: a web socket under a cookie still connects. On the
 * re-authentication of an open socket it does not. The ticket is the credential
 * that request presents, so a refused one ends the socket's authentication: the
 * runtime answers 401, and the socket lapses at its revalidation deadline
 * instead of being kept signed in by whatever else rode the request.
 *
 * A ticket whose session could not be read throws {@link WsTicketUnavailableError}
 * on both, instead of falling through or ending the authentication.
 */
export const resolveWsTicketIdentity = async <Identity>(
    request: Request,
    database: TicketDatabase,
    fallback: (request: Request) => Promise<Identity | null>,
): Promise<Identity | WsTicketIdentity | null> => {
    const ticket = requestWsTicket(request);

    if (ticket === undefined) {
        return await fallback(request);
    }

    const identity = await redeemWsTicket(database, ticket);

    if (identity) {
        return identity;
    }

    return isWsReauth(request) ? null : await fallback(request);
};

/**
 * `POST /_lunora/ws-ticket` — answers `{ ticket }` for an authenticated caller,
 * 401 for anyone else. `undefined` for every other request, so the caller falls
 * through to the app.
 *
 * An app grant's JWT (`grantSessionId`, from `gsid`) outlives a revoke until it
 * expires. Its ticket names the grant (never as `sessionId`), and both ends
 * check it: once the grant is revoked no ticket is minted, a ticket minted just
 * before is refused at redeem, and the grant's open sockets are cut at their
 * next re-authentication.
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

    if (identity.grantSessionId !== undefined) {
        const grant = await lookUpSession(database, identity.grantSessionId, identity.userId);

        // A failed read is not a sign-out: a 401 would open the socket anonymously, a 503 makes the client retry.
        if (grant === "unknown") {
            return wsTicketUnavailableResponse();
        }

        if (!grant) {
            return Response.json({ error: { code: "UNAUTHENTICATED", message: "A ticket needs a signed-in caller" } }, { headers, status: 401 });
        }
    }

    const ticket = await issueWsTicket(database, { grantSessionId: identity.grantSessionId, sessionId: identity.sessionId, userId: identity.userId });

    return Response.json({ expiresInMs: WS_TICKET_TTL_MS, ticket }, { headers });
};
