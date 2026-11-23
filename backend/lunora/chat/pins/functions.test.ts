/**
 * Pins hold a whole message, one image of a reply, or a finished visual or plan (a document) of the thread. A message pin
 * is stored as every pin before images was (no kind), an image pin names the part it pins, and a pin whose kind and part
 * index do not fit together is refused. A document pin is one per document and reads its title from the document.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../../_generated/dataModel";
import { resolveThreadReadAccess } from "../../agent/thread-read-access";
import { BATCH } from "../../gdpr/batch";
import schema from "../../schema";
import {
    createDocumentPin,
    createPin,
    deletePin,
    eraseUserPinsOnThread,
    getThreadPins,
    isPinShapeValid,
    reassignUserPinsOnThread,
    withSharedPinRoute,
} from "./functions";

const OWNER = "user-owner";
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

const pinsOf = async () => (await as(OWNER).query(getThreadPins as never, { threadId } as never)) as Record<string, unknown>[];

beforeEach(async () => {
    harness = lunoraTest(schema as never);

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

        await expect(as("user-stranger").mutation(createDocumentPin as never, { documentId, threadId } as never)).rejects.toThrow(NO_ACCESS_ERROR);
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
                await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: "user-collaborator" }),
        );

        const pinId = await as("user-collaborator").mutation(createPin as never, { messageId: "m-12", messageRole: "assistant", threadId } as never);

        await harness.run(
            async (context: any) => await context.db.insert("sharedPinRoutes", { createdAt: 2, ownerId: OWNER, threadId, userId: "user-collaborator" }),
        );

        await as("user-collaborator").mutation(deletePin as never, { pinId, threadId } as never);

        const routes = await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: "user-collaborator" } });

            return page as unknown[];
        });

        expect(routes).toHaveLength(0);
    });

    it("drops the route once a collaborator deletes their last pin on the thread", async () => {
        await harness.run(
            async (context: any) =>
                await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: "user-collaborator" }),
        );

        const pinId = await as("user-collaborator").mutation(createPin as never, { messageId: "m-11", messageRole: "assistant", threadId } as never);

        await as("user-collaborator").mutation(deletePin as never, { pinId, threadId } as never);

        const routes = await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: "user-collaborator" } });

            return page as unknown[];
        });

        expect(routes).toHaveLength(0);
    });

    it("refuses a message pin from a caller with no grant on an unlocked thread", async () => {
        await expect(as("user-stranger").mutation(createPin as never, { messageId: "m-7", messageRole: "assistant", threadId } as never)).rejects.toThrow(
            NO_ACCESS_ERROR,
        );
        const strangerPins = await harness.run(async (context: any) => {
            const { page } = await context.db.threadPins.findMany({ where: { userId: "user-stranger" } });

            return page as unknown[];
        });

        expect(strangerPins).toHaveLength(0);
    });

    it("records the owner, so the collaborator's export finds the pin after the grant is revoked", async () => {
        await harness.run(
            async (context: any) =>
                await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: "user-collaborator" }),
        );

        await as("user-collaborator").mutation(createPin as never, { messageId: "m-9", messageRole: "assistant", threadId } as never);

        const routes = await harness.run(async (context: any) => {
            const { page } = await context.db.sharedPinRoutes.findMany({ where: { userId: "user-collaborator" } });

            return page as unknown[];
        });

        expect(routes).toMatchObject([{ ownerId: OWNER, threadId, userId: "user-collaborator" }]);
    });
});

describe("a collaborator's pins on the owner's shard", () => {
    it("erases one user's pins on one thread and leaves the owner's and every other thread's", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadPins", { createdAt: 1, messageRole: "assistant", threadId, updatedAt: 1, userId: "user-collaborator" });
            await context.db.insert("threadPins", { createdAt: 1, messageRole: "assistant", threadId, updatedAt: 1, userId: OWNER });
        });

        await harness.run(async (context: any) => await context.runMutation(eraseUserPinsOnThread, { threadId, userId: "user-collaborator" }));

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
});

describe("listing a thread's pins after a grant is revoked", () => {
    const COLLABORATOR = "user-collaborator";

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
            await context.db.insert("threadPins", { createdAt: 1, messageRole: "assistant", threadId, updatedAt: 1, userId: "user-collaborator" });
            await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: OWNER, threadId, userId: "user-collaborator" });
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
                await context.db.insert("threadPins", { createdAt: 1, messageRole: "assistant", threadId, updatedAt: 1, userId: "user-collaborator" });
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
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: "user-collaborator" });
            await context.db.insert("accountMoves", { createdAt: 1, kind: "erasing", userId: "user-collaborator" });
        });

        await expect(as("user-collaborator").mutation(createPin as never, { messageId: "m-20", messageRole: "assistant", threadId } as never)).rejects.toThrow(
            MOVED_ACCOUNT_ERROR,
        );

        await expect(as(OWNER).mutation(createPin as never, { messageId: "m-21", messageRole: "assistant", threadId } as never)).resolves.toBeDefined();
    });
});

describe("a failed pin write leaves its shared route", () => {
    it("keeps the route, since a concurrent writer may be relying on it, and writes no pin", async () => {
        // The failure is caught inside the run: an uncaught error would roll the whole run back, route included, and prove nothing.
        const message = await harness.run(async (context: any) => {
            try {
                await withSharedPinRoute(context, threadId, "user-collaborator", 1, async () => {
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

describe("a pin write renews the writer's lease before its move check", () => {
    it("leaves the owner's lease in place after a pin is written", async () => {
        await as(OWNER).mutation(createPin as never, { messageId: "m-lease", messageRole: "assistant", threadId } as never);

        const leases = await harness.run(async (context: any) => await context.db.pinWriteLeases.findMany({ where: { userId: OWNER } }));

        expect(leases.page).toHaveLength(1);
    });
});

describe("refused pin writes renew no lease", () => {
    it("leaves no lease behind after repeated refused attempts from a marked account", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: "user-collaborator" });
            await context.db.insert("accountMoves", { createdAt: 1, kind: "erasing", userId: "user-collaborator" });
        });

        for (let attempt = 0; attempt < 3; attempt += 1) {
            await expect(
                as("user-collaborator").mutation(
                    createPin as never,
                    { messageId: `m-refused-${String(attempt)}`, messageRole: "assistant", threadId } as never,
                ),
            ).rejects.toThrow(MOVED_ACCOUNT_ERROR);
        }

        const leases = await harness.run(async (context: any) => await context.db.pinWriteLeases.findMany({ where: { userId: "user-collaborator" } }));

        expect(leases.page).toHaveLength(0);
    });
});

describe("a fenced owner shard refuses a pin write of the account", () => {
    it("refuses the write in its own transaction, while the fence is on the shard", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: "user-collaborator" });
            await context.db.insert("shardPinFences", { createdAt: 1, userId: "user-collaborator" });
        });

        await expect(
            as("user-collaborator").mutation(createPin as never, { messageId: "m-fenced", messageRole: "assistant", threadId } as never),
        ).rejects.toThrow(MOVED_ACCOUNT_ERROR);
    });
});
