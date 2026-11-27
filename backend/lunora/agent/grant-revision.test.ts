/**
 * A thread grant's revision: every write to the grant advances it, and a removal's revision outlives the grant row, so
 * a client can drop a read that saw the grant before it (`agent/grant-revision.ts`).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import {
    advanceGrantRevision,
    GRANT_PAGE_STATEMENTS,
    guestHoldsGrantRows,
    lastGrantRevision,
    mergeGrantRevisionsPage,
    mergeGrantsPage,
    removeGrant,
    settleGrant,
    writeGrant,
} from "./grant-revision";
import {
    createThreadAccess,
    deleteThreadAccess,
    dropThreadPurgeMark,
    grantOwnerForThread,
    insertThreadAccess,
    listThreadAccessHandler,
    revokeThreadGrantsJob,
    revokeThreadGrantsPage,
    updateThreadAccess,
} from "./sharing";
import { acquireMergeLease, markGuestMerging, reassignGlobalRows } from "../lib/account-merge";
import { setShardRoute } from "../lib/shard-routes";
import { collectGrantRevisionsForExport, eraseGrantRevisionsForUser, GRANT_REVISIONS_EXPORT_PAGE } from "./gdpr";
import { GRANT_REVISIONS_EXPORT_PAGES, GrantRevisionsExportError, readAllGrantRevisionPages, storeAllGrantRevisionPages } from "./export-pages";
import { _deleteAllForUserIdAsync } from "./users";
import { resolveThreadReadAccess } from "./thread-read-access";

// The grant writers in `./sharing` claim through this module's export, which a test can hold between claim and insert.
vi.mock("./grant-revision", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./grant-revision")>();

    return { ...actual, advanceGrantRevision: vi.fn(actual.advanceGrantRevision) };
});

// The merge's lease asks whether its new account still exists, a `user` row these harnesses do not hold: it does.
vi.mock("../auth/lib/merge-destination", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../auth/lib/merge-destination")>();

    return { ...actual, isMergeDestination: async () => true };
});

const OWNER = "user-owner";
/** A grant to a guest whose account merge has started is refused with this. */
const MERGED_GUEST_REFUSAL = /moved to a signed-in account/;
/** A grant or a count written to a chat deleted for good is refused with this. */
const THREAD_DELETED_REFUSAL = /This chat was deleted/;
const READER = "user-reader";
/** A grant to an account or for an owner that is gone is refused with this. */
const NO_ACCOUNT_REFUSAL = /Sign in to that account/;

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const grant = async (): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.threadAccess.findFirst({ where: { threadId, userId: READER } }));
/** The grant row's revision, and its id for the next write. */
const revisionOf = async (): Promise<number | undefined> => {
    const row = await grant();

    return row?.revision;
};
const grantId = async (): Promise<string> => {
    const row = await grant();

    return row._id;
};
/** Every grant row the reader holds to the chat. */
const copies = async (): Promise<any[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.threadAccess.findMany({ where: { threadId, userId: READER } });

        return page;
    });
const last = async (): Promise<number | undefined> =>
    (await harness.run(async (ctx: any) => await lastGrantRevision(ctx, threadId as never, READER))) as number | undefined;
const run = async (reference: unknown, args: Record<string, unknown>): Promise<unknown> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(reference, args));

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }))) as string;
});

afterEach(() => {
    harness.close();
});

