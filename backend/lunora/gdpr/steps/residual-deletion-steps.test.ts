/**
 * Account deletion must remove EVERY row of the tables the original workflow
 * never reached, for the deleted user only.
 *
 * 30 rows per table, deliberately past 25 and not a multiple of the batch: a
 * 12-row fixture cannot tell "deleted everything" from "deleted one page". The
 * drain loop below is the workflow's, minus the durable step around it.
 *
 * The harness is one database, so this proves WHAT is deleted, not WHERE — shard
 * placement is `auth.shard.test.ts`'s concern. It also has no `.global()` (D1)
 * backend, so the two D1 steps run their handlers against an in-memory facade.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jobsQueueMessages } from "../../../test/stubs/cloudflare-workers";
import { schemaWithShardedTables, withTableFacades } from "../../lib/test-schema";
import {
    anonymiseGatewayUsageDeductions,
    BATCH,
    DELETED_USER_MARKER,
    deleteUserEmbeddings,
    deleteUserIdentity,
    deleteUserIntegrations,
    deleteUserKnowledge,
    deleteUserStreamingMessages,
    deleteUserWorkflowData,
    minimiseGdprRecords,
    purgeUserDocumentHistory,
} from "./residual-deletion-steps";

type Harness = ReturnType<typeof lunoraTest>;

const A = "user-a";
const B = "user-b";
const MANY = 30;
const NOW = 1_800_000_000_000;

let harness: Harness;

/** A 768-dimension unit vector; the values are irrelevant here. */
const UNIT_VECTOR: number[] = Array.from({ length: 768 }, (_unused, index) => (index === 0 ? 1 : 0));

/** Row factories, keyed by table. Each returns one valid row for `userId`. */
// `gdprConsent` is deleted by `deleteUserIntegrations` too, but it is audited and
// its insert trigger writes `documentHistory`, which this harness cannot store.
const ROWS: Record<string, (userId: string, index: number, refs: Record<string, string>) => Record<string, unknown>> = {
    chatFileAccess: (userId, _index, refs) => {
        return { createdAt: NOW, fileId: refs.chatFile, userId };
    },
    embeddings_768: (userId) => {
        return { model: "m", table: "memories", userId, vector: UNIT_VECTOR };
    },
    gatewayNotifications: (userId) => {
        return { action: "notify", currentValue: 1, isRead: false, metric: "cost", ruleId: "r", ruleName: "Rule", threshold: 1, triggeredAt: NOW, userId };
    },
    gatewayUsageDeductions: (userId, index) => {
        return { costMicrodollars: 1000, createdAt: NOW, creditsDeducted: 1, modelId: "m", requestId: `${userId}-r${String(index)}`, userId };
    },
    idempotencyClaims: (userId, index) => {
        return { claimedAt: NOW, expiresAt: NOW + 1000, key: `${userId}-e${String(index)}`, scope: "messenger", userId };
    },
    knowledgeFiles: (userId, index) => {
        return { createdAt: NOW, mimeType: "text/plain", name: `f${String(index)}.txt`, size: 1, status: "indexed", userId };
    },
    streamingMessages: (userId, _index, refs) => {
        return {
            order: 0,
            state: { endedAt: NOW, kind: "finished" },
            stateKind: "finished",
            stepOrder: 0,
            threadId: refs.thread,
            userId,
        };
    },
    systemPromptPresets: (userId, index) => {
        return { createdAt: NOW, name: `p${String(index)}`, prompt: "be brief", updatedAt: NOW, userId };
    },
    triggers: (userId, index) => {
        return { createdAt: NOW, enabled: true, model: "m", name: `t${String(index)}`, triggerCount: 0, type: "webhook", updatedAt: NOW, userId };
    },
    workflowVersions: (userId, _index, refs) => {
        return { projectId: refs.project, userId };
    },
};

const rowsOf = async (table: string): Promise<{ userId?: string }[]> => await harness.run(async (ctx: any) => await ctx.db.query(table).collect());

const countFor = async (table: string, userId: string): Promise<number> => {
    const rows = await rowsOf(table);

    return rows.filter((row) => row.userId === userId).length;
};

