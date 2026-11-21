/**
 * Pins hold a whole message or one image of a reply. A message pin is stored as every pin before images was (no kind),
 * an image pin names the part it pins, and a pin whose kind and part index do not fit together is refused.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { createPin, getThreadPins, isPinShapeValid } from "./functions";

const OWNER = "user-owner";
const SHAPE_ERROR = /An image pin names the part it pins/;

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
        [{ kind: "image" as const, partIndex: 0 }, true],
        [{ kind: "image" as const }, false],
        [{ partIndex: 2 }, false],
        [{ kind: "message" as const, partIndex: 2 }, false],
    ])("%o is %s", (shape, expected) => {
        expect(isPinShapeValid(shape)).toBe(expected);
    });
});

describe("image pins", () => {
    it("stores an image pin with its part index and returns it", async () => {
        await as(OWNER).mutation(
            createPin as never,
            {
                kind: "image",
                messageId: "m-1",
                messageRole: "assistant",
                partIndex: 2,
                selectedText: "A fox logo, flat colours",
                threadId,
            } as never,
        );

        const [pin] = await pinsOf();

        expect(pin).toMatchObject({ kind: "image", messageId: "m-1", partIndex: 2, selectedText: "A fox logo, flat colours" });
    });

    it("stores a message pin as before, with no kind and no part index", async () => {
        await as(OWNER).mutation(createPin as never, { messageId: "m-2", messageRole: "assistant", threadId } as never);

        const [pin] = await pinsOf();

        expect(pin).toMatchObject({ messageId: "m-2" });
        expect(pin).not.toHaveProperty("kind");
        expect(pin).not.toHaveProperty("partIndex");
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
        await expect(as(OWNER).mutation(createPin as never, { messageId: "m-1", messageRole: "assistant", partIndex: 1, threadId } as never)).rejects.toThrow(
            SHAPE_ERROR,
        );
        expect(await pinsOf()).toHaveLength(0);
    });

    it("refuses a part index that is negative or not whole", async () => {
        for (const partIndex of [-1, 1.5]) {
            await expect(
                as(OWNER).mutation(createPin as never, { kind: "image", messageId: "m-1", messageRole: "assistant", partIndex, threadId } as never),
            ).rejects.toThrow();
        }

        expect(await pinsOf()).toHaveLength(0);
    });
});