describe("a thread grant's revision", () => {
    it("advances on every grant, change and removal, and continues past a removal", async () => {
        const create = { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER };

        expect(await last()).toBeUndefined();

        await run(createThreadAccess, create);
        expect(await revisionOf()).toBe(1);

        await run(updateThreadAccess, { accessId: await grantId(), expiresAt: Date.now() + 60_000 });
        expect(await revisionOf()).toBe(2);

        await run(updateThreadAccess, { accessId: await grantId(), permission: "write" });
        expect(await revisionOf()).toBe(3);

        // A removal advances before and after the delete: its revision is past any a change racing it put on the row.
        await run(deleteThreadAccess, { accessId: await grantId() });
        expect(await grant()).toBeNull();
        expect(await last()).toBe(5);

        await run(createThreadAccess, create);
        expect(await revisionOf()).toBe(6);

        // A trashed chat's grants go a batch at a time; each removal advances too, so a grant after a restore continues.
        await run(revokeThreadGrantsJob, { threadId });
        expect(await grant()).toBeNull();
        expect(await last()).toBe(8);

        // A chat deleted for good keeps no revision either.
        await run(createThreadAccess, create);
        await run(revokeThreadGrantsJob, { purge: true, threadId });
        expect(await grant()).toBeNull();
        expect(await last()).toBeUndefined();
    });

    it("leaves no revision of a chat deleted for good while a trash revocation held its grant", async () => {
        await run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });

        await harness.run(async (ctx: any) => {
            let raced = false;
            const threadAccess = withMembers(ctx.db.threadAccess, {
                findMany: async (options: any) => {
                    const page = await ctx.db.threadAccess.findMany(options);

                    // The trash revocation read the grant; the chat is then deleted for good, and its purge completes.
                    for (let call = 0; !raced && call < 10 && !(await revokeThreadGrantsPage(ctx, threadId as never, true)); call += 1) {
                        // Until the purge reports nothing left.
                    }

                    raced = true;

                    return page;
                },
            });

            await revokeThreadGrantsPage({ ...ctx, db: withMembers(ctx.db, { threadAccess }) }, threadId as never, false);
        });

        expect(await grant()).toBeNull();
        expect(await last()).toBeUndefined();
    });

    it("takes a revision past one a concurrent write claimed between its read and its write", async () => {
        await run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });

        // The counter moves on after this write read it: its conditional write misses, and it claims past the new count.
        const counter = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findFirst({ where: { threadId, userId: READER } }))) as any;
        const revision = await harness.run(async (ctx: any) => {
            let raced = false;
            // Only what `advanceGrantRevision` touches: the first read is followed at once by another write's claim.
            const db = {
                insert: async (...args: unknown[]) => await ctx.db.insert(...args),
                patchIf: async (...args: unknown[]) => await ctx.db.patchIf(...args),
                threadAccessRevisions: {
                    findFirst: async (query: unknown) => {
                        const row = await ctx.db.threadAccessRevisions.findFirst(query);

                        if (!raced) {
                            raced = true;
                            await ctx.db.patch("threadAccessRevisions", counter._id, { revision: 7 });
                        }

                        return row;
                    },
                },
            };

            return await advanceGrantRevision({ db } as never, { threadId: threadId as never, userId: READER });
        });

        expect(revision).toBe(8);
    });

    it("names the removal's revision on a denial while a replica still holds the count before it", async () => {
        await run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });
        await run(deleteThreadAccess, { accessId: await grantId() });

        // A replica that saw the grant (revision 1) but not the removal: only a primary read is current.
        const revision = await harness.run(async (ctx: any) => {
            const db = {
                threadAccessRevisions: {
                    findFirst: async (query: { consistency?: string }) =>
                        query.consistency === "primary" ? await ctx.db.threadAccessRevisions.findFirst(query) : { revision: 1 },
                },
            };

            return await lastGrantRevision({ db } as never, threadId as never, READER);
        });

        expect(revision).toBe(3);
    });

    it("erases a revision written just before an account's deletion while a replica has not seen it yet", async () => {
        await run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });

        // A replica that has not seen the grant's revision yet: its page is short, which would end the erasure.
        const { hasMore } = await harness.run(async (ctx: any) => {
            const revisions = withMembers(ctx.db.threadAccessRevisions, {
                findMany: async (query: { consistency?: string }) =>
                    query.consistency === "primary" ? await ctx.db.threadAccessRevisions.findMany(query) : { page: [] },
            });

            return await eraseGrantRevisionsForUser({ ...ctx, db: withMembers(ctx.db, { threadAccessRevisions: revisions }) }, READER);
        });

        const left = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findMany({ where: { userId: READER } }))) as { page: unknown[] };

        expect(hasMore).toBe(false);
        expect(left.page).toHaveLength(0);
    });

    it("exports every revision of a grant the user held, a page at a time, and none of the people they shared with", async () => {
        const held = GRANT_REVISIONS_EXPORT_PAGE + 2;

        const readerHeld = (await harness.run(async (ctx: any) => {
            const pairs: { revision: number; threadId: string }[] = [];

            for (let index = 0; index < held; index += 1) {
                const chat = await ctx.db.insert("threads", { status: "active", title: `T${index}`, userId: OWNER });

                await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: index + 1, threadId: chat, userId: READER });
                pairs.push({ revision: index + 1, threadId: chat });
            }

            // A chat of the reader's own, shared with someone else: that grantee's revision is theirs, not the reader's.
            // Its revision 9 is one the reader holds too, so only the chat tells the two apart.
            const own = await ctx.db.insert("threads", { status: "active", title: "Own", userId: READER });

            await ctx.db.insert("threadAccessRevisions", { ownerId: READER, revision: 9, threadId: own, userId: "user-other" });

            return pairs;
        })) as { revision: number; threadId: string }[];

        // Stored as the export workflow stores them: a page per step, each read in its own query, then read back whole.
        const stored = new Map<number, string>();
        const pages = await storeAllGrantRevisionPages(async (cursor, page) => {
            const read = (await harness.run(
                async (ctx: any) => await ctx.runQuery(collectGrantRevisionsForExport, { ...(cursor !== undefined && { cursor }), userId: READER }),
            )) as { cursor: string | null; revisions: unknown[] };

            expect(read.revisions.length).toBeLessThanOrEqual(GRANT_REVISIONS_EXPORT_PAGE);
            stored.set(page, JSON.stringify({ revisions: read.revisions }));

            return read.cursor === null ? {} : { next: read.cursor };
        });
        const section = await readAllGrantRevisionPages(async (page) => stored.get(page)!, pages);
        const pairs = (rows: unknown[]) =>
            (rows as { revision: number; threadId: string }[])
                .map(({ revision, threadId: chat }) => `${chat}:${revision}`)
                .toSorted((a, b) => a.localeCompare(b));

        expect(pages).toBeGreaterThan(1);
        expect(section).not.toHaveProperty("truncated");
        expect(pairs(section.revisions)).toStrictEqual(pairs(readerHeld));
    });

    it("exports every grant-revision page even past what one step's read budget held, and never completes short past the page cap", async () => {
        // Each step reads one page in its own query: three pages, more than the one-page budget of the old in-action read.
        const rows = (page: number) =>
            Array.from({ length: GRANT_REVISIONS_EXPORT_PAGE }, (_, index) => {
                return { revision: 1, threadId: `t-${String(page)}-${String(index)}` };
            });
        const stored = new Map<number, string>();
        const steps: number[] = [];
        const pages = await storeAllGrantRevisionPages(async (cursor, page) => {
            steps.push(page);
            expect(cursor).toBe(page === 0 ? undefined : `cursor-${String(page)}`);
            stored.set(page, JSON.stringify({ revisions: rows(page) }));

            return page < 2 ? { next: `cursor-${String(page + 1)}` } : {};
        });

        expect(steps).toStrictEqual([0, 1, 2]);
        await expect(readAllGrantRevisionPages(async (page) => stored.get(page)!, pages)).resolves.toStrictEqual({
            revisions: [...rows(0), ...rows(1), ...rows(2)],
        });

        // A history that never ends within the cap fails the export instead of writing it without the rest.
        let stepsTaken = 0;

        await expect(
            storeAllGrantRevisionPages(async () => {
                stepsTaken += 1;

                return { next: "more" };
            }),
        ).rejects.toBeInstanceOf(GrantRevisionsExportError);
        expect(stepsTaken).toBe(GRANT_REVISIONS_EXPORT_PAGES);
    });

    it("never leaves a change's older revision on the grant when a later change lands between its claim and its write", async () => {
        await run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });

        const id = await grantId();

        // Change A reads the grant (revision 1) and claims 2; change B then reads, claims 3 and writes; A writes last.
        await harness.run(async (ctx: any) => {
            let raced = false;
            const db = {
                insert: async (...args: unknown[]) => await ctx.db.insert(...args),
                patch: async (...args: unknown[]) => await ctx.db.patch(...args),
                patchIf: async (table: string, ...args: unknown[]) => {
                    if (table === "threadAccess" && !raced) {
                        raced = true;
                        await writeGrant(ctx, id as never, { permission: "admin" });
                    }

                    return await ctx.db.patchIf(table, ...args);
                },
                threadAccess: ctx.db.threadAccess,
                threadAccessRevisions: ctx.db.threadAccessRevisions,
            };

            await writeGrant({ db } as never, id as never, { permission: "write" });
        });

        const counter = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findFirst({ where: { threadId, userId: READER } }))) as any;
        const row = await grant();

        // A's write missed on B's revision and claimed past it: the row carries the count, and A's change, last.
        expect(counter.revision).toBe(4);
        expect(row.revision).toBe(4);
        expect(row.permission).toBe("write");
    });

    it("moves a grant given while a removal runs past the removal's revision", async () => {
        const create = { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER };

        await run(createThreadAccess, create);

        const removed = await grant();

        // The removal deletes the row; a new grant is given before the removal's second advance.
        await harness.run(async (ctx: any) => {
            const db = new Proxy(ctx.db, {
                get: (target, key) => {
                    if (key === "delete") {
                        return async (table: string, id: string) => {
                            await target.delete(table, id);
                            await ctx.runMutation(createThreadAccess, create);
                        };
                    }

                    const value = target[key];

                    return typeof value === "function" ? value.bind(target) : value;
                },
            });

            await removeGrant({ db } as never, removed);
        });

        const row = await grant();

        expect(row.revision).toBe(await last());
    });

    it("refuses a change that reads the grant after a removal stamped it, instead of reporting a write the delete erases", async () => {
        await run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });

        const removed = await grant();
        let stamped: number | undefined;
        let change: unknown;

        // The removal has stamped the row; a change reads it and writes before the removal's delete.
        await harness.run(async (ctx: any) => {
            const db = new Proxy(ctx.db, {
                get: (target, key) => {
                    if (key === "delete") {
                        return async (table: string, id: string) => {
                            const row = await target.threadAccess.findFirst({ where: { _id: id } });

                            stamped = row?.revision;
                            change = await writeGrant(ctx, id as never, { permission: "admin" });
                            await target.delete(table, id);
                        };
                    }

                    const value = target[key];

                    return typeof value === "function" ? value.bind(target) : value;
                },
            });

            await removeGrant({ db } as never, removed);
        });

        // A reader of the stamped row sees the removal's revision; the change answers the grant gone, not a revision.
        expect(Math.abs(stamped!)).toBe(2);
        expect(change).toBe(false);
        expect(await grant()).toBeNull();
        expect(await last()).toBe(3);
    });

    it("moves a new grant past a removal's revision claimed between the grant's claim and its insert", async () => {
        const { advanceGrantRevision: claim } = await vi.importActual<typeof import("./grant-revision")>("./grant-revision");

        // The removal of an earlier grant advances again (and settles, finding no row) after this grant claimed.
        vi.mocked(advanceGrantRevision).mockImplementationOnce(async (ctx, key) => {
            const revision = await claim(ctx, key);

            await claim(ctx, key);

            return revision;
        });

        await run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });

        expect(await revisionOf()).toBe(await last());
        expect(await last()).toBe(3);
    });

    it("leaves no grant or revision of an erased account's chat, given after the cascade erased its others", async () => {
        await run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });

        // The erase's last page of this chat: its messages and streams are gone, so the chat row goes now.
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(_deleteAllForUserIdAsync, {
                    messagesCursor: null,
                    streamsInProgress: true,
                    threadInProgress: threadId,
                    threadsCursor: "page",
                    userId: OWNER,
                }),
        );

        const purges = harness.scheduler.list().filter((job: any) => job.functionPath === "agent_sharing:revokeThreadGrantsJob");

        expect(purges.map((job: any) => job.args)).toStrictEqual([{ purge: true, threadId }]);

        await run(revokeThreadGrantsJob, purges[0]!.args);

        expect(await grant()).toBeNull();
        expect(await last()).toBeUndefined();
    });

    it("leaves no grant or count of an invite accepted past its invite read while the chat's purge ran whole", async () => {
        const { advanceGrantRevision: claim } = await vi.importActual<typeof import("./grant-revision")>("./grant-revision");

        // The accept read the pending invite; the chat is deleted for good and its purge completes between the grant's
        // claim and its insert.
        vi.mocked(advanceGrantRevision).mockImplementationOnce(async (ctx: any, key) => {
            const revision = await claim(ctx, key);

            for (let call = 0; call < 10 && !(await revokeThreadGrantsPage(ctx, threadId as never, true)); call += 1) {
                // Until the purge reports nothing left.
            }

            return revision;
        });

        // Caught inside the run: D1 keeps what a refused grant wrote, while the harness would roll a thrown mutation back.
        const refusal = await harness.run(async (ctx: any) => {
            try {
                await insertThreadAccess(ctx, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId: threadId as never, userId: READER });

                return undefined;
            } catch (error: unknown) {
                return error;
            }
        });

        expect(String(refusal)).toMatch(THREAD_DELETED_REFUSAL);
        expect(await copies()).toStrictEqual([]);
        expect(await last()).toBeUndefined();
    });

    it("keeps the count of a grant copy that survives an accept refused because the owner's account went", async () => {
        const { advanceGrantRevision: claim } = await vi.importActual<typeof import("./grant-revision")>("./grant-revision");
        const [owner, reader] = (await harness.run(async (ctx: any) => [
            await ctx.db.insert("user", { createdAt: 0, email: "owner@example.com", emailVerified: true, name: "O", updatedAt: 0 }),
            await ctx.db.insert("user", { createdAt: 0, email: "reader@example.com", emailVerified: true, name: "R", updatedAt: 0 }),
        ])) as [string, string];
        const chat = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: owner }))) as string;
        const readerCopies = async (): Promise<any[]> =>
            await harness.run(async (ctx: any) => {
                const { page } = await ctx.db.threadAccess.findMany({ where: { threadId: chat, userId: reader } });

                return page;
            });

        // A grant copy the reader already holds, from an earlier accept.
        await run(createThreadAccess, { grantedBy: owner, ownerId: owner, permission: "read", threadId: chat, userId: reader });

        const [survivor] = await readerCopies();

        // A second accept: the owner's account is deleted between its claim and its insert.
        vi.mocked(advanceGrantRevision).mockImplementationOnce(async (ctx: any, key) => {
            const revision = await claim(ctx, key);

            await ctx.db.delete("user", owner);

            return revision;
        });

        const refusal = await harness.run(async (ctx: any) => {
            try {
                await insertThreadAccess(ctx, {
                    grantedBy: owner,
                    ownerId: owner,
                    permission: "read",
                    requireAccounts: true,
                    threadId: chat as never,
                    userId: reader,
                });

                return undefined;
            } catch (error: unknown) {
                return error;
            }
        });

        const left = await readerCopies();
        const count = await harness.run(async (ctx: any) => await lastGrantRevision(ctx, chat as never, reader));

        expect(String(refusal)).toMatch(NO_ACCOUNT_REFUSAL);
        expect(left.map((row: any) => row._id)).toStrictEqual([survivor._id]);
        expect(count).toBeGreaterThanOrEqual(survivor.revision);
    });

    it("gives the count back to a grant copy written between an accept's survivor check and its count delete", async () => {
        const { advanceGrantRevision: claim } = await vi.importActual<typeof import("./grant-revision")>("./grant-revision");
        const [owner, reader] = (await harness.run(async (ctx: any) => [
            await ctx.db.insert("user", { createdAt: 0, email: "owner@example.com", emailVerified: true, name: "O", updatedAt: 0 }),
            await ctx.db.insert("user", { createdAt: 0, email: "reader@example.com", emailVerified: true, name: "R", updatedAt: 0 }),
        ])) as [string, string];
        const chat = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: owner }))) as string;
        let racing: number | undefined;

        // The accept's owner is deleted between its claim and its insert, so it purges its own grant.
        vi.mocked(advanceGrantRevision).mockImplementationOnce(async (ctx: any, key) => {
            const revision = await claim(ctx, key);

            await ctx.db.delete("user", owner);

            return revision;
        });

        await harness.run(async (ctx: any) => {
            // Another writer's copy lands after the purge found no copy and before it deleted the count: its claim read the count first.
            const db = new Proxy(ctx.db, {
                get: (target, key) => {
                    if (key === "delete") {
                        return async (table: string, id: string) => {
                            if (table === "threadAccessRevisions" && racing === undefined) {
                                const counter = await target.threadAccessRevisions.findFirst({ where: { _id: id } });

                                racing = counter.revision + 1;
                                await target.patch("threadAccessRevisions", id, { revision: racing });
                                await target.insert("threadAccess", {
                                    grantedAt: 0,
                                    grantedBy: owner,
                                    ownerId: owner,
                                    permission: "read",
                                    revision: racing,
                                    threadId: chat,
                                    userId: reader,
                                });
                            }

                            await target.delete(table, id);
                        };
                    }

                    const value = target[key];

                    return typeof value === "function" ? value.bind(target) : value;
                },
            });

            await insertThreadAccess({ db, now: ctx.now } as never, {
                grantedBy: owner,
                ownerId: owner,
                permission: "read",
                requireAccounts: true,
                threadId: chat as never,
                userId: reader,
            }).catch((error: unknown) => error);
        });

        const count = await harness.run(async (ctx: any) => await lastGrantRevision(ctx, chat as never, reader));

        expect(racing).toBeDefined();
        expect(count).toBeGreaterThanOrEqual(racing!);
    });

    it("refuses a grant and a count claimed after the chat's purge finished, and drops the purge's mark a day later", async () => {
        await run(revokeThreadGrantsJob, { purge: true, threadId });

        const refusal = await harness.run(async (ctx: any) => {
            try {
                await insertThreadAccess(ctx, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId: threadId as never, userId: READER });

                return undefined;
            } catch (error: unknown) {
                return error;
            }
        });
        // A change to a grant read before the purge claims its count after it: no count is made again either.
        const claimed = await harness.run(async (ctx: any) => {
            try {
                return await advanceGrantRevision(ctx, { ownerId: OWNER, threadId: threadId as never, userId: READER });
            } catch (error: unknown) {
                return error;
            }
        });

        expect(String(refusal)).toMatch(THREAD_DELETED_REFUSAL);
        expect(String(claimed)).toMatch(THREAD_DELETED_REFUSAL);
        expect(await copies()).toStrictEqual([]);
        expect(await last()).toBeUndefined();

        const drops = harness.scheduler.list().filter((job: any) => job.functionPath === "agent_sharing:dropThreadPurgeMark");

        expect(drops.map((job: any) => job.args)).toStrictEqual([{ threadId }]);

        await run(dropThreadPurgeMark, drops[0]!.args);

        const marks = (await harness.run(async (ctx: any) => await ctx.db.threadPurgeMarks.findMany({ where: { threadId } }))) as any;

        expect(marks.page).toStrictEqual([]);
    });

    it("settles every copy of a grant past the count, not only the first page of them", async () => {
        // Five accepts of one invite raced: each claimed, then inserted, and no settle ran between them.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 6, threadId, userId: READER });

            for (let revision = 1; revision <= 5; revision += 1) {
                await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, ownerId: OWNER, permission: "read", revision, threadId, userId: READER });
            }
        });

        await harness.run(async (ctx: any) => await settleGrant(ctx, threadId as never, READER));

        const rows = await copies();
        const count = await last();

        expect(rows).toHaveLength(5);
        expect(rows.filter((row: any) => row.revision !== count)).toStrictEqual([]);
        expect(count).toBe(7);
    });

    it("refuses a settle past the copies one invocation pays for, and the next one moves the rest", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 20, threadId, userId: READER });

            for (let revision = 1; revision <= 14; revision += 1) {
                await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, ownerId: OWNER, permission: "read", revision, threadId, userId: READER });
            }
        });

        // The harness rolls a throwing run back; D1 keeps what a refused settle wrote, so the writes run outside it.
        const settle = async (): Promise<unknown> =>
            await harness.run(async (ctx: any) => {
                try {
                    return await settleGrant(ctx, threadId as never, READER);
                } catch (error: unknown) {
                    return error;
                }
            });

        expect(await settle()).toMatchObject({ code: "CONFLICT" });
        // The refused settle moved the first copies to its claim, 21; the next moves the rest to that same revision.
        expect(await settle()).toBeInstanceOf(Map);

        const rows = await copies();

        expect(rows).toHaveLength(14);
        expect(new Set(rows.map((row: any) => row.revision))).toStrictEqual(new Set([21]));
        expect(await last()).toBe(21);
    });

    it("reads a grant's copies on from the last one read when settling, however many already hold the count", async () => {
        // Twenty copies already at the count, then one below it, each made at its own instant.
        vi.useFakeTimers({ toFake: ["Date"] });
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 30, threadId, userId: READER });

            for (let index = 0; index < 21; index += 1) {
                vi.setSystemTime(Date.UTC(2026, 10, 20, 12, 0, index));
                await ctx.db.insert("threadAccess", {
                    grantedAt: 0,
                    grantedBy: OWNER,
                    ownerId: OWNER,
                    permission: "read",
                    revision: index < 20 ? 30 : 1,
                    threadId,
                    userId: READER,
                });
            }
        });
        vi.useRealTimers();

        const reads: number[] = [];

        await harness.run(async (ctx: any) => {
            const grants = withMembers(ctx.db.threadAccess, {
                findMany: async (query: unknown) => {
                    const result = await ctx.db.threadAccess.findMany(query);

                    reads.push(result.page.length);

                    return result;
                },
            });

            return await settleGrant({ ...ctx, db: withMembers(ctx.db, { threadAccess: grants }) }, threadId as never, READER);
        });

        // Six pages, each from the last copy read on (read again, as a copy of the same instant could follow it), the last
        // short: no page reads from the first copy again, and the copies at the count keep it.
        expect(reads).toStrictEqual([4, 5, 5, 5, 5, 2]);
        const rows = await copies();

        expect(rows).toHaveLength(21);
        expect(new Set(rows.map((row: any) => row.revision))).toStrictEqual(new Set([30]));
        expect(await last()).toBe(30);
    });

    it("reads a grant from before revisions as 0, and advances past it", async () => {
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER }),
        );

        await run(updateThreadAccess, { accessId: await grantId(), permission: "write" });
        expect(await revisionOf()).toBe(1);
    });
});

