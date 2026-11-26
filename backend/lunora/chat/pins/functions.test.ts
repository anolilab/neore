/**
 * Pins hold a whole message, one image of a reply, or a finished visual or plan (a document) of the thread. A message pin
 * is stored as every pin before images was (no kind), an image pin names the part it pins, and a pin whose kind and part
 * index do not fit together is refused. A document pin is one per document and reads its title from the document.
 */
import { lunoraTest } from "@lunora/testing";
import { LunoraError } from "lunorash/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../../_generated/dataModel";
import { resolveThreadReadAccess } from "../../agent/thread-read-access";
import { BATCH } from "../../gdpr/batch";
import { beginAccountMove, endAccountMove, fencePinsOnShard, unfencePinsOnShard } from "../../lib/account-moves";
import { sweepRoutePage } from "../../gdpr/owner-sweep";
import { accountDeletionWorkflowConfig } from "../../gdpr/workflows/deletion-workflow";
import schema from "../../schema";
import {
    createDocumentPin,
    createPin,
    deletePin,
    dispatchPendingPinRestores,
    dropRoutesWithoutPins,
    eraseUserPinsOnThread,
    finishRouteCleanup,
    getThreadPins,
    isPinShapeValid,
    PENDING_RESTORE_BATCH,
    PENDING_RESTORE_WORST,
    reassignUserPinsOnThread,
    restoreSharedPinRoutes,
    withSharedPinRoute,
} from "./functions";
import { ERASE_DRAIN_ROWS, ERASE_DRAIN_WORST, eraseSharedPinRoutesBatch, MATERIALIZE_WORST, materializePendingPinRoutesBatch } from "../gdpr";

let OWNER = "";
let COLLABORATOR = "";
let STRANGER = "";
const SHAPE_ERROR = /An image pin names the part it pins/;
const KIND_ERROR = /Only visuals and plans can be pinned/;
const WRITING_ERROR = /still being written/;
const NOT_FOUND_ERROR = /Document not found in this chat/;
const NO_ACCESS_ERROR = /Thread not found or you do not have access/;
const MOVED_ACCOUNT_ERROR = /cannot be added while this account is being moved or erased/;

vi.mock("../../lib/crpc-auth-helpers", async (importOriginal) => {
    const sessionFrom = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { activeOrganization: null, id: context.auth.userId, userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("../../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

// Wraps the grant lookup so a test can read the options each gate call passes, while the real lookup still runs.
vi.mock("../../agent/thread-read-access", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../agent/thread-read-access")>();

    return { ...actual, resolveThreadReadAccess: vi.fn(actual.resolveThreadReadAccess) };
});

vi.mock("../../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let threadId: Id<"threads">;

const as = (userId: string) => harness.withIdentity({ userId });

/**
 * Runs the scheduled route cleanup once the writes' leases have run out, as it does in production: a finished write's lease lasts a minute,
 * and the cleanup waits for it. The leases are removed here instead of waiting.
 */
const runRouteCleanup = async (userId: string) => {
    await harness.run(async (context: any) => {
        const { page } = await context.db.pinWriteLeases.findMany({ where: { userId } });

        for (const lease of page) {
            await context.db.delete("pinWriteLeases", lease._id);
        }

        await finishRouteCleanup(context, threadId, userId);
    });
};

/** Gives the collaborator write access to the thread, as a grant does. */
const grantWrite = async () =>
    await harness.run(
        async (context: any) =>
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: COLLABORATOR }),
    );

const pinsOf = async () => (await as(OWNER).query(getThreadPins as never, { threadId } as never)) as Record<string, unknown>[];

beforeEach(async () => {
    harness = lunoraTest(schema as never);

    // A pin write checks its account row at its last step (`lib/account-moves.ts#refusesPinWrite`), so each writing account needs one.
    // The harness assigns the id of a row it inserts, so the suite reads the ids back and uses them as the accounts.
    const [owner, collaborator, stranger] = (await harness.run(async (context: any) => {
        const ids: string[] = [];

        for (const name of ["owner", "collaborator", "stranger"]) {
            ids.push(await context.db.insert("user", { createdAt: 0, email: `${name}@example.com`, emailVerified: true, name, updatedAt: 0 }));
        }

        return ids;
    })) as [string, string, string];

    OWNER = owner;
    COLLABORATOR = collaborator;
    STRANGER = stranger;

    threadId = await harness.run(
        async (context: any) =>
            await context.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: "Logo ideas",
                userId: OWNER,
            }),
    );
});

describe(isPinShapeValid, () => {
    it.each([
        [{}, true],
        [{ kind: "message" as const }, true],
        [{ imageIndex: 0, kind: "image" as const }, true],
        [{ kind: "image" as const }, false],
        [{ imageIndex: 2 }, false],
        [{ imageIndex: 2, kind: "message" as const }, false],
        [{ imageIndex: 0, imageKey: "/agent-files/a", kind: "image" as const }, true],
        [{ imageKey: "/agent-files/a" }, false],
    ])("%o is %s", (shape, expected) => {
        expect(isPinShapeValid(shape)).toBe(expected);
    });
});

describe("image pins", () => {
    it("stores an image pin with its image index and storage path and returns it", async () => {
        await as(OWNER).mutation(
            createPin as never,
            {
                imageIndex: 2,
                imageKey: "/agent-files/abc",
                kind: "image",
                messageId: "m-1",
                messageRole: "assistant",
                selectedText: "A fox logo, flat colours",
                threadId,
            } as never,
        );

        const [pin] = await pinsOf();

        expect(pin).toMatchObject({ imageIndex: 2, imageKey: "/agent-files/abc", kind: "image", messageId: "m-1", selectedText: "A fox logo, flat colours" });
    });

    it("stores a message pin as before, with no kind and no part index", async () => {
        await as(OWNER).mutation(createPin as never, { messageId: "m-2", messageRole: "assistant", threadId } as never);

        const [pin] = await pinsOf();

        expect(pin).toMatchObject({ messageId: "m-2" });
        expect(pin).not.toHaveProperty("kind");
        expect(pin).not.toHaveProperty("imageIndex");
    });

    it("stores no kind for an explicit message pin either", async () => {
        await as(OWNER).mutation(createPin as never, { kind: "message", messageId: "m-3", messageRole: "user", threadId } as never);

        const [pin] = await pinsOf();

        expect(pin).not.toHaveProperty("kind");
    });

    it("refuses an image pin that names no part", async () => {
        await expect(as(OWNER).mutation(createPin as never, { kind: "image", messageId: "m-1", messageRole: "assistant", threadId } as never)).rejects.toThrow(
            SHAPE_ERROR,
        );
        expect(await pinsOf()).toHaveLength(0);
    });

    it("refuses a message pin that names a part", async () => {
        await expect(as(OWNER).mutation(createPin as never, { imageIndex: 1, messageId: "m-1", messageRole: "assistant", threadId } as never)).rejects.toThrow(
            SHAPE_ERROR,
        );
        expect(await pinsOf()).toHaveLength(0);
    });

    it("refuses a part index that is negative or not whole", async () => {
        for (const imageIndex of [-1, 1.5]) {
            await expect(
                as(OWNER).mutation(createPin as never, { imageIndex, kind: "image", messageId: "m-1", messageRole: "assistant", threadId } as never),
            ).rejects.toThrow();
        }

        expect(await pinsOf()).toHaveLength(0);
    });
});

