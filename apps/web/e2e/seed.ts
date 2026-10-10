/**
 * Seeds invitations through the LOCAL backend's e2e route.
 *
 * Registration is invite-only, and the app has no way to mint an invitation
 * without an admin: `createInvitation` is `adminAction`, and the operator's
 * `POST /admin/seed-invitations` only invites the addresses in `ADMIN`. So the
 * backend has a route for this suite alone, `POST /e2e/invitations`
 * (`backend/lunora/auth/e2e-seed-http.ts`), which answers 404 anywhere but a
 * local development stack holding `E2E_SEED_TOKEN`. That token lives in the
 * gitignored `backend/.dev.vars` (`scripts/dev-setup.js`, CI's e2e job), and is
 * read from there unless the environment already carries it.
 *
 * It replaced writing the `signUpInvitation` row into the miniflare SQLite file
 * directly, which contended with workerd's own writes ("database is locked").
 * Reads for assertions ({@link queryBackend}) still open that file, read-only.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_BASE_URL, AUTH_API_BASE, LUNORA_URL } from "./fixtures";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../backend");
const D1_DIR = path.join(BACKEND_DIR, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const SHARD_DO_DIR = path.join(BACKEND_DIR, ".wrangler/state/v3/do/neore-backend-ShardDO");

const LOCAL_URL = /localhost|127\.0\.0\.1/;
const DEV_VARS_LINE = /^E2E_SEED_TOKEN="?([^"\s]+)/m;

const authHeaders = { "Content-Type": "application/json", Origin: APP_BASE_URL };

/** The minimum a user fixture carries. */
export interface SeedUser {
    email: string;
    name: string;
    password: string;
}

type SqliteDatabase = {
    close: () => void;
    exec: (sql: string) => void;
    prepare: (sql: string) => { all: (...values: unknown[]) => unknown[] };
};

/**
 * `node:sqlite` is loaded lazily so a spec that never reads does not pay its
 * ExperimentalWarning, and so a Node without it fails at the call with a reason.
 * Read-only: every write goes through the backend.
 */
const openDatabase = async (file: string): Promise<SqliteDatabase> => {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
        DatabaseSync: new (file: string, options: { readOnly: boolean }) => SqliteDatabase;
    };

    const database = new DatabaseSync(file, { readOnly: true });

    // workerd holds the same file open and writes to it; wait for its lock
    // rather than failing with SQLITE_BUSY ("database is locked").
    database.exec("PRAGMA busy_timeout = 15000");

    return database;
};

/** The backend's D1 file — the one that holds the better-auth `user` table. */
export const findBackendDatabase = async (): Promise<string> => {
    if (!LOCAL_URL.test(LUNORA_URL)) {
        throw new Error(`[e2e] Refusing to seed a non-local backend: ${LUNORA_URL}`);
    }

    if (!existsSync(D1_DIR)) {
        throw new Error(`[e2e] No local D1 state at ${D1_DIR} — is \`lunora dev\` running from backend/?`);
    }

    for (const name of readdirSync(D1_DIR)) {
        if (!name.endsWith(".sqlite") || name === "metadata.sqlite") {
            continue;
        }

        const file = path.join(D1_DIR, name);
        const database = await openDatabase(file);

        try {
            if (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'").all().length > 0) {
                return file;
            }
        } finally {
            database.close();
        }
    }

    throw new Error(`[e2e] No D1 file under ${D1_DIR} has a \`user\` table yet — load any page once so the backend creates it.`);
};

/** What a POST to better-auth answered — the common shape of `fetch` and Playwright's request API. */
interface AuthReply {
    headers: Record<string, string>;
    status: number;
    text: string;
}

/** Sends one POST to an auth path; `seed` uses Node's fetch, specs pass their browser context's request API. */
export type AuthPoster = (route: string, body: Record<string, unknown>) => Promise<AuthReply>;

export const fetchPoster: AuthPoster = async (route, body) => {
    const response = await fetch(`${AUTH_API_BASE}${route}`, { body: JSON.stringify(body), headers: authHeaders, method: "POST" });

    return { headers: Object.fromEntries(response.headers), status: response.status, text: await response.text() };
};

/**
 * Retries a 429 or 503. Better-auth rate-limits sign-in and sign-up per IP (a handful per ten
 * seconds), and every spec here shares one IP; and a dev worker that restarted
 * mid-request answers 503. Both are pacing signals, not a
 * failure: wait as long as the server says and try again.
 */
const postWithRetry = async (post: AuthPoster, route: string, body: Record<string, unknown>): Promise<AuthReply> => {
    for (let attempt = 0; ; attempt += 1) {
        const reply = await post(route, body);

        if ((reply.status !== 429 && reply.status !== 503) || attempt >= 6) {
            return reply;
        }

        const seconds = Number(reply.headers["x-retry-after"] ?? reply.headers["retry-after"]) || 10;

        await new Promise((resolve) => {
            setTimeout(resolve, (seconds + 1) * 1000);
        });
    }
};

