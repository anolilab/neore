/**
 * GDPR audit history, as Lunora table triggers.
 *
 * ## What this replaces
 *
 * The earlier version built a `new AuditHistory(components.auditHistory, …)` and
 * handed the ORM a `{ <table>: { change } }` map, which fired on every
 * insert/update/delete that went through `ctx.orm.*`. Neither the component nor
 * the ORM exists here, so both halves move: the storage into `documentHistory`
 * (see `lib/documentHistory.ts`) and the wiring into Lunora's own
 * `defineTable(...).triggers((t) => …)`.
 *
 * ## Why this file was nearly lost
 *
 * After the port, NOTHING imported it. It type-checked in isolation, so no error
 * pointed at it — the only symptom was that `documentHistory` had exactly eight
 * writers, all of them explicit `recordHistory` calls for `threads` in
 * `chat/functions.ts`, and the other 19 tracked tables silently recorded nothing.
 * That is a GDPR surface: `listUserActivity` powers the data export, and it would
 * have quietly returned a fraction of the user's activity.
 *
 * ## Redaction
 *
 * The component redacted secret-shaped fields before storing. Reproduced here
 * rather than dropped — the point of keeping a snapshot is that it is readable
 * later, and a stored `hashedPassword` is a credential at rest.
 */
import type { TriggerBuilder, TriggerCtx, TriggerDefinition } from "lunorash/server";

/** Fields never written into a history snapshot, whatever table they appear on. */
const REDACTED_FIELDS = new Set([
    "authHeaders",
    "backupCodes",
    "encryptedTokens",
    "hashedPassword",
    "inviteToken",
    "kvTokenKey",
    "oauthClient",
    "publicAccessToken",
    "totpSecret",
    "verificationToken",
]);

type Row = Record<string, unknown> | null | undefined;

/** A shallow copy with the secret-shaped fields removed. */
const redact = (document: Row): Record<string, unknown> | undefined => {
    if (!document) {
        return undefined;
    }

    return Object.fromEntries(Object.entries(document).filter(([key]) => !REDACTED_FIELDS.has(key)));
};

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * How to find the owning user / organization on a given table. Both are optional
 * because some tracked tables have neither — a `verification` row is keyed by
 * identifier alone.
 */
export interface Attribution {
    organizationId?: (document: Record<string, unknown>) => string | undefined;
    userId?: (document: Record<string, unknown>) => string | undefined;
}

const write = async (
    context: TriggerCtx,
    table: string,
    attribution: Attribution,
    event: { document: Record<string, unknown> | undefined; id: string; isDeleted: boolean; previous?: Record<string, unknown> },
): Promise<void> => {
    // Attribution reads the surviving document — the new state on insert/update,
    // the previous one on delete, where there is nothing else left to read.
    const subject = event.document ?? event.previous;

    await context.db.insert("documentHistory", {
        attribution: { action: event.isDeleted ? "delete" : "update", source: "trigger" },
        // `doc` is `v.any()`, a NOT NULL column in D1, and `insert` drops an
        // `undefined` key — so a delete's missing new state failed the trigger,
        // rolling back the delete itself (account deletion's settings step
        // failed exactly so). `isDeleted` is what readers check; store `{}`,
        // as `recordHistory` does (`lib/document-history.ts`).
        doc: redact(event.document) ?? {},
        documentId: event.id,
        isDeleted: event.isDeleted,
        oldDoc: redact(event.previous),
        organizationId: subject && attribution.organizationId ? attribution.organizationId(subject) : undefined,
        tableName: table,
        ts: Date.now(),
        userId: subject && attribution.userId ? attribution.userId(subject) : undefined,
    });
};

/**
 * The three history triggers for one table, ready to spread into `.triggers(…)`.
 *
 * `afterInsert` / `afterUpdate` / `afterDelete` rather than the `before*` forms:
 * a history row describing a write that then fails is worse than no row.
 */
export const auditTriggersFor = (t: TriggerBuilder, table: string, attribution: Attribution): Record<string, TriggerDefinition> => {
    return {
        auditDelete: t.afterDelete(async (context, event) =>
            write(context, table, attribution, { document: undefined, id: event.id, isDeleted: true, previous: event.previous as Record<string, unknown> }),
        ),
        auditInsert: t.afterInsert(async (context, event) =>
            write(context, table, attribution, { document: event.doc as Record<string, unknown>, id: event.id, isDeleted: false }),
        ),
        auditUpdate: t.afterUpdate(async (context, event) =>
            write(context, table, attribution, {
                document: event.doc as Record<string, unknown>,
                id: event.id,
                isDeleted: false,
                previous: event.previous as Record<string, unknown>,
            }),
        ),
    };
};

/**
 * Which tables carry history, and how each attributes a row to a user or org.
 *
 * Transcribed from the earlier `auditTriggers` map. `user` and `organization` are
 * the odd ones: their `_id` IS the id being attributed, so there is no column to
 * read.
 *
 * Nothing reads this list to WIRE it any more — the schema generator that did is
 * deleted. `schema.ts` now names each table explicitly,
 * `.triggers((t) => auditTriggersFor(t, "<table>", AUDIT_TABLES["<table>"]!))`,
 * 19 times. So the list and `schema.ts` are two hand-maintained halves that must
 * agree: **an entry added here without the matching `.triggers(...)` line is
 * silently un-audited**, which is a GDPR gap rather than a broken build (see the
 * note in `crons.ts`). Both halves are at 19; if you add one, add the other.
 */
export const AUDIT_TABLES: Record<string, Attribution> = {
    account: { userId: (d) => asString(d["userId"]) },
    aiUserPreferences: { userId: (d) => asString(d["userId"]) },
    files: { organizationId: (d) => asString(d["organizationId"]) },
    folders: { userId: (d) => asString(d["userId"]) },
    gdprConsent: { userId: (d) => asString(d["userId"]) },
    invitation: { organizationId: (d) => asString(d["organizationId"]) },
    member: { organizationId: (d) => asString(d["organizationId"]), userId: (d) => asString(d["userId"]) },
    memberCredits: { organizationId: (d) => asString(d["organizationId"]), userId: (d) => asString(d["userId"]) },
    organization: { organizationId: (d) => asString(d["_id"]), userId: (d) => asString(d["ownerId"]) },
    passkey: { userId: (d) => asString(d["userId"]) },
    promptHistory: { userId: (d) => asString(d["userId"]) },
    prompts: { organizationId: (d) => asString(d["organizationId"]), userId: (d) => asString(d["userId"]) },
    session: { userId: (d) => asString(d["userId"]) },
    team: { organizationId: (d) => asString(d["organizationId"]) },
    teamMember: { userId: (d) => asString(d["userId"]) },
    teamSettings: { organizationId: (d) => asString(d["organizationId"]) },
    twoFactor: { userId: (d) => asString(d["userId"]) },
    user: { userId: (d) => asString(d["_id"]) },
    userSettings: { userId: (d) => asString(d["userId"]) },
    verification: {},
};
