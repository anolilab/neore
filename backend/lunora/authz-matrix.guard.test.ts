/**
 * Keeps `docs/security/authz-matrix.md` and the client-reachable surface in step.
 *
 * Each public procedure's own check is the primary access control; row-level
 * security (`lib/rls/`, see `CLAUDE.md` → Auth) only refuses callers with no
 * connection to a row at all. The matrix is where each one's check was
 * reviewed, so this fails when a procedure reaches `_generated/api.ts` without a
 * row — or a row outlives its procedure.
 *
 * Why names, not types. A type-level guard ("a public query must not return a
 * `Doc<…>`") sounds sharper but misfires both ways here: owner-checked
 * procedures legitimately return full rows, and a leaking procedure can return a
 * hand-written shape. What actually went wrong in every hole the audit found was
 * that nobody had looked — so the guard forces the look, and costs one table row.
 *
 * The second pin is narrower and stricter: procedures built WITHOUT auth
 * middleware (bare `query`/`mutation`/`action`, `public*`, `optionalAuth*`) must
 * each be listed below by name. Those resolve identity themselves or not at all,
 * and a new one should be a deliberate decision, not a copy-paste.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REFERENCE = /__lunoraRef: "([a-z0-9_]+):(\w+)"/gu;
const byName = (a: string, b: string): number => a.localeCompare(b);

const LUNORA = dirname(fileURLToPath(import.meta.url));
const MATRIX = join(LUNORA, "..", "..", "docs", "security", "authz-matrix.md");

/**
 * `module.procedure` for every reference in the generated `api` object — the
 * client-reachable half (`internal` lives in `internal.ts`). Read off each
 * reference's dispatch key, whose module stays flat (`agent_threads`) while
 * `api.agent.threads` nests.
 */
const publicProcedures = (): string[] => {
    const source = readFileSync(join(LUNORA, "_generated", "api.ts"), "utf8");
    const start = source.indexOf("export const api: ApiTypes = {");
    const end = source.indexOf("\n};\n", start);

    expect(start, "the api object not found in _generated/api.ts").toBeGreaterThanOrEqual(0);

    return [...source.slice(start, end).matchAll(REFERENCE)].map((match) => `${match[1] as string}.${match[2] as string}`).toSorted(byName);
};

/** The first column of the "Procedures" table. */
const matrixRows = (): string[] => {
    const markdown = readFileSync(MATRIX, "utf8");
    const section = markdown.slice(markdown.indexOf("## Procedures"), markdown.indexOf("\n## ", markdown.indexOf("## Procedures") + 1));

    return [...section.matchAll(/^\| `([a-z0-9_]+\.\w+)` \|/gmu)].map((match) => match[1] as string).toSorted(byName);
};

/**
 * Procedures with NO auth middleware, by file. Bare builders resolve identity in
 * the handler (`getAuthUserIdentity`); `public*` are unauthenticated on purpose;
 * `optionalAuth*` run with `ctx.user = null` for guests.
 */
const NO_AUTH_MIDDLEWARE: Record<string, string[]> = {
    "agent/document-history.ts": ["getVersion", "listVersions"],
    "agent/documents.ts": ["getDocument", "getDocumentByMessage", "getDocumentsByThread"],
    "agent/messages.ts": ["listMessagesByThreadId"],
    "agent/projects.ts": ["getProject", "listPinnedProjects", "listProjects", "listThreadsByProject"],
    "agent/streams.ts": ["list", "listDeltas"],
    "agent/threads.ts": [
        "getChildThreads",
        "getTemporaryThread",
        "getTemporaryThreads",
        "getTemporaryThreadsByThreadIds",
        "getThread",
        "getThreadListDataBatch",
        "getThreadRelationship",
        "getThreadUsage",
        "listPinnedThreads",
        "listThreadOrders",
        "listThreadsByUserId",
        "searchThreadsByTitleAndSummary",
        "searchThreadTitles",
    ],
    "agent/workflow-executions.ts": ["get", "listByProject"],
    "auth/functions.ts": [
        "getAIUserPreferences",
        "getCurrentUser",
        "getSessionUserQuery",
        "getUserSettings",
        "hasPassword",
    ],
    "changelog/functions.ts": ["getChangelogs"],
    "chat/functions.ts": ["getAnonymousMessageLimit", "getMessageRateLimit", "getThread", "validateThreadExists"],
    "chat/sharing.ts": ["getPublicThread"],
    "chat/streaming/index.ts": ["getActiveStreamForThread", "getStreamBody"],
    "pages/sharing.ts": ["getPublicPage"],
    "workflow/gallery.ts": ["browseGallery", "getFeaturedWorkflows", "getPublicWorkflow"],
};

const NO_AUTH_BUILDERS = /^export const (\w+) = (query|mutation|action|publicQuery|publicMutation|publicAction|optionalAuthQuery|optionalAuthMutation)\b/gmu;

/** `relative()` with POSIX separators, so the keys below hold on Windows too. */
const fromLunora = (file: string): string => relative(LUNORA, file).split(sep).join("/");

const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            return entry.name === "_generated" || entry.name === "node_modules" ? [] : sourceFiles(path);
        }

        // `lib/crpc.ts` DEFINES the builders (`export const authQuery = publicQuery.use(…)`).
        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") && fromLunora(path) !== "lib/crpc.ts"
            ? [path]
            : [];
    });

describe("authorization matrix", () => {
    it("has exactly one row per client-reachable procedure in _generated/api.ts", () => {
        const procedures = publicProcedures();
        const rows = matrixRows();

        // Sanity: an empty parse on either side would make the comparison vacuous.
        expect(procedures.length).toBeGreaterThan(300);

        const missing = procedures.filter((name) => !rows.includes(name));
        const stale = rows.filter((name) => !procedures.includes(name));
        const duplicated = rows.filter((name, index) => rows.indexOf(name) !== index);

        expect(
            { duplicated, missing, stale },
            "Review each missing procedure's authorization and add its row to docs/security/authz-matrix.md; drop stale rows.",
        ).toEqual({ duplicated: [], missing: [], stale: [] });
    });

    it("lists every procedure built without auth middleware", () => {
        const found: Record<string, string[]> = {};

        for (const file of sourceFiles(LUNORA)) {
            const names = [...readFileSync(file, "utf8").matchAll(NO_AUTH_BUILDERS)].map((match) => match[1] as string);

            if (names.length > 0) {
                found[fromLunora(file)] = names.toSorted(byName);
            }
        }

        const expected = Object.fromEntries(Object.entries(NO_AUTH_MIDDLEWARE).map(([file, names]) => [file, names.toSorted(byName)]));

        expect(found, "A procedure without auth middleware must resolve identity itself — review it, then list it here and in the matrix.").toEqual(expected);
    });
});