describe("document pins", () => {
    const insertDocument = async (fields: { kind: string; status?: "idle" | "streaming"; threadId?: Id<"threads">; title?: string }) =>
        await harness.run(
            async (context: any) =>
                await context.db.insert("documents", {
                    kind: fields.kind,
                    messageId: "m-doc",
                    status: fields.status ?? "idle",
                    threadId: fields.threadId ?? threadId,
                    title: fields.title ?? "Fox logo",
                    userId: OWNER,
                    version: 1,
                }),
        );

    const pinDocument = (documentId: string) => as(OWNER).mutation(createDocumentPin as never, { documentId, threadId } as never);

    it("stores a visual with its title, its kind and the message that made it, and no image part", async () => {
        const documentId = await insertDocument({ kind: "design", title: "Launch banner" });

        await pinDocument(documentId);

        const [pin] = await pinsOf();

        expect(pin).toMatchObject({
            documentId,
            documentKind: "design",
            kind: "document",
            messageId: "m-doc",
            messageRole: "assistant",
            selectedText: "Launch banner",
        });
        expect(pin).not.toHaveProperty("imageIndex");
    });

    it("pins a plan written as a text document", async () => {
        const documentId = await insertDocument({ kind: "text", title: "Migration plan" });

        await pinDocument(documentId);

        expect(await pinsOf()).toMatchObject([{ documentKind: "text", selectedText: "Migration plan" }]);
    });

    it("is one pin however often the same document is pinned", async () => {
        const documentId = await insertDocument({ kind: "image" });

        const first = await pinDocument(documentId);
        const second = await pinDocument(documentId);

        expect(second).toBe(first);
        expect(await pinsOf()).toHaveLength(1);
    });

    it("refuses code and sheet documents, which are not pinned", async () => {
        for (const kind of ["code", "sheet"]) {
            const documentId = await insertDocument({ kind });

            await expect(pinDocument(documentId)).rejects.toThrow(KIND_ERROR);
        }

        expect(await pinsOf()).toHaveLength(0);
    });

    it("refuses a document that is still being written", async () => {
        const documentId = await insertDocument({ kind: "design", status: "streaming" });

        await expect(pinDocument(documentId)).rejects.toThrow(WRITING_ERROR);
        expect(await pinsOf()).toHaveLength(0);
    });

    it("refuses a document of another chat", async () => {
        const otherThreadId = await harness.run(
            async (context: any) => await context.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Other", userId: OWNER }),
        );
        const documentId = await insertDocument({ kind: "design", threadId: otherThreadId as Id<"threads"> });

        await expect(pinDocument(documentId)).rejects.toThrow(NOT_FOUND_ERROR);
        expect(await pinsOf()).toHaveLength(0);
    });

    it("refuses a document of a thread the caller has no grant for", async () => {
        const documentId = await insertDocument({ kind: "design" });

        await expect(as(STRANGER).mutation(createDocumentPin as never, { documentId, threadId } as never)).rejects.toThrow(NO_ACCESS_ERROR);
        expect(await pinsOf()).toHaveLength(0);
    });

    it("reads the caller's grant from the primary, so a replica's stale grant cannot admit the pin", async () => {
        const documentId = await insertDocument({ kind: "design" });
        const lookup = vi.mocked(resolveThreadReadAccess);

        lookup.mockClear();
        await pinDocument(documentId);

        expect(lookup).toHaveBeenCalled();
        expect(lookup.mock.calls.every((call) => call[4]?.primary === true)).toBe(true);
    });
});

describe("the route a collaborator's pin leaves", () => {
    it("drops every route to the thread once the last pin goes, even a duplicate a merge left", async () => {
        await harness.run(
            async (context: any) =>
                await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: COLLABORATOR }),
        );

        const pinId = await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-12", messageRole: "assistant", threadId } as never);

        await harness.run(async (context: any) => await context.db.insert("sharedPinRoutes", { createdAt: 2, ownerId: OWNER, threadId, userId: COLLABORATOR }));

        await as(COLLABORATOR).mutation(deletePin as never, { pinId, threadId } as never);
        // The scheduled cleanup, after the delete committed.
        await runRouteCleanup(COLLABORATOR);

        const routes = await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } });

            return page as unknown[];
        });

        expect(routes).toHaveLength(0);
    });

    it("drops the route once a collaborator deletes their last pin on the thread", async () => {
        await harness.run(
            async (context: any) =>
                await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: COLLABORATOR }),
        );

        const pinId = await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-11", messageRole: "assistant", threadId } as never);

        await as(COLLABORATOR).mutation(deletePin as never, { pinId, threadId } as never);
        // The scheduled cleanup, after the delete committed.
        await runRouteCleanup(COLLABORATOR);

        const routes = await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } });

            return page as unknown[];
        });

        expect(routes).toHaveLength(0);
    });

    it("refuses a message pin from a caller with no grant on an unlocked thread", async () => {
        await expect(as(STRANGER).mutation(createPin as never, { messageId: "m-7", messageRole: "assistant", threadId } as never)).rejects.toThrow(
            NO_ACCESS_ERROR,
        );
        const strangerPins = await harness.run(async (context: any) => {
            const { page } = await context.db.threadPins.findMany({ where: { userId: STRANGER } });

            return page as unknown[];
        });

        expect(strangerPins).toHaveLength(0);
    });

    it("records the owner, so the collaborator's export finds the pin after the grant is revoked", async () => {
        await harness.run(
            async (context: any) =>
                await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: COLLABORATOR }),
        );

        await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-9", messageRole: "assistant", threadId } as never);

        const routes = await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } });

            return page as unknown[];
        });

        expect(routes).toMatchObject([{ ownerId: OWNER, threadId, userId: COLLABORATOR }]);
    });
});