/** The workflow's `drain`, without the durable step. */
const drain = async (step: unknown, args: Record<string, string>): Promise<number> => {
    for (let round = 1; round <= 1000; round += 1) {
        // The handler directly, with the ORM facade bound: `deleteUserWorkflowData`
        // reads the `.global()` `projects` table through `ctx.db.projects`, which
        // the harness gives only cRPC builders (see `lib/test-schema.ts`).
        const { hasMore } = await harness.run(
            async (ctx: any) =>
                await (step as { handler: (context: unknown, args: unknown) => Promise<{ hasMore: boolean }> }).handler(withTableFacades(ctx), args),
        );

        if (!hasMore) {
            return round;
        }
    }

    throw new Error("drain did not terminate");
};

beforeEach(() => {
    // `projects` is `.global()`; the harness has no D1 backend (see lib/test-schema.ts).
    harness = lunoraTest(schemaWithShardedTables(["projects"]) as never);
});

afterEach(() => {
    harness.close();
});

describe("residual account-deletion steps", () => {
    it("deletes every row of user A across the batched tables and leaves user B's intact", async () => {
        await harness.run(async (ctx: any) => {
            for (const userId of [A, B]) {
                const refs = {
                    chatFile: await ctx.db.insert("chatFiles", {
                        hash: `h-${userId}`,
                        lastTouchedAt: NOW,
                        mediaType: "image/png",
                        refcount: 1,
                        storageId: `agent-files/h-${userId}`,
                    }),
                    connection: await ctx.db.insert("messengerConnections", { connectedAt: NOW, platform: "whatsapp", status: "active", userId }),
                    project: await ctx.db.insert("projects", { name: "P", userId }),
                    thread: await ctx.db.insert("threads", { title: "T", userId }),
                };

                for (const [table, make] of Object.entries(ROWS)) {
                    const count = userId === A ? MANY : 1;

                    for (let index = 0; index < count; index += 1) {
                        await ctx.db.insert(table, make(userId, index, refs));
                    }
                }

                // A knowledge file with more chunks than one batch, each chunk
                // pointing at an embedding.
                const fileId = await ctx.db.insert("knowledgeFiles", ROWS.knowledgeFiles!(userId, 999, refs));
                const chunkCount = userId === A ? BATCH + 5 : 1;

                for (let index = 0; index < chunkCount; index += 1) {
                    const embeddingId = await ctx.db.insert("embeddings_768", { ...ROWS.embeddings_768!(userId, index, refs), table: "knowledgeChunks" });

                    await ctx.db.insert("knowledgeChunks", { chunkIndex: index, content: `c${String(index)}`, embeddingId, fileId, userId });
                }
            }
        });

        const expectedB: Record<string, number> = {};

        for (const table of [...Object.keys(ROWS), "knowledgeChunks"]) {
            expectedB[table] = await countFor(table, B);
        }

        const args = { userId: A };

        expect(await drain(deleteUserKnowledge, args)).toBeGreaterThan(1);
        await drain(deleteUserEmbeddings, args);
        await drain(deleteUserStreamingMessages, args);
        await drain(deleteUserIntegrations, args);
        await drain(deleteUserWorkflowData, args);
        await drain(anonymiseGatewayUsageDeductions, args);

        for (const table of [...Object.keys(ROWS), "knowledgeChunks"]) {
            expect({ count: await countFor(table, A), table }).toStrictEqual({ count: 0, table });
            expect({ count: await countFor(table, B), table }).toStrictEqual({ count: expectedB[table], table });
        }

        // The ledger keeps its amounts under the marker.
        const ledger = await rowsOf("gatewayUsageDeductions");
        const anonymised = ledger.filter((row) => row.userId === DELETED_USER_MARKER);

        expect(anonymised).toHaveLength(MANY);
    });

    it("keeps the GDPR request and audit rows but strips them to metadata", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("gdprRequests", {
                errorMessage: "free text about a@example.com",
                requestedAt: NOW,
                requestType: "deletion",
                status: "completed",
                userEmail: "a@example.com",
                userId: A,
            });
            await ctx.db.insert("gdprAuditLog", {
                action: "deletion_requested",
                details: JSON.stringify({ email: "a@example.com", requestId: "r1" }),
                performedBy: A,
                timestamp: NOW,
                userId: A,
            });
            await ctx.db.insert("gdprRequests", { requestedAt: NOW, requestType: "export", status: "pending", userEmail: "b@example.com", userId: B });
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(minimiseGdprRecords, { userId: A }));

        const requests = (await rowsOf("gdprRequests")) as { errorMessage?: string; userEmail: string; userId: string }[];
        const audit = (await rowsOf("gdprAuditLog")) as { details: string }[];

        expect(requests.find((row) => row.userId === A)).toMatchObject({ userEmail: "" });
        expect(requests.find((row) => row.userId === A)?.errorMessage ?? undefined).toBeUndefined();
        expect(requests.find((row) => row.userId === B)).toMatchObject({ userEmail: "b@example.com" });
        expect(audit.map((row) => JSON.parse(row.details))).toStrictEqual([{ requestId: "r1" }]);
    });
});