describe("a removal that stopped between its stamp and its delete", () => {
    /** Runs `removeGrant` on the reader's grant with a `threadAccess` delete that fails: the stamp is written, the row stays. */
    const stopAfterStamp = async (): Promise<void> => {
        const removed = await grant();

        await harness.run(async (ctx: any) => {
            const db = new Proxy(ctx.db, {
                get: (target, key) => {
                    if (key === "delete") {
                        return async (table: string, id: string) => {
                            if (table === "threadAccess") {
                                throw new Error("invocation limit");
                            }

                            await target.delete(table, id);
                        };
                    }

                    const value = target[key];

                    return typeof value === "function" ? value.bind(target) : value;
                },
            });

            await expect(removeGrant({ db } as never, removed)).rejects.toThrow("invocation limit");
        });
    };

    const readerAccess = async () =>
        await harness.run(async (ctx: any) => {
            const access = await resolveThreadReadAccess(ctx, threadId as never, READER, null, { primary: true });
            const listed = await listThreadAccessHandler(ctx, { threadId: threadId as never });

            return {
                kind: access?.kind ?? null,
                listed: listed.map((row: any) => row.userId),
                owner: await grantOwnerForThread(ctx, threadId, READER),
                revision: access?.kind === "full" ? access.revision : undefined,
            };
        });

    beforeEach(async () => {
        await run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "write", threadId, userId: READER });
        await stopAfterStamp();
    });

    it("leaves the grantee no access through the stamped row, and the owner's list no grant", async () => {
        const [stamped] = await copies();

        expect(stamped.revision).toBeLessThan(0);
        await expect(readerAccess()).resolves.toStrictEqual({ kind: null, listed: [], owner: null, revision: undefined });
    });

    it("gives access again on a re-grant, past the removal's revision, and clears the stamped row", async () => {
        const [stamped] = await copies();

        await run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER });

        const rows = await copies();
        const access = await readerAccess();

        expect(rows).toHaveLength(1);
        expect(rows[0]._id).not.toBe(stamped._id);
        expect(access).toMatchObject({ kind: "full", listed: [READER], owner: OWNER });
        expect(access.revision).toBeGreaterThan(Math.abs(stamped.revision));
    });

    it("is finished by a later removal of the stamped row", async () => {
        const [stamped] = await copies();

        await harness.run(async (ctx: any) => await removeGrant(ctx, { ...stamped, threadId, userId: READER }));

        expect(await copies()).toStrictEqual([]);
        expect(await last()).toBeGreaterThan(Math.abs(stamped.revision));
    });
});