describe("a collaborator's pins on the owner's shard", () => {
    it("erases one user's pins on one thread and leaves the owner's and every other thread's", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadPins", { createdAt: 1, messageRole: "assistant", threadId, updatedAt: 1, userId: COLLABORATOR });
            await context.db.insert("threadPins", { createdAt: 1, messageRole: "assistant", threadId, updatedAt: 1, userId: OWNER });
        });

        await harness.run(async (context: any) => await context.runMutation(eraseUserPinsOnThread, { threadId, userId: COLLABORATOR }));

        const left = await harness.run(async (context: any) => {
            const rows = await context.db.query("threadPins").collect();

            return rows.map((row: { userId: string }) => row.userId) as unknown[];
        });

        expect(left).toStrictEqual([OWNER]);
    });

    it("moves one user's pins on one thread to the new account", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadPins", { createdAt: 1, messageRole: "assistant", threadId, updatedAt: 1, userId: "user-guest" });
        });

        await harness.run(async (context: any) => await context.runMutation(reassignUserPinsOnThread, { from: "user-guest", threadId, to: "user-new" }));

        const owners = await harness.run(async (context: any) => {
            const rows = await context.db.query("threadPins").collect();

            return rows.map((row: { userId: string }) => row.userId) as unknown[];
        });

        expect(owners).toStrictEqual(["user-new"]);
    });

    it.each(["user-guest", "user-new"])("moves no pin once an erasure of %s has begun, and says so", async (erased) => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadPins", { createdAt: 1, messageRole: "assistant", threadId, updatedAt: 1, userId: "user-guest" });
            await context.db.insert("accountMoves", { createdAt: Date.now(), kind: "erasing", userId: erased });
        });

        try {
            expect(
                await harness.run(
                    async (context: any) => await context.runMutation(reassignUserPinsOnThread, { from: "user-guest", threadId, to: "user-new" }),
                ),
            ).toStrictEqual({ erasing: true, hasMore: false });

            const owners = await harness.run(async (context: any) => {
                const rows = await context.db.query("threadPins").collect();

                return rows.map((row: { userId: string }) => row.userId) as unknown[];
            });

            expect(owners).toStrictEqual(["user-guest"]);
        } finally {
            await harness.run(async (context: any) => {
                const pins = await context.db.query("threadPins").collect();

                for (const row of pins) {
                    await context.db.delete("threadPins", row._id);
                }

                const { page } = await context.db.accountMoves.findMany({ where: { userId: erased } });

                for (const row of page) {
                    await context.db.delete("accountMoves", row._id);
                }
            });
        }
    });
});

describe("listing a thread's pins after a grant is revoked", () => {
    it("returns a collaborator's own pins while the grant stands, and none once it is revoked", async () => {
        const grantId = await harness.run(async (context: any) => {
            await context.db.insert("threadPins", {
                createdAt: 1,
                messageRole: "assistant",
                selectedText: "Launch banner",
                threadId,
                updatedAt: 1,
                userId: COLLABORATOR,
            });

            return await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId, userId: COLLABORATOR });
        });
        const listed = async () => (await as(COLLABORATOR).query(getThreadPins as never, { threadId } as never)) as unknown[];

        expect(await listed()).toHaveLength(1);

        await harness.run(async (context: any) => await context.db.delete("threadAccess", grantId));

        expect(await listed()).toHaveLength(0);
    });
});

describe("a deleted thread takes its pins and routes", () => {
    it("removes the thread's pins and the collaborator routes that name it", async () => {
        const { eraseThreadPinsAndRoutesBatch } = await import("../gdpr");

        await harness.run(async (context: any) => {
            await context.db.insert("threadPins", { createdAt: 1, messageRole: "assistant", threadId, updatedAt: 1, userId: COLLABORATOR });
            await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: OWNER, threadId, userId: COLLABORATOR });
        });

        // One batch per call: repeat until none is left, as the thread's delete chain does.
        let hasMore = true;

        while (hasMore) {
            const batch = await harness.run(async (context: any) => await eraseThreadPinsAndRoutesBatch(context, threadId));

            hasMore = batch.hasMore;
        }

        const left = await harness.run(async (context: any) => {
            const pins = await context.db.query("threadPins").collect();
            const routes = await context.db.sharedPinRoutes.findMany({ where: { threadId } });

            return { pins: pins.length, routes: routes.page.length };
        });

        expect(left).toStrictEqual({ pins: 0, routes: 0 });
    });

    it("cuts a heavily pinned thread into batches: one call never deletes more than one batch", async () => {
        const { eraseThreadPinsAndRoutesBatch } = await import("../gdpr");

        await harness.run(async (context: any) => {
            for (let n = 0; n < BATCH + 1; n += 1) {
                await context.db.insert("threadPins", { createdAt: 1, messageRole: "assistant", threadId, updatedAt: 1, userId: COLLABORATOR });
            }
        });

        const first = await harness.run(async (context: any) => await eraseThreadPinsAndRoutesBatch(context, threadId));
        const pinsLeft = await harness.run(async (context: any) => await context.db.query("threadPins").collect());
        const remaining = pinsLeft.length;

        expect(first).toStrictEqual({ hasMore: true });
        expect(remaining).toBe(1);

        const second = await harness.run(async (context: any) => await eraseThreadPinsAndRoutesBatch(context, threadId));

        expect(second).toStrictEqual({ hasMore: false });
    });
});

describe("an account being moved or erased cannot add pins", () => {
    it("refuses a pin from an account marked as erasing, and keeps accepting from an unmarked one", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: COLLABORATOR });
            await context.db.insert("accountMoves", { createdAt: 1, kind: "erasing", userId: COLLABORATOR });
        });

        await expect(as(COLLABORATOR).mutation(createPin as never, { messageId: "m-20", messageRole: "assistant", threadId } as never)).rejects.toThrow(
            MOVED_ACCOUNT_ERROR,
        );

        await expect(as(OWNER).mutation(createPin as never, { messageId: "m-21", messageRole: "assistant", threadId } as never)).resolves.toBeDefined();
    });

    it("refuses a pin from an account whose row is gone, even when no marker or live lease is left, and leaves no pin, route or lease", async () => {
        // The state a merge leaves once it has finished: no marker, no live lease, and the guest's row deleted. The write was admitted
        // before the merge and reaches its final check after it. Only the account row says the account is gone.
        const GONE = "user-gone";

        await harness.run(async (context: any) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: GONE });
        });

        await expect(as(GONE).mutation(createPin as never, { messageId: "m-30", messageRole: "assistant", threadId } as never)).rejects.toThrow(
            MOVED_ACCOUNT_ERROR,
        );

        await harness.run(async (context: any) => {
            const pins = await context.db.threadPins.findMany({ consistency: "primary", where: { threadId } });
            const routes = await context.db.sharedPinRoutes.findMany({ consistency: "primary", where: { threadId, userId: GONE } });
            const leases = await context.db.pinWriteLeases.findMany({ consistency: "primary", where: { userId: GONE } });

            expect(pins.page.filter((pin: { userId: string }) => pin.userId === GONE)).toStrictEqual([]);
            expect(routes.page).toStrictEqual([]);
            expect(leases.page).toStrictEqual([]);
        });
    });
});

