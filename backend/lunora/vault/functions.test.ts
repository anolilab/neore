/**
 * `deleteAttachments` deletes audited `files` rows one at a time. In parallel the
 * audit trigger nests past its recursion limit on more than about a dozen rows and
 * the whole delete rolls back.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { deleteAttachments } from "./functions";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

const OWNER = "user-owner";
const ROWS = 60;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("deleteAttachments", () => {
    it(`deletes ${String(ROWS)} attachments in one call`, async () => {
        const ids = await harness.run(async (ctx: any) => {
            const inserted: string[] = [];

            for (let index = 0; index < ROWS; index += 1) {
                inserted.push(await ctx.db.insert("files", { chatId: "chat-1", name: `f${String(index)}`, size: 1, type: "text/plain", userId: OWNER }));
            }

            return inserted;
        });

        await harness.withIdentity({ userId: OWNER } as never).mutation(deleteAttachments as never, { attachmentIds: ids } as never);

        const remaining = await harness.run(async (ctx: any) => await Promise.all(ids.map(async (id) => await ctx.db.get(id))));

        expect(remaining.filter(Boolean)).toHaveLength(0);
    });
});