/** `target` with the members `overrides` names replaced, every other method bound to it. */
const withMembers = (target: any, overrides: Record<string, unknown>): any =>
    new Proxy(target, {
        get: (object, key) => {
            if (typeof key === "string" && key in overrides) {
                return overrides[key];
            }

            const value = object[key];

            return typeof value === "function" ? value.bind(object) : value;
        },
    });

describe("an account merge's grants", () => {
    const GUEST = "user-guest";
    const seed = async (userId: string, permission: string, revision: number): Promise<string> =>
        (await harness.run(
            async (ctx: any) => await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, ownerId: OWNER, permission, revision, threadId, userId }),
        )) as string;
    const grants = async (): Promise<any[]> =>
        ((await harness.run(async (ctx: any) => await ctx.db.threadAccess.findMany({ where: { threadId } }))) as any).page;
    /** Runs the merge with `race` run once, right after the write or read `when` names. */
    const mergeRacing = async (when: (call: { args: any[]; method: string; result: any }) => boolean, race: (ctx: any) => Promise<void>): Promise<void> => {
        await harness.run(async (ctx: any) => {
            let raced = false;
            const after = async (method: string, args: any[], result: any): Promise<any> => {
                if (!raced && when({ args, method, result })) {
                    raced = true;
                    await race(ctx);
                }

                return result;
            };
            const db = withMembers(ctx.db, {
                patchIf: async (...args: any[]) => await after("patchIf", args, await ctx.db.patchIf(...args)),
                threadAccess: withMembers(ctx.db.threadAccess, {
                    findMany: async (options: any) => await after("findMany", [options], await ctx.db.threadAccess.findMany(options)),
                }),
            });

            await expect(mergeGrantsPage({ db, now: Date.now() } as never, GUEST, READER, 200)).resolves.toMatchObject({ done: true });
        });
    };

    it("finds a grant on a guest's chat by its owner through an index, not a scan of every grant", async () => {
        // `.global()` reads are SQL on D1: a `where` on `ownerId` alone uses an index only if one leads with it.
        const indexes = (schema as any).tables.threadAccess.indexes as { fields: string[] }[];

        expect(indexes.some((index) => index.fields[0] === "ownerId")).toBe(true);

        const holds = async (): Promise<boolean> => (await harness.run(async (ctx: any) => await guestHoldsGrantRows(ctx, GUEST))) as boolean;

        expect(await holds()).toBe(false);

        // A grant to another user on the guest's chat: the guest appears only as its owner.
        const guestThread = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "G", userId: GUEST }));

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadAccess", {
                    grantedAt: 0,
                    grantedBy: GUEST,
                    ownerId: GUEST,
                    permission: "read",
                    threadId: guestThread,
                    userId: READER,
                }),
        );

        expect(await holds()).toBe(true);
    });

    it("leaves no grant or count on a guest whose merge ran whole between the guest's grant claim and its insert", async () => {
        const { advanceGrantRevision: claim } = await vi.importActual<typeof import("./grant-revision")>("./grant-revision");

        // The guest accepts an invite as its conversion starts the merge: every pass of it runs after the grant's claim.
        vi.mocked(advanceGrantRevision).mockImplementationOnce(async (ctx: any, key) => {
            const revision = await claim(ctx, key);

            // The run's start marks the guest under the run's lease, before its steps read anything of the guest's.
            const { generation } = (await ctx.runMutation(acquireMergeLease, { from: GUEST, to: READER })) as { generation: number };

            await markGuestMerging(ctx, GUEST, READER, ctx.now ?? Date.now());

            for (let call = 0; call < 10; call += 1) {
                const pass = await ctx.runMutation(reassignGlobalRows, { from: GUEST, generation, to: READER });

                if (pass.done) {
                    break;
                }
            }

            return revision;
        });

        // Caught inside the run: D1 keeps what a refused grant wrote, while the harness would roll a thrown mutation back.
        const refusal = await harness.run(async (ctx: any) => {
            try {
                await insertThreadAccess(ctx, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId: threadId as never, userId: GUEST });

                return undefined;
            } catch (error: unknown) {
                return error;
            }
        });

        expect(String(refusal)).toMatch(MERGED_GUEST_REFUSAL);

        const counts = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findMany({ where: { threadId } }))) as any;

        // Refused, not raised: no grant, and the guest's count is the new account's.
        expect(await grants()).toStrictEqual([]);
        expect(counts.page.map((row: any) => row.userId)).toStrictEqual([READER]);
        // A later grant to the guest is refused before it claims anything.
        const later = await harness.run(async (ctx: any) => {
            try {
                await insertThreadAccess(ctx, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId: threadId as never, userId: GUEST });

                return undefined;
            } catch (error: unknown) {
                return error;
            }
        });
        const after = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findMany({ where: { threadId } }))) as any;

        expect(String(later)).toMatch(MERGED_GUEST_REFUSAL);
        expect(after.page).toStrictEqual(counts.page);
        expect(await grants()).toStrictEqual([]);
    });

    it("folds a count a removal made under the guest just as its merge marked it, once, and leaves none on the guest", async () => {
        const guestGrant = await seed(GUEST, "read", 1);

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 4, threadId, userId: READER });

            let marked = false;
            const count = { queries: 0 };
            const db = withMembers(ctx.db, {
                threadAccessRevisions: withMembers(ctx.db.threadAccessRevisions, {
                    findFirst: async (options: any) => {
                        const row = await ctx.db.threadAccessRevisions.findFirst(options);

                        // The merge marks the guest (its counts already folded) right after the removal's claim read none.
                        if (!marked && options.where.userId === GUEST) {
                            marked = true;
                            await setShardRoute(ctx, "merged-guest", GUEST, READER);
                        }

                        return row;
                    },
                }),
            });

            await removeGrant({ db: counting(db, count) } as never, (await ctx.db.threadAccess.findFirst({ where: { _id: guestGrant } })) as never);

            expect(count.queries).toBeLessThanOrEqual(GRANT_PAGE_STATEMENTS);
        });

        const counts = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findMany({ where: { threadId } }))) as any;

        expect(await grants()).toStrictEqual([]);
        // The first claim's guest count folded past the new account's 4 (to 5); the second claim went to it at once (6),
        // not through a second guest count.
        expect(counts.page.map((row: any) => [row.userId, row.revision])).toStrictEqual([[READER, 6]]);
    });

    it("keeps the new account's count when another fold moved the guest's count to it during the merge's own fold", async () => {
        await harness.run(async (ctx: any) => {
            const guestCount = await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 5, threadId, userId: GUEST });

            let raced = false;
            const db = withMembers(ctx.db, {
                threadAccessRevisions: withMembers(ctx.db.threadAccessRevisions, {
                    findMany: async (options: any) => {
                        const page = await ctx.db.threadAccessRevisions.findMany(options);

                        // Right after the merge read the guest's count, another fold moves that same row to the new account.
                        if (!raced) {
                            raced = true;
                            await ctx.db.patch("threadAccessRevisions", guestCount, { userId: READER });
                        }

                        return page;
                    },
                }),
            });

            await mergeGrantRevisionsPage({ db } as never, GUEST, READER);
        });

        const counts = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findMany({ where: { threadId } }))) as any;

        expect(counts.page.map((row: any) => [row.userId, row.revision])).toStrictEqual([[READER, 5]]);
    });

    it("refuses a grant to a chat of a merging guest's until the merge re-points its invite", async () => {
        await harness.run(async (ctx: any) => await setShardRoute(ctx, "merged-guest", OWNER, "user-new-owner"));

        await expect(run(createThreadAccess, { grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: READER })).rejects.toThrow(
            "moving to its owner's signed-in account",
        );

        const counts = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findMany({ where: { threadId } }))) as any;

        await expect(grants()).resolves.toStrictEqual([]);
        expect(counts.page).toStrictEqual([]);
    });

    it("keeps an owner's upgrade of the guest's grant made after the merge chose the new account's", async () => {
        const guestGrant = await seed(GUEST, "read", 1);

        await seed(READER, "write", 1);

        // The merge has read both copies and chosen the new account's wider one; then the owner widens the guest's.
        await mergeRacing(
            ({ args, method }) => method === "findMany" && args[0].where.userId === READER,
            async (ctx) => await ctx.runMutation(updateThreadAccess, { accessId: guestGrant, permission: "admin" }),
        );

        const rows = await grants();

        expect(rows.map((row) => [row.userId, row.permission])).toStrictEqual([[READER, "admin"]]);
        expect(rows[0].revision).toBe(await last());
    });

    it("keeps an owner's upgrade of the new account's grant made after the merge chose the guest's", async () => {
        await seed(GUEST, "write", 1);

        const ownGrant = await seed(READER, "read", 1);

        await mergeRacing(
            ({ args, method }) => method === "findMany" && args[0].where.userId === READER,
            async (ctx) => await ctx.runMutation(updateThreadAccess, { accessId: ownGrant, permission: "admin" }),
        );

        const rows = await grants();

        expect(rows.map((row) => [row._id, row.userId, row.permission])).toStrictEqual([[ownGrant, READER, "admin"]]);
        expect(rows[0].revision).toBe(await last());
    });

    it("keeps the guest's grant when the owner removes the new account's after the merge wrote it", async () => {
        await seed(GUEST, "read", 1);

        const ownGrant = await seed(READER, "write", 1);

        await mergeRacing(
            ({ args, method, result }) => method === "patchIf" && args[1] === ownGrant && result.applied,
            async (ctx) => await ctx.runMutation(deleteThreadAccess, { accessId: ownGrant }),
        );

        const rows = await grants();

        expect(rows.map((row) => [row.userId, row.permission])).toStrictEqual([[READER, "read"]]);
        expect(rows[0].revision).toBe(await last());
    });

    it("refuses an upgrade of a copy the merge marked for its delete, and keeps the upgrade's grant to apply it again", async () => {
        await seed(GUEST, "write", 1);

        const ownGrant = await seed(READER, "read", 1);
        let refused: unknown;

        // The merge keeps the guest's wider copy and has marked the new account's; then the owner widens that copy.
        await mergeRacing(
            ({ args, method, result }) => method === "patchIf" && args[1] === ownGrant && args[2].patch.revision < 0 && result.applied,
            async (ctx) => {
                refused = await ctx.runMutation(updateThreadAccess, { accessId: ownGrant, permission: "admin" }).catch((error: unknown) => error);
            },
        );

        expect(refused).toBeInstanceOf(Error);

        const rows = await grants();

        expect(rows.map((row) => [row.userId, row.permission])).toStrictEqual([[READER, "write"]]);

        // Applied again, to the grant the merge kept: nothing the upgrade gives is lost.
        await run(updateThreadAccess, { accessId: rows[0]._id, permission: "admin" });

        await expect(grants()).resolves.toMatchObject([{ permission: "admin", userId: READER }]);
    });

    it("keeps the guest's grant when the owner removes the kept grant after the merge marked the guest's for its delete", async () => {
        const guestGrant = await seed(GUEST, "read", 1);
        const ownGrant = await seed(READER, "write", 1);

        await mergeRacing(
            ({ args, method, result }) => method === "patchIf" && args[1] === guestGrant && args[2].patch.revision < 0 && result.applied,
            async (ctx) => await ctx.runMutation(deleteThreadAccess, { accessId: ownGrant }),
        );

        const rows = await grants();

        expect(rows.map((row) => [row.userId, row.permission])).toStrictEqual([[READER, "read"]]);
        expect(rows[0].revision).toBe(await last());
    });

    it("counts a removal under the account a merge moved the grant to between the removal's read and its claim", async () => {
        const moved = await seed(GUEST, "read", 1);

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 1, threadId, userId: READER });

            let reads = 0;
            const db = withMembers(ctx.db, {
                threadAccess: withMembers(ctx.db.threadAccess, {
                    findFirst: async (options: any) => {
                        const row = await ctx.db.threadAccess.findFirst(options);

                        // The merge moves the grant right after the removal read it, under a revision it claimed.
                        if (reads === 0) {
                            const counter = await ctx.db.threadAccessRevisions.findFirst({ where: { threadId, userId: READER } });

                            await ctx.db.patch("threadAccess", moved, { revision: 2, userId: READER });
                            await ctx.db.patch("threadAccessRevisions", counter._id, { revision: 2 });
                        }

                        reads += 1;

                        return row;
                    },
                }),
            });

            await removeGrant({ db } as never, (await ctx.db.threadAccess.findFirst({ where: { _id: moved } })) as never);
        });

        expect(await grants()).toStrictEqual([]);
        // Past the moved grant's 2 under the account it moved to: a denial names a revision that grant never held. (The
        // claim made under the guest before the stamp missed is the merge's to fold in, after it moved the grants.)
        expect(await last()).toBe(4);
    });

    it("keeps a revision claimed under the new account while the merge folds the guest's count into it", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 5, threadId, userId: GUEST });
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 4, threadId, userId: READER });

            let raced = false;
            const db = withMembers(ctx.db, {
                threadAccessRevisions: withMembers(ctx.db.threadAccessRevisions, {
                    findFirst: async (options: any) => {
                        const row = await ctx.db.threadAccessRevisions.findFirst(options);

                        // Two claims under the new account land right after the merge read its count of 4.
                        if (!raced && options.where.userId === READER) {
                            raced = true;
                            await advanceGrantRevision(ctx, { threadId: threadId as never, userId: READER });
                            await advanceGrantRevision(ctx, { threadId: threadId as never, userId: READER });
                        }

                        return row;
                    },
                }),
            });

            await expect(mergeGrantRevisionsPage({ db } as never, GUEST, READER)).resolves.toMatchObject({ moved: 1 });
        });

        expect(await last()).toBe(6);
    });

    it("folds in a claim under the guest made while the merge raised the new account's count", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 5, threadId, userId: GUEST });
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 4, threadId, userId: READER });

            let raced = false;
            const db = withMembers(ctx.db, {
                threadAccessRevisions: withMembers(ctx.db.threadAccessRevisions, {
                    findFirst: async (options: any) => {
                        const row = await ctx.db.threadAccessRevisions.findFirst(options);

                        // A change to the guest's grant claims under the guest right after the merge read both counts.
                        if (!raced && options.where.userId === READER) {
                            raced = true;
                            await advanceGrantRevision(ctx, { threadId: threadId as never, userId: GUEST });
                        }

                        return row;
                    },
                }),
            });

            await mergeGrantRevisionsPage({ db } as never, GUEST, READER);
        });

        const rows = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findMany({ where: { threadId } }))) as any;

        expect(rows.page.map((row: any) => [row.userId, row.revision])).toStrictEqual([[READER, 6]]);
    });

    it("loses no claim under the guest that lands between the merge's check of its count and the delete", async () => {
        let claimed: number | undefined;

        await harness.run(async (ctx: any) => {
            await setShardRoute(ctx, "merged-guest", GUEST, READER);
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 5, threadId, userId: GUEST });
            await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision: 4, threadId, userId: READER });

            const db = withMembers(ctx.db, {
                delete: async (table: string, id: string) => {
                    // A change to the guest's grant claims right before the guest's count goes.
                    if (table === "threadAccessRevisions" && claimed === undefined) {
                        claimed = await advanceGrantRevision(ctx, { threadId: threadId as never, userId: GUEST });
                    }

                    return await ctx.db.delete(table, id);
                },
            });

            await mergeGrantRevisionsPage({ db } as never, GUEST, READER);
        });

        const rows = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findMany({ where: { threadId } }))) as any;

        // The claim went to the new account past the guest's 5, so the count still covers the revision it handed out.
        expect(claimed).toBe(6);
        expect(rows.page.map((row: any) => [row.userId, row.revision])).toStrictEqual([[READER, 6]]);
    });
});