describe("a failed pin write leaves its shared route", () => {
    it("keeps the route, since a concurrent writer may be relying on it, and writes no pin", async () => {
        // The failure is caught inside the run: an uncaught error would roll the whole run back, route included, and prove nothing.
        const message = await harness.run(async (context: any) => {
            try {
                await withSharedPinRoute(context, threadId, COLLABORATOR, 1, async () => {
                    throw new Error("pin write failed");
                });

                return null;
            } catch (error) {
                return (error as Error).message;
            }
        });

        expect(message).toBe("pin write failed");

        const routes = await harness.run(async (context: any) => await context.db.sharedPinRoutes.findMany({ where: { threadId } }));

        expect(routes.page).toHaveLength(1);
    });
});

describe("a refused pin write takes back the route it wrote", () => {
    const refusal = () => new LunoraError("FORBIDDEN", "Pins cannot be added while this account is being moved or erased");

    it("removes the route when the collaborator holds no pin on the thread", async () => {
        // A refusal after the route write: the erasure's drain may already have passed, so the route must not stay behind.
        const message = await harness.run(async (context: any) => {
            try {
                await withSharedPinRoute(context, threadId, COLLABORATOR, 1, async () => {
                    throw refusal();
                });

                return null;
            } catch (error) {
                return (error as Error).message;
            }
        });

        expect(message).toBe("Pins cannot be added while this account is being moved or erased");

        const routes = await harness.run(async (context: any) => await context.db.sharedPinRoutes.findMany({ where: { threadId } }));

        expect(routes.page).toHaveLength(0);
    });

    it("keeps the route when the collaborator already holds a pin on the thread", async () => {
        const routes = await harness.run(async (context: any) => {
            await context.db.insert("threadPins", {
                createdAt: 1,
                messageId: "m-held",
                messageRole: "assistant",
                threadId,
                updatedAt: 1,
                userId: COLLABORATOR,
            });

            await withSharedPinRoute(context, threadId, COLLABORATOR, 1, async () => {
                throw refusal();
            }).catch(() => null);

            return await context.db.sharedPinRoutes.findMany({ where: { threadId } });
        });

        expect(routes.page).toHaveLength(1);
    });

    it("removes one batch of duplicate routes in the refused write, and leaves the rest to the scheduled cleanup", async () => {
        const routes = await harness.run(async (context: any) => {
            for (let index = 0; index < 150; index += 1) {
                await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: OWNER, threadId, userId: COLLABORATOR });
            }

            await withSharedPinRoute(context, threadId, COLLABORATOR, 1, async () => {
                throw refusal();
            }).catch(() => null);

            return await context.db.sharedPinRoutes.findMany({ where: { threadId } });
        });

        expect(routes.page).toHaveLength(50);
    });

    it("finishes the rest of the duplicate routes once the job runs, without a pin of the caller's left", async () => {
        await harness.run(async (context: any) => {
            for (let index = 0; index < 150; index += 1) {
                await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: OWNER, threadId, userId: COLLABORATOR });
            }
        });

        // The job runs the same step again until a batch comes back short.
        for (let batch = 0; batch < 2; batch += 1) {
            await harness.run(async (context: any) => await dropRoutesWithoutPins(context, threadId, COLLABORATOR));
        }

        const routes = await harness.run(async (context: any) => await context.db.sharedPinRoutes.findMany({ where: { threadId } }));

        expect(routes.page).toHaveLength(0);
    });

    it("keeps the route while another admitted write of the account is still in flight", async () => {
        // The other write's lease has not run out, so it may still use the route: the refused write must not take it back.
        const routes = await harness.run(async (context: any) => {
            await context.db.insert("pinWriteLeases", { expiresAt: Date.now() + 60_000, userId: COLLABORATOR, writerId: "writer-other" });

            await withSharedPinRoute(
                context,
                threadId,
                COLLABORATOR,
                1,
                async () => {
                    throw refusal();
                },
                "writer-self",
            ).catch(() => null);

            return await context.db.sharedPinRoutes.findMany({ where: { threadId } });
        });

        expect(routes.page).toHaveLength(1);
    });

    it("ignores its own lease, and removes the route once no other write is in flight", async () => {
        const routes = await harness.run(async (context: any) => {
            // Live, so the write's own exclusion is what lets the route go: an expired lease would pass without it.
            await context.db.insert("pinWriteLeases", { expiresAt: Date.now() + 60_000, userId: COLLABORATOR, writerId: "writer-self" });

            await withSharedPinRoute(
                context,
                threadId,
                COLLABORATOR,
                1,
                async () => {
                    throw refusal();
                },
                "writer-self",
            ).catch(() => null);

            return await context.db.sharedPinRoutes.findMany({ where: { threadId } });
        });

        expect(routes.page).toHaveLength(0);
    });
});

describe("a pin write renews the writer's lease before its move check", () => {
    it("leaves the owner's lease in place after a pin is written", async () => {
        await as(OWNER).mutation(createPin as never, { messageId: "m-lease", messageRole: "assistant", threadId } as never);

        const leases = await harness.run(async (context: any) => await context.db.pinWriteLeases.findMany({ where: { userId: OWNER } }));

        expect(leases.page).toHaveLength(1);
    });
});