/**
 * An in-memory stand-in for the D1 ORM facade (`ctx.db.<table>.findMany`/`findFirst`,
 * `ctx.db.get`, `ctx.db.delete`), with `limit` honoured — a facade that ignored it
 * would hide a step that stops after one page.
 */
const matchesWhere = (entry: { row: Record<string, unknown>; table: string }, table: string, where: Record<string, unknown>): boolean =>
    entry.table === table && Object.keys(where).every((key) => entry.row[key] === where[key]);

const d1Facade = (tables: Record<string, Record<string, unknown>[]>) => {
    let nextId = 0;
    const rows = new Map<string, { row: Record<string, unknown>; table: string }>();

    for (const [table, list] of Object.entries(tables)) {
        for (const row of list) {
            nextId += 1;

            const id = typeof row._id === "string" ? row._id : `${table}-${String(nextId)}`;

            rows.set(id, { row: { ...row, _id: id }, table });
        }
    }

    const tableApi = (table: string) => {
        return {
            count: async (where: Record<string, unknown> = {}) => [...rows.values()].filter((entry) => matchesWhere(entry, table, where)).length,
            findFirst: async ({ where = {} }: { where?: Record<string, unknown> }) => {
                for (const entry of rows.values()) {
                    if (matchesWhere(entry, table, where)) {
                        return entry.row;
                    }
                }

                return null;
            },
            findMany: async ({ limit, where = {} }: { limit?: number; where?: Record<string, unknown> }) => {
                const matching = [...rows.values()].filter((entry) => matchesWhere(entry, table, where)).map((entry) => entry.row);

                return { page: limit === undefined ? matching : matching.slice(0, limit) };
            },
        };
    };

    const db = new Proxy(
        {
            delete: async (id: string) => {
                rows.delete(id);
            },
            get: async (id: string) => rows.get(id)?.row ?? null,
            patch: async (id: string, fields: Record<string, unknown>) => {
                const entry = rows.get(id);

                if (entry) {
                    entry.row = { ...entry.row, ...fields };
                }
            },
        } as Record<string, unknown>,
        { get: (target, key: string) => target[key] ?? tableApi(key) },
    );

    const remaining = (table: string, field: string, value: string) =>
        [...rows.values()].filter((entry) => entry.table === table && entry.row[field] === value).length;

    const read = (id: string) => rows.get(id)?.row;

    return { context: { db }, read, remaining };
};

const drainHandler = async (step: unknown, context: object, args: Record<string, string>): Promise<void> => {
    const { handler } = step as { handler: (context: object, args: object) => Promise<{ hasMore: boolean }> };

    for (let round = 0; round < 1000; round += 1) {
        const { hasMore } = await handler(context, args);

        if (!hasMore) {
            return;
        }
    }

    throw new Error("drain did not terminate");
};