/** D1 queries a `ctx.db` call runs on a `.global()` table: a write reads its row first (`@lunora/sql-store`). */
const QUERIES: Readonly<Record<string, number>> = { delete: 2, patch: 2, patchIf: 2 };

/** `db` with the D1 queries of every call counted, a table's reads included. */
const counting = (db: any, count: { queries: number }): any =>
    new Proxy(db, {
        get: (target, key) => {
            const value = target[key];

            if (typeof value === "function") {
                return async (...args: unknown[]) => {
                    count.queries += QUERIES[String(key)] ?? 1;

                    return await value.apply(target, args);
                };
            }

            return value !== null && typeof value === "object" && typeof value.findMany === "function" ? counting(value, count) : value;
        },
    });

describe("a batched grant path's D1 queries", () => {
    const GUEST = "user-guest";
    /** Runs `page` until it reports done, each call counted on its own; the most one call took. */
    const pages = async (page: (ctx: any) => Promise<boolean>): Promise<number> => {
        let most = 0;

        for (let call = 0; call < 100; call += 1) {
            const count = { queries: 0 };
            const done = (await harness.run(async (ctx: any) => await page({ ...ctx, db: counting(ctx.db, count), now: Date.now() }))) as boolean;

            most = Math.max(most, count.queries);

            if (done) {
                return most;
            }
        }

        throw new Error("never done");
    };
    /** A page of the guest's revisions, then of its grants, merged into the new account's; whether none is left. */
    const revisionsPage = async (ctx: any): Promise<boolean> => {
        const { done } = await mergeGrantRevisionsPage(ctx, GUEST, READER);

        return done;
    };
    const grantsPage = async (ctx: any): Promise<boolean> => {
        const { done } = await mergeGrantsPage(ctx, GUEST, READER, GRANT_PAGE_STATEMENTS);

        return done;
    };
    /** `count` chats, each granted to the users `usersOf` names (a name twice: a copy left by an older merge). */
    const seedGrants = async (count: number, usersOf: (index: number) => string[]): Promise<void> => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < count; index += 1) {
                const chat = await ctx.db.insert("threads", { status: "active", title: `T${index}`, userId: OWNER });
                const users = usersOf(index);

                for (const [position, userId] of users.entries()) {
                    // The guest's count above the new account's, so a merge raises it.
                    const revision = userId === GUEST ? 3 : 2;

                    await ctx.db.insert("threadAccess", {
                        grantedAt: 0,
                        grantedBy: OWNER,
                        ownerId: OWNER,
                        permission: "read",
                        revision,
                        threadId: chat,
                        userId,
                    });

                    if (users.indexOf(userId) === position) {
                        await ctx.db.insert("threadAccessRevisions", { ownerId: OWNER, revision, threadId: chat, userId });
                    }
                }
            }
        });
    };

    it("stays within an invocation's D1 queries revoking a chat with many grants and invites", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 20; index += 1) {
                await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: `user-${index}` });
                await ctx.db.insert("threadInvites", {
                    expiresAt: Date.now() + 60_000,
                    invitedBy: OWNER,
                    invitedEmail: `${index}@example.com`,
                    inviteToken: `token-${index}`,
                    ownerId: OWNER,
                    permission: "read",
                    status: "pending",
                    threadId,
                });
            }
        });

        const left = async () =>
            await harness.run(async (ctx: any) => {
                const [grants, invites, revisions] = await Promise.all([
                    ctx.db.threadAccess.findMany({ where: { threadId } }),
                    ctx.db.threadInvites.findMany({ where: { status: "pending", threadId } }),
                    ctx.db.threadAccessRevisions.findMany({ where: { threadId } }),
                ]);

                return { grants: grants.page.length, invites: invites.page.length, revisions: revisions.page.length };
            });

        expect(await pages(async (ctx) => await revokeThreadGrantsPage(ctx, threadId as never, false))).toBeLessThanOrEqual(GRANT_PAGE_STATEMENTS);
        // The trash pass alone revokes every grant and pending invite, and keeps each grantee's revision.
        await expect(left()).resolves.toStrictEqual({ grants: 0, invites: 0, revisions: 20 });

        expect(await pages(async (ctx) => await revokeThreadGrantsPage(ctx, threadId as never, true))).toBeLessThanOrEqual(GRANT_PAGE_STATEMENTS);
        await expect(left()).resolves.toStrictEqual({ grants: 0, invites: 0, revisions: 0 });
    });

    it("counts each removal of a marked guest's grant where its merge keeps it, within an invocation's D1 queries", async () => {
        // Every guest's merge has started and not moved its grant yet; an even guest's count is already folded into its
        // new account's, an odd one's not yet.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 6; index += 1) {
                await ctx.db.insert("threadAccess", {
                    grantedAt: 0,
                    grantedBy: OWNER,
                    ownerId: OWNER,
                    permission: "read",
                    revision: 1,
                    threadId,
                    userId: `guest-${index}`,
                });
                await ctx.db.insert("threadAccessRevisions", {
                    ownerId: OWNER,
                    revision: 1,
                    threadId,
                    userId: index % 2 === 0 ? `account-${index}` : `guest-${index}`,
                });
                await setShardRoute(ctx, "merged-guest", `guest-${index}`, `account-${index}`);
            }
        });

        expect(await pages(async (ctx) => await revokeThreadGrantsPage(ctx, threadId as never, false))).toBeLessThanOrEqual(GRANT_PAGE_STATEMENTS);

        const revisions = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findMany({ where: { threadId } }))) as { page: any[] };

        // Under the guest while it has a count (its denial names it, the merge folds it), else under its new account.
        expect(((await harness.run(async (ctx: any) => await ctx.db.threadAccess.findMany({ where: { threadId } }))) as { page: unknown[] }).page).toHaveLength(
            0,
        );
        expect(revisions.page.map((row) => [row.userId, row.revision]).toSorted(([a], [b]) => String(a).localeCompare(String(b)))).toStrictEqual(
            Array.from({ length: 6 }, (_, index) => [index % 2 === 0 ? `account-${index}` : `guest-${index}`, 3]).toSorted(([a], [b]) =>
                String(a).localeCompare(String(b)),
            ),
        );
    });

    it("stays within an invocation's D1 queries erasing an account that held and gave many grants", async () => {
        await seedGrants(20, () => [READER]);
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 20; index += 1) {
                await ctx.db.insert("threadAccessRevisions", { ownerId: READER, revision: 1, threadId, userId: `user-${index}` });
            }
        });

        const erasePage = async (ctx: any): Promise<boolean> => {
            const { hasMore } = await eraseGrantRevisionsForUser(ctx, READER);

            return !hasMore;
        };

        expect(await pages(erasePage)).toBeLessThanOrEqual(GRANT_PAGE_STATEMENTS);

        const left = (await harness.run(async (ctx: any) => await ctx.db.threadAccessRevisions.findMany({}))) as { page: any[] };

        expect(left.page.filter((row) => row.userId === READER || row.ownerId === READER)).toHaveLength(0);
    });

    it("stays within an invocation's D1 queries merging a guest shared many chats, some with the new account too", async () => {
        await seedGrants(12, () => [GUEST]);
        // Both accounts on the same chats, some with an older merge's second copy on each side.
        await seedGrants(8, (index) => (index % 4 === 0 ? [GUEST, GUEST, READER, READER] : [GUEST, READER]));

        expect(await pages(revisionsPage)).toBeLessThanOrEqual(GRANT_PAGE_STATEMENTS);
        expect(await pages(grantsPage)).toBeLessThanOrEqual(GRANT_PAGE_STATEMENTS);

        const guestRows = (await harness.run(async (ctx: any) => await ctx.db.threadAccess.findMany({ where: { userId: GUEST } }))) as { page: unknown[] };

        expect(guestRows.page).toHaveLength(0);

        const kept = (await harness.run(async (ctx: any) => await ctx.db.threadAccess.findMany({ where: { userId: READER } }))) as { page: any[] };

        // One grant per chat, past the guest's count of 3.
        expect(new Set(kept.page.map((row) => row.threadId)).size).toBe(20);
        expect(kept.page).toHaveLength(20);
        expect(kept.page.every((row) => row.revision > 3)).toBe(true);
    });

    it("merges a chat holding more copies than one invocation's D1 queries pay for, over several calls", async () => {
        // Ten copies an older merge left, five on each side: more than one call can stamp, check and delete.
        await seedGrants(1, () => [GUEST, GUEST, GUEST, GUEST, GUEST, READER, READER, READER, READER, READER]);

        let calls = 0;
        const countedGrantsPage = async (ctx: any): Promise<boolean> => {
            calls += 1;

            return await grantsPage(ctx);
        };

        expect(await pages(revisionsPage)).toBeLessThanOrEqual(GRANT_PAGE_STATEMENTS);
        expect(await pages(countedGrantsPage)).toBeLessThanOrEqual(GRANT_PAGE_STATEMENTS);
        expect(calls).toBeGreaterThan(1);

        const rows = (await harness.run(async (ctx: any) => await ctx.db.threadAccess.findMany({ where: {} }))) as { page: any[] };

        // One grant, the new account's, past the guest's count of 3.
        expect(rows.page.map((row) => row.userId)).toStrictEqual([READER]);
        expect(rows.page[0].revision).toBeGreaterThan(3);
    });
});