describe("a refused write's owed route restore is durable", () => {
    const owedRestore = (overrides: { dispatchedAt?: number; until?: number } = {}) => {
        return {
            dispatchedAt: overrides.dispatchedAt ?? Date.now(),
            ownerId: OWNER,
            routeCreatedAt: 1,
            threadId,
            until: overrides.until ?? Date.now() + 60_000,
            userId: COLLABORATOR,
        };
    };
    const insertOwed = async (overrides: { dispatchedAt?: number; until?: number } = {}) =>
        (await harness.run(async (context: any) => await context.db.insert("pendingPinRestores", owedRestore(overrides)))) as string;
    const owedRows = async () => {
        const { page } = await harness.run(async (context: any) => await context.db.pendingPinRestores.findMany({ where: { userId: COLLABORATOR } }));

        return page as { _id: string }[];
    };
    const routesNow = async () => {
        const { page } = await harness.run(async (context: any) => await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } }));

        return page as { ownerId: string }[];
    };
    const restoreFor = async (owedId: string, until = Date.now() + 60_000) =>
        await harness.run(
            async (context: any) => await context.runMutation(restoreSharedPinRoutes, { createdAt: 1, owedId, threadId, until, userId: COLLABORATOR }),
        );
    /** One cron pass; returns the scheduled restores it sent, as `[args, shard]` pairs. */
    const cronPass = async () => {
        const scheduled: { args: Record<string, unknown>; shard: unknown }[] = [];

        await harness.run(async (context: any) => {
            const scheduler = {
                runAfter: async (_delay: number, _target: unknown, args: Record<string, unknown>, options: { shardKey: unknown }) => {
                    scheduled.push({ args, shard: options.shardKey });

                    return "job";
                },
            };

            await dispatchPendingPinRestores({ ...context, scheduler });
        });

        return scheduled;
    };

    it("a refused write with nothing in flight takes its route, and leaves no owed row behind", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: OWNER, threadId, userId: COLLABORATOR });
            await dropRoutesWithoutPins(context, threadId, COLLABORATOR, null, true);
        });

        expect(await routesNow()).toHaveLength(0);
        expect(await owedRows()).toHaveLength(0);
    });

    it("a refused write keeps its routes when the thread is not on this shard, since no owed restore could reach them", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: OWNER, threadId, userId: COLLABORATOR });
            await context.db.delete("threads", threadId);
            await dropRoutesWithoutPins(context, threadId, COLLABORATOR, null, true);
        });

        expect(await routesNow()).toHaveLength(1);
        expect(await owedRows()).toHaveLength(0);
    });

    it("the cron pass sends a row dispatched long ago to the owner it names, with its own row id, and not one dispatched a moment ago", async () => {
        const stale = await insertOwed({ dispatchedAt: Date.now() - 120_000 });

        await insertOwed({ dispatchedAt: Date.now() });

        const scheduled = await cronPass();

        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]?.args).toStrictEqual({ createdAt: 1, owedId: stale, threadId, until: expect.any(Number), userId: COLLABORATOR });
        expect(scheduled[0]?.shard).toBe(OWNER);
        // Sent once: its dispatch time is now, so the next pass waits a grace period before it sends it again.
        expect(await cronPass()).toHaveLength(0);
    });

    it("the cron pass reaches every owed row, not only the first batch, across passes", async () => {
        // One more row than a pass takes, so the second pass is needed to reach the last one.
        const rows = PENDING_RESTORE_BATCH + 1;

        for (let index = 0; index < rows; index += 1) {
            await insertOwed({ dispatchedAt: Date.now() - 120_000 - index });
        }

        const sent = [...(await cronPass()), ...(await cronPass())].map((entry) => (entry.args as { owedId: string }).owedId);

        expect(new Set(sent).size).toBe(rows);
    });

    it("a restore settles only its own row: another write's row for the same thread and collaborator keeps its own deadline", async () => {
        const mine = await insertOwed({ until: Date.now() - 1 });
        const other = await insertOwed({ until: Date.now() + 60_000 });

        // Past its deadline with no pin: nothing needs this route, so its own row settles and no route is added.
        await restoreFor(mine, Date.now() - 1);

        const rows = await owedRows();

        expect(rows.map((row) => row._id)).toStrictEqual([other]);
        expect(await routesNow()).toHaveLength(0);
    });

    it("a restore that puts the route back settles its row", async () => {
        const owed = await insertOwed();

        await restoreFor(owed);

        const routes = await routesNow();

        expect(routes.map((route) => route.ownerId)).toStrictEqual([OWNER]);
        expect(await owedRows()).toHaveLength(0);
    });

    it("a restore past the deadline with no pin settles its row, and adds no route", async () => {
        const owed = await insertOwed({ until: Date.now() - 1 });

        await restoreFor(owed, Date.now() - 1);

        expect(await routesNow()).toHaveLength(0);
        expect(await owedRows()).toHaveLength(0);
    });

    it("a thread that is not on this shard keeps its row for the cron, which sends it to the owner it names", async () => {
        const owed = await insertOwed();

        await harness.run(async (context: any) => await context.db.delete("threads", threadId));
        await restoreFor(owed);

        expect(await owedRows()).toHaveLength(1);
        expect(await routesNow()).toHaveLength(0);
    });

    it("the erasure turns the owed row into the collaborator's route before its second sweep, and removes the row", async () => {
        await insertOwed();

        const result = await harness.run(async (context: any) => await materializePendingPinRoutesBatch(context, COLLABORATOR));

        expect(result).toStrictEqual({ hasMore: false });
        const routes = await routesNow();

        expect(routes.map((route) => route.ownerId)).toStrictEqual([OWNER]);
        expect(await owedRows()).toHaveLength(0);
    });

    it("the erasure's route drain removes the owed rows that name the erased account", async () => {
        await insertOwed();

        await harness.run(async (context: any) => await eraseSharedPinRoutesBatch(context, COLLABORATOR));

        expect(await owedRows()).toHaveLength(0);
    });
});

describe("refused pin writes renew no lease", () => {
    it("leaves no lease behind after repeated refused attempts from a marked account", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: COLLABORATOR });
            await context.db.insert("accountMoves", { createdAt: 1, kind: "erasing", userId: COLLABORATOR });
        });

        for (let attempt = 0; attempt < 3; attempt += 1) {
            await expect(
                as(COLLABORATOR).mutation(createPin as never, { messageId: `m-refused-${String(attempt)}`, messageRole: "assistant", threadId } as never),
            ).rejects.toThrow(MOVED_ACCOUNT_ERROR);
        }

        const leases = await harness.run(async (context: any) => await context.db.pinWriteLeases.findMany({ where: { userId: COLLABORATOR } }));

        expect(leases.page).toHaveLength(0);
    });
});