describe("residual account-deletion steps on D1", () => {
    const many = (userId: string, make: (index: number) => Record<string, unknown>) =>
        Array.from({ length: userId === A ? MANY : 1 }, (_unused, index) => make(index));
    const both = (make: (userId: string, index: number) => Record<string, unknown>) => [
        ...many(A, (index) => make(A, index)),
        ...many(B, (index) => make(B, index)),
    ];

    it("deletes A's identity rows and the user row last, and leaves B's alone", async () => {
        const { context, read, remaining } = d1Facade({
            apikey: both((userId, index) => {
                return { key: `${userId}-${String(index)}`, referenceId: userId };
            }),
            invitation: both((userId, index) => {
                return { email: userId === A ? "a@example.com" : "b@example.com", organizationId: `o${String(index)}` };
            }),
            member: both((userId, index) => {
                return { organizationId: `o${String(index)}`, userId };
            }),
            memberCredits: both((userId, index) => {
                return { memberId: `${userId}-m${String(index)}`, organizationId: `o${String(index)}`, userId };
            }),
            signUpInvitation: both((userId) => {
                return { email: userId === A ? "a@example.com" : "b@example.com" };
            }),
            skillRatings: both((userId, index) => {
                return { rating: userId === A ? 1 : 5, skillId: `s${String(index)}`, userId };
            }),
            // s0 was rated by both: A's 1 and B's 5.
            skillStats: [{ _id: "stats-s0", rating: 3, ratingCount: 2, skillId: "s0", usageCount: 0 }],
            teamMember: both((userId, index) => {
                return { teamId: `t${String(index)}`, userId };
            }),
            twoFactor: both((userId) => {
                return { userId };
            }),
            user: [
                { _id: A, email: "a@example.com" },
                { _id: B, email: "b@example.com" },
            ],
        });

        await drainHandler(deleteUserIdentity, context, { userEmail: "A@Example.com ", userId: A });

        for (const table of ["apikey", "member", "memberCredits", "skillRatings", "teamMember", "twoFactor"]) {
            const field = table === "apikey" ? "referenceId" : "userId";

            expect({ a: remaining(table, field, A), b: remaining(table, field, B), table }).toStrictEqual({ a: 0, b: 1, table });
        }

        expect(remaining("invitation", "email", "a@example.com")).toBe(0);
        expect(remaining("invitation", "email", "b@example.com")).toBe(1);
        expect(remaining("signUpInvitation", "email", "a@example.com")).toBe(0);
        expect(remaining("user", "_id", A)).toBe(0);
        expect(remaining("user", "_id", B)).toBe(1);
        // A's score left the average along with A's rating row.
        expect(read("stats-s0")).toMatchObject({ rating: 5, ratingCount: 1 });
    });

    it("cancels the Team plans A pays for or leaves empty, and re-bills the rest", async () => {
        const { context } = d1Facade({
            member: [
                // oPaid: A pays; B stays. oLast: A is the only member. oShared: A and B, B's org pays.
                { organizationId: "oPaid", userId: A },
                { organizationId: "oPaid", userId: B },
                { organizationId: "oLast", userId: A },
                { organizationId: "oShared", userId: A },
                { organizationId: "oShared", userId: B },
            ],
            organization: [
                { _id: "oPaid", baseTier: "pro", creemPurchaserId: A, creemSubscriptionId: "sub_paid", name: "Paid" },
                { _id: "oLast", baseTier: "pro", creemPurchaserId: "someone-else", creemSubscriptionId: "sub_last", name: "Last" },
                { _id: "oShared", baseTier: "pro", creemPurchaserId: B, creemSubscriptionId: "sub_shared", name: "Shared" },
                // A paid for oGone's Team but is no longer a member of it.
                { _id: "oGone", baseTier: "pro", creemPurchaserId: A, creemSubscriptionId: "sub_gone", name: "Gone" },
            ],
            user: [
                { _id: A, email: "a@example.com" },
                { _id: B, email: "b@example.com" },
            ],
        });

        jobsQueueMessages.length = 0;
        await drainHandler(deleteUserIdentity, context, { userEmail: "a@example.com", userId: A });

        const queued = new Map(jobsQueueMessages.map(({ body }) => [JSON.stringify(body.args), body.functionPath]));

        expect(queued.get(JSON.stringify({ referenceId: "oPaid" }))).toBe("billing_gdpr:cancelBilling");
        expect(queued.get(JSON.stringify({ referenceId: "oGone" }))).toBe("billing_gdpr:cancelBilling");
        expect(queued.get(JSON.stringify({ referenceId: "oLast" }))).toBe("billing_gdpr:cancelBilling");
        expect(queued.get(JSON.stringify({ organizationId: "oShared" }))).toBe("billing_seats:syncTeamSeats");
        expect(queued.has(JSON.stringify({ referenceId: "oShared" }))).toBe(false);
    });

    it("purges A's document history past one batch and keeps B's", async () => {
        const { context, remaining } = d1Facade({
            documentHistory: [
                ...Array.from({ length: BATCH * 2 + 3 }, (_unused, index) => {
                    return { documentId: `d${String(index)}`, tableName: "prompts", userId: A };
                }),
                { documentId: "b", tableName: "prompts", userId: B },
            ],
        });

        await drainHandler(purgeUserDocumentHistory, context, { userId: A });

        expect(remaining("documentHistory", "userId", A)).toBe(0);
        expect(remaining("documentHistory", "userId", B)).toBe(1);
    });
});