/** The token that unlocks `POST /e2e/invitations`: the environment's, else `backend/.dev.vars`'. */
const seedToken = (): string => {
    const fromEnvironment = process.env["E2E_SEED_TOKEN"];

    if (fromEnvironment) {
        return fromEnvironment;
    }

    const developmentVariables = path.join(BACKEND_DIR, ".dev.vars");
    const token = existsSync(developmentVariables) ? DEV_VARS_LINE.exec(readFileSync(developmentVariables, "utf8"))?.[1] : undefined;

    if (!token) {
        throw new Error("[e2e] No E2E_SEED_TOKEN in the environment or backend/.dev.vars — run `node scripts/dev-setup.js` and restart the backend.");
    }

    return token;
};

/** Invite `email` and return the plaintext token — the `?invite=` value. Re-inviting replaces the token. */
export const inviteEmail = async (email: string): Promise<string> => {
    if (!LOCAL_URL.test(LUNORA_URL)) {
        throw new Error(`[e2e] Refusing to seed a non-local backend: ${LUNORA_URL}`);
    }

    const token = seedToken();

    // A 503 is a dev worker that restarted mid-request: retry it, like the auth calls.
    for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(`${LUNORA_URL}/e2e/invitations`, {
            body: JSON.stringify({ email }),
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            method: "POST",
        });

        if (response.ok) {
            return ((await response.json()) as { token: string }).token;
        }

        const text = await response.text();

        if (response.status !== 503 || attempt >= 6) {
            // A 404 means the route is off: the backend was started before
            // E2E_SEED_TOKEN was in its `.dev.vars`, or is not a development stack.
            throw new Error(`[e2e] Inviting ${email} failed (${String(response.status)}): ${text}`);
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 2000);
        });
    }
};

/** The sign-up URL an invited visitor would follow. */
export const inviteLink = async (email: string): Promise<string> => `/auth/sign-up?invite=${encodeURIComponent(await inviteEmail(email))}`;

/**
 * Register `user` with a fresh invitation. Sent through `post`, so when a spec
 * passes its browser context's request API the session cookie better-auth sets
 * on sign-up lands in that context — signed in without a second auth call.
 */
export const signUpInvited = async (user: SeedUser, post: AuthPoster = fetchPoster): Promise<void> => {
    const inviteToken = await inviteEmail(user.email);
    const reply = await postWithRetry(post, "/sign-up/email", { email: user.email, inviteToken, name: user.name, password: user.password });

    if (reply.status >= 400) {
        throw new Error(`[e2e] Seeding ${user.email} failed (${String(reply.status)}): ${reply.text}`);
    }
};

/**
 * Make sure a long-lived `user` (the shared TEST_USER) exists and can sign in.
 * Idempotent: an account that already signs in is left alone. Through a browser
 * context's `post`, that context ends up signed in either way.
 */
export const ensureInvitedUser = async (user: SeedUser, post: AuthPoster = fetchPoster): Promise<void> => {
    const probe = await postWithRetry(post, "/sign-in/email", { email: user.email, password: user.password });

    if (probe.status < 400) {
        return;
    }

    await signUpInvited(user, post);
};

/** Run a read against the local backend database — for asserting rows are gone. */
export const queryBackend = async <T>(sql: string, ...values: unknown[]): Promise<T[]> => {
    const database = await openDatabase(await findBackendDatabase());

    try {
        return database.prepare(sql).all(...values) as T[];
    } finally {
        database.close();
    }
};

/**
 * The local SQLite file of `userId`'s own shard (docs/plans/per-user-sharding.md)
 * — found by its `userSettings` row, which sign-up seeds there. `undefined` when
 * none holds one yet. Miniflare names the files by object id, not by name.
 */
export const findShardDatabase = async (userId: string): Promise<string | undefined> => {
    if (!existsSync(SHARD_DO_DIR)) {
        return undefined;
    }

    for (const name of readdirSync(SHARD_DO_DIR)) {
        if (!name.endsWith(".sqlite")) {
            continue;
        }

        const file = path.join(SHARD_DO_DIR, name);
        const database = await openDatabase(file);

        try {
            const found = database.prepare(`SELECT 1 FROM "userSettings" WHERE instr("__doc__", ?) > 0 LIMIT 1`).all(userId);

            if (found.length > 0) {
                return file;
            }
        } catch {
            // A shard that never created `userSettings`.
        } finally {
            database.close();
        }
    }

    return undefined;
};

/** Rows of `file` (a shard) that mention `userId` anywhere, by table. Tables with none are left out. */
export const shardRowsMentioning = async (file: string, userId: string): Promise<Record<string, number>> => {
    const database = await openDatabase(file);

    try {
        const tables = database
            .prepare(String.raw`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\_%' ESCAPE '\' AND name NOT LIKE 'sqlite%'`)
            .all() as {
            name: string;
        }[];
        const counts: Record<string, number> = {};

        for (const { name } of tables) {
            try {
                const [row] = database.prepare(`SELECT count(*) AS n FROM "${name}" WHERE instr("__doc__", ?) > 0`).all(userId) as { n: number }[];

                if (row && row.n > 0) {
                    counts[name] = row.n;
                }
            } catch {
                // Not a row table (an index or FTS shadow table has no `__doc__`).
            }
        }

        return counts;
    } finally {
        database.close();
    }
};