describe("the route cleanup and the erasure's owner sweep", () => {
    const routesOf = async (userId: string) =>
        await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId } });

            return page as unknown[];
        });

    it("defers the route removal to the scheduled cleanup, which runs after the delete commits", async () => {
        await grantWrite();

        const pinId = await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-defer", messageRole: "assistant", threadId } as never);

        await as(COLLABORATOR).mutation(deletePin as never, { pinId, threadId } as never);

        expect(await routesOf(COLLABORATOR)).toHaveLength(1);

        await runRouteCleanup(COLLABORATOR);

        expect(await routesOf(COLLABORATOR)).toHaveLength(0);
    });

    it("takes none of the routes while another write is in flight, so there is nothing to put back", async () => {
        const routes = await harness.run(async (context: any) => {
            for (let index = 0; index < 3; index += 1) {
                await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: OWNER, threadId, userId: COLLABORATOR });
            }

            await context.db.insert("pinWriteLeases", { expiresAt: Date.now() + 60_000, userId: COLLABORATOR, writerId: "writer-other" });

            await dropRoutesWithoutPins(context, threadId, COLLABORATOR);

            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } });

            return page as unknown[];
        });

        expect(routes).toHaveLength(3);
    });

    it("leaves the routes of a thread that is no longer on this shard", async () => {
        const moved = "thread-moved" as Id<"threads">;

        const routes = await harness.run(async (context: any) => {
            await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: OWNER, threadId: moved, userId: COLLABORATOR });

            await finishRouteCleanup(context, moved, COLLABORATOR);

            const { page } = await context.db.sharedPinRoutes.findMany({ where: { threadId: moved } });

            return page as unknown[];
        });

        expect(routes).toHaveLength(1);
    });

    it("keeps the routes while a guest merge is moving the account, and takes them once the merge ends", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: OWNER, threadId, userId: COLLABORATOR });
            await context.db.insert("accountMoves", { createdAt: Date.now(), kind: "merging", userId: COLLABORATOR });

            await dropRoutesWithoutPins(context, threadId, COLLABORATOR);
        });

        // The merge has not transferred the route yet, so it is still the only way to find the moved pins.
        expect(await routesOf(COLLABORATOR)).toHaveLength(1);

        await harness.run(async (context: any) => {
            const { page } = await context.db.accountMoves.findMany({ where: { userId: COLLABORATOR } });

            for (const row of page) {
                await context.db.delete("accountMoves", row._id);
            }
        });

        await harness.run(async (context: any) => await dropRoutesWithoutPins(context, threadId, COLLABORATOR));

        expect(await routesOf(COLLABORATOR)).toHaveLength(0);
    });

    it("refuses a collaborator's pin written after the owner sweep fenced the shard, and leaves no pin behind", async () => {
        await grantWrite();

        await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-before-sweep", messageRole: "assistant", threadId } as never);

        // The owner-shard sweep: the shard is fenced, then the collaborator's pins on the thread are erased.
        await harness.run(async (context: any) => await context.db.insert("shardPinFences", { createdAt: 1, userId: COLLABORATOR }));
        await harness.run(async (context: any) => await context.runMutation(eraseUserPinsOnThread, { threadId, userId: COLLABORATOR }));

        await expect(
            as(COLLABORATOR).mutation(createPin as never, { messageId: "m-after-sweep", messageRole: "assistant", threadId } as never),
        ).rejects.toThrow(MOVED_ACCOUNT_ERROR);

        const pins = await harness.run(async (context: any) => {
            const rows: { userId: string }[] = await context.db.query("threadPins").collect();

            return rows.filter((row) => row.userId === COLLABORATOR);
        });

        expect(pins).toHaveLength(0);
    });
});

describe("a fenced owner shard refuses a pin write of the account", () => {
    it("refuses the write in its own transaction, while the fence is on the shard", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: COLLABORATOR });
            await context.db.insert("shardPinFences", { createdAt: 1, userId: COLLABORATOR });
        });

        await expect(as(COLLABORATOR).mutation(createPin as never, { messageId: "m-fenced", messageRole: "assistant", threadId } as never)).rejects.toThrow(
            MOVED_ACCOUNT_ERROR,
        );
    });
});

describe("the thread owner's merge, and the erasure replayed in order", () => {
    const routesOfCollaborator = async () =>
        await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } });

            return page as unknown[];
        });

    it("takes no route while the thread's owner is merging, and takes it once the merge ends", async () => {
        await grantWrite();

        const pinId = await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-owner-merge", messageRole: "assistant", threadId } as never);

        // The pin has moved with the thread to the merged account's shard; this shard keeps only the collaborator's route.
        await harness.run(async (context: any) => await context.db.delete("threadPins", pinId as never));

        await harness.run(async (context: any) => await beginAccountMove(context, OWNER, "merging", Date.now()));
        await runRouteCleanup(COLLABORATOR);

        expect(await routesOfCollaborator()).toHaveLength(1);

        await harness.run(async (context: any) => await endAccountMove(context, OWNER, "merging"));
        await runRouteCleanup(COLLABORATOR);

        expect(await routesOfCollaborator()).toHaveLength(0);
    });

    it("restores the route to the thread's owner once, however often the restore runs", async () => {
        await grantWrite();
        await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-restore", messageRole: "assistant", threadId } as never);
        await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } });

            for (const route of page) {
                await context.db.delete("sharedPinRoutes", route._id);
            }
        });

        const args = { createdAt: 1, threadId, until: Date.now() + 60_000, userId: COLLABORATOR };

        await harness.run(async (context: any) => await context.runMutation(restoreSharedPinRoutes, args));
        await harness.run(async (context: any) => await context.runMutation(restoreSharedPinRoutes, args));

        const routes = await routesOfCollaborator();

        expect(routes.map((route: any) => route.ownerId)).toStrictEqual([OWNER]);
    });

    it("does nothing once the writes that needed the route have run out, unless a pin of the collaborator still needs it", async () => {
        await grantWrite();
        const restore = async (until: number) =>
            await harness.run(
                async (context: any) => await context.runMutation(restoreSharedPinRoutes, { createdAt: 1, threadId, until, userId: COLLABORATOR }),
            );

        // No pin: nothing needs the route once the writes have run out.
        await restore(Date.now() - 1);

        expect(await routesOfCollaborator()).toHaveLength(0);

        // A pin that survived: it still needs its route, so the restore goes on after the deadline.
        await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-survived", messageRole: "assistant", threadId } as never);
        await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } });

            for (const route of page) {
                await context.db.delete("sharedPinRoutes", route._id);
            }
        });

        await restore(Date.now() - 1);

        expect(await routesOfCollaborator()).toHaveLength(1);
    });

    it("follows the route to its owner's shard when the thread has left this one", async () => {
        await grantWrite();

        const pinId = await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-moved", messageRole: "assistant", threadId } as never);

        // The thread has left this shard: its pins and the thread row went with the merge, and the route names the new owner's shard.
        await harness.run(async (context: any) => await context.db.delete("threadPins", pinId as never));
        await harness.run(async (context: any) => await context.db.delete("threads", threadId));

        const scheduled: unknown[][] = [];

        await harness.run(async (context: any) => {
            const scheduler = {
                runAfter: async (...args: unknown[]) => {
                    scheduled.push(args);

                    return "job";
                },
            };

            await finishRouteCleanup({ ...context, scheduler }, threadId, COLLABORATOR);
        });

        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]?.[3]).toMatchObject({ shardKey: OWNER });
    });

    it("reschedules the merging owner's cleanup on the route's owner shard, so the pass runs where the thread goes", async () => {
        await grantWrite();

        const pinId = await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-owner-shard", messageRole: "assistant", threadId } as never);

        await harness.run(async (context: any) => await context.db.delete("threadPins", pinId as never));
        await harness.run(async (context: any) => await beginAccountMove(context, OWNER, "merging", Date.now()));

        const scheduled: unknown[][] = [];

        await harness.run(async (context: any) => {
            const scheduler = {
                runAfter: async (...args: unknown[]) => {
                    scheduled.push(args);

                    return "job";
                },
            };

            await finishRouteCleanup({ ...context, scheduler }, threadId, COLLABORATOR);
        });

        // One pass, on the route's owner shard: the merge re-points that route to the new owner, and the thread goes with it.
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]?.[2]).toStrictEqual({ threadId, userId: COLLABORATOR });
        expect(scheduled[0]?.[3]).toMatchObject({ shardKey: OWNER });
    });

    it("refuses a pin write after the second sweep and the fence release, and leaves no pin without a route", async () => {
        await grantWrite();
        await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-replay-before", messageRole: "assistant", threadId } as never);

        // Erasure begins: the account is marked, its owner shard is fenced, and the first sweep erases its pins there.
        await harness.run(async (context: any) => await beginAccountMove(context, COLLABORATOR, "erasing", Date.now()));
        await harness.run(async (context: any) => await context.db.insert("shardPinFences", { createdAt: Date.now(), userId: COLLABORATOR }));
        await harness.run(async (context: any) => await context.runMutation(eraseUserPinsOnThread, { threadId, userId: COLLABORATOR }));

        // The grace wait, then the second sweep, then the fences are lifted. The route is still there: the drain has not run.
        await harness.run(async (context: any) => await context.runMutation(eraseUserPinsOnThread, { threadId, userId: COLLABORATOR }));
        await harness.run(async (context: any) => await unfencePinsOnShard(context, COLLABORATOR));

        expect(await routesOfCollaborator()).toHaveLength(1);

        // The window the drain closes: a write of the erased account commits nothing, since the erasing marker is still live.
        await expect(
            as(COLLABORATOR).mutation(createPin as never, { messageId: "m-replay-window", messageRole: "assistant", threadId } as never),
        ).rejects.toThrow(MOVED_ACCOUNT_ERROR);

        // The route drain: the account's routes go, and no pin of the account is left.
        await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } });

            for (const route of page) {
                await context.db.delete("sharedPinRoutes", route._id);
            }
        });

        const pins = await harness.run(async (context: any) => {
            const rows: { userId: string }[] = await context.db.query("threadPins").collect();

            return rows.filter((row) => row.userId === COLLABORATOR);
        });

        expect(pins).toHaveLength(0);
        expect(await routesOfCollaborator()).toHaveLength(0);
    });
});

describe("the erasure workflow, replayed against the real pin mutations", () => {
    it("runs the workflow's own steps in order, and refuses a pin write committed before the route drain, leaving no pin without a route", async () => {
        await grantWrite();
        await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-workflow-before", messageRole: "assistant", threadId } as never);

        // The marker the workflow's first step sets: from here the collaborator's pin writes are refused.
        await harness.run(async (context: any) => await beginAccountMove(context, COLLABORATOR, "erasing", Date.now()));

        const steps: string[] = [];
        const window: { refused?: boolean } = {};

        const collaboratorRoutes = async () =>
            await harness.run(async (context: any) => {
                const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } });

                return page as { ownerId: string; threadId: string }[];
            });

        // The workflow's own steps; each real call below is what the step's internal function does, on the harness's one shard.
        const answer = async (ref: string) => {
            steps.push(ref);

            if (ref.endsWith(":erasePinsOnOwnerShards")) {
                const page = await collaboratorRoutes();
                const { owners } = await sweepRoutePage(
                    page,
                    {
                        eraseBatch: async (route) =>
                            await harness.run(
                                async (context: any) => await context.runMutation(eraseUserPinsOnThread, { threadId: route.threadId, userId: COLLABORATOR }),
                            ),
                        fence: async () => await harness.run(async (context: any) => await fencePinsOnShard(context, COLLABORATOR, Date.now())),
                    },
                    { budget: 39 },
                );

                return { cursor: null, hasMore: false, owners, resume: null, routes: page.length };
            }

            if (ref.endsWith(":releasePinFences")) {
                await harness.run(async (context: any) => await unfencePinsOnShard(context, COLLABORATOR));

                return null;
            }

            if (ref.endsWith(":deleteUserSharedPinRoutes")) {
                // Between the second sweep and the drain, the erased account writes a pin: the window this replay closes.
                try {
                    await as(COLLABORATOR).mutation(createPin as never, { messageId: "m-workflow-window", messageRole: "assistant", threadId } as never);
                    window.refused = false;
                } catch (error) {
                    window.refused = MOVED_ACCOUNT_ERROR.test(String((error as Error).message));
                }

                await harness.run(async (context: any) => {
                    const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: COLLABORATOR } });

                    for (const route of page) {
                        await context.db.delete("sharedPinRoutes", route._id);
                    }
                });

                return { hasMore: false };
            }

            return { cursor: null, hasMore: false, owners: [] };
        };

        const workflowRun = async (reference: unknown) => await answer((reference as { __lunoraRef: string }).__lunoraRef);

        await accountDeletionWorkflowConfig.handler({
            event: { instanceId: "instance-replay" },
            params: { requestId: "request-replay", userEmail: "user@example.com", userId: COLLABORATOR },
            run: workflowRun,
            step: {
                do: async (_name: string, callback: () => Promise<unknown>) => await callback(),
                sleep: async () => {},
            },
        } as never);

        // The real order: both sweeps, the fence release, then the drain. The window write fell between the second sweep and the drain.
        // Both sweeps ran: exactly two calls to the sweep, the second one the last before the release.
        const sweeps = steps.flatMap((ref, index) => (ref.endsWith(":erasePinsOnOwnerShards") ? [index] : []));
        const secondSweep = sweeps.at(-1) ?? -1;
        const drain = steps.indexOf(steps.find((ref) => ref.endsWith(":deleteUserSharedPinRoutes")) ?? "");
        const release = steps.indexOf(steps.find((ref) => ref.endsWith(":releasePinFences")) ?? "");

        expect(sweeps).toHaveLength(2);
        expect(secondSweep).toBeGreaterThan(-1);
        expect(release).toBeGreaterThan(secondSweep);
        expect(drain).toBeGreaterThan(release);

        expect(window.refused).toBe(true);

        const pins = await harness.run(async (context: any) => {
            const rows: { userId: string }[] = await context.db.query("threadPins").collect();

            return rows.filter((row) => row.userId === COLLABORATOR);
        });

        expect(pins).toHaveLength(0);
        expect(await collaboratorRoutes()).toHaveLength(0);
    });
});

describe("the owed restore reads its row, and each drain stays inside the statement budget", () => {
    const MERGED = "user-merged";
    const ELSEWHERE = "user-elsewhere";

    const insertOwed = async (overrides: { ownerId?: string; until?: number; userId?: string } = {}) =>
        (await harness.run(
            async (context: any) =>
                await context.db.insert("pendingPinRestores", {
                    dispatchedAt: 1,
                    ownerId: OWNER,
                    routeCreatedAt: 1,
                    threadId,
                    until: Date.now() + 60_000,
                    userId: COLLABORATOR,
                    ...overrides,
                }),
        )) as string;

    const restore = async (args: { owedId?: string; until: number; userId: string }) =>
        await harness.run(async (context: any) => await context.runMutation(restoreSharedPinRoutes, { createdAt: 1, threadId, ...args }));

    const routesFor = async (userId: string) =>
        await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ consistency: "primary", where: { userId } });

            return (page as { ownerId: string }[]).map((route) => route.ownerId);
        });

    const owedFor = async (userId: string) =>
        await harness.run(async (context: any) => {
            const { page } = await context.db.pendingPinRestores.findMany({ consistency: "primary", where: { userId } });

            return (page as { _id: string }[]).map((row) => row._id);
        });

    it("a restore whose owed row is gone writes nothing, and does not fall back to the message's account", async () => {
        const owedId = await insertOwed();

        await harness.run(async (context: any) => await context.db.delete("pendingPinRestores", owedId as never));
        await restore({ owedId, until: Date.now() + 60_000, userId: COLLABORATOR });

        expect(await routesFor(COLLABORATOR)).toStrictEqual([]);
    });

    it("takes the account from the row, so a row a merge re-pointed restores the route for the new account", async () => {
        // The message still names the old guest; the merge has re-pointed the row to the account it converted to.
        const owedId = await insertOwed({ userId: MERGED });

        await restore({ owedId, until: Date.now() + 60_000, userId: COLLABORATOR });

        expect(await routesFor(MERGED)).toStrictEqual([OWNER]);
        expect(await routesFor(COLLABORATOR)).toStrictEqual([]);
        expect(await owedFor(MERGED)).toStrictEqual([]);
    });

    it("leaves a row that names another owner for the cron, which sends it to the owner it names", async () => {
        const owedId = await insertOwed({ ownerId: ELSEWHERE });

        await restore({ owedId, until: Date.now() + 60_000, userId: COLLABORATOR });

        expect(await routesFor(COLLABORATOR)).toStrictEqual([]);
        expect(await owedFor(COLLABORATOR)).toStrictEqual([owedId]);
    });

    it("after its deadline, keeps the route while an import into the account is in flight, before its pin is visible", async () => {
        const owedId = await insertOwed({ until: Date.now() - 1, userId: MERGED });

        await harness.run(async (context: any) => await context.db.insert("accountMoves", { createdAt: Date.now(), kind: "importing", userId: MERGED }));
        await restore({ owedId, until: Date.now() - 1, userId: COLLABORATOR });

        expect(await routesFor(MERGED)).toStrictEqual([OWNER]);
        expect(await owedFor(MERGED)).toStrictEqual([]);
    });

    it("after its deadline with no pin and no import, settles the row and adds no route", async () => {
        const owedId = await insertOwed({ until: Date.now() - 1, userId: MERGED });

        await restore({ owedId, until: Date.now() - 1, userId: COLLABORATOR });

        expect(await routesFor(MERGED)).toStrictEqual([]);
        expect(await owedFor(MERGED)).toStrictEqual([]);
    });

    it("finds the owner's route past the first page of the collaborator's routes, so no duplicate is written", async () => {
        // More routes than one page holds for this collaborator and thread; the owner's route is the last one written.
        await harness.run(async (context: any) => {
            for (let index = 0; index < 100; index += 1) {
                await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: `user-other-${index}`, threadId, userId: COLLABORATOR });
            }

            await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: OWNER, threadId, userId: COLLABORATOR });
        });
        const owedId = await insertOwed();

        await restore({ owedId, until: Date.now() + 60_000, userId: COLLABORATOR });

        const owners = await routesFor(COLLABORATOR);

        const ownerRoutes = owners.filter((ownerId) => ownerId === OWNER);

        expect(ownerRoutes).toHaveLength(1);
    });

    it("keeps each drain's worst case under the Worker's 50-statement budget", () => {
        expect(ERASE_DRAIN_WORST).toBeLessThan(50);
        expect(MATERIALIZE_WORST).toBeLessThan(50);
        expect(PENDING_RESTORE_WORST).toBeLessThan(50);
    });

    it("the erasure drain clears more rows than one call takes, one bounded call at a time", async () => {
        const routes = ERASE_DRAIN_ROWS * 2 + 5;

        await harness.run(async (context: any) => {
            for (let index = 0; index < routes; index += 1) {
                await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: `user-drain-${index}`, threadId, userId: COLLABORATOR });
            }

            for (let index = 0; index < 4; index += 1) {
                await context.db.insert("pendingPinRestores", {
                    dispatchedAt: 1,
                    ownerId: COLLABORATOR,
                    routeCreatedAt: 1,
                    threadId,
                    until: 1,
                    userId: `user-owed-${index}`,
                });
            }
        });

        let calls = 0;
        let hasMore = true;

        while (hasMore && calls < 50) {
            const result = await harness.run(async (context: any) => await eraseSharedPinRoutesBatch(context, COLLABORATOR));

            hasMore = result.hasMore;
            calls += 1;
        }

        expect(hasMore).toBe(false);
        expect(calls).toBeGreaterThan(1);
        expect(await routesFor(COLLABORATOR)).toStrictEqual([]);
    });

    it("the materialize drain settles every owed row across calls, each call bounded", async () => {
        // More rows than one materialize call takes, so the drain has to run again.
        const rows = 20;

        for (let index = 0; index < rows; index += 1) {
            await insertOwed({ ownerId: `user-materialize-${index}`, userId: COLLABORATOR });
        }

        let hasMore = true;
        let calls = 0;

        while (hasMore && calls < 50) {
            const result = await harness.run(async (context: any) => await materializePendingPinRoutesBatch(context, COLLABORATOR));

            hasMore = result.hasMore;
            calls += 1;
        }

        expect(hasMore).toBe(false);
        expect(await owedFor(COLLABORATOR)).toStrictEqual([]);
        expect(await routesFor(COLLABORATOR)).toHaveLength(rows);
    });
});
