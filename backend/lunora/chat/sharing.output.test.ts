/**
 * `checkThreadAccessWithData` returns the thread row, and `.output()` rejects a
 * key it does not declare. Its validator was a hand-listed subset of the
 * columns, so every thread carrying one it forgot — a categorised thread, a
 * branched one (`activeLeafMessageId`), a group chat, a tagged one — failed the
 * share toggle, thread updates and follow-up suggestions with "Response did not
 * match the declared output schema".
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { checkThreadAccessWithData } from "./sharing";

const OWNER = "owner";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("checkThreadAccessWithData output", () => {
    it("accepts a thread carrying every optional column the app writes", async () => {
        const threadId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threads", {
                    activeLeafMessageId: "m1",
                    category: "coding",
                    groupChat: { mode: "round-robin", participants: [{ addedAt: 1, skillId: "s1" }] },
                    lastCompressionStartedAt: 1,
                    source: "telegram",
                    status: "active",
                    tagIds: ["tag-1"],
                    title: "t",
                    userId: OWNER,
                }),
        );

        const result: any = await harness.query(
            async (context: any) => await context.runQuery(checkThreadAccessWithData, { requiredPermission: "admin", threadId, userId: OWNER }),
        );

        expect(result).toMatchObject({
            hasAccess: true,
            permission: "admin",
            thread: { _id: threadId, activeLeafMessageId: "m1", category: "coding", groupChat: { mode: "round-robin" }, tagIds: ["tag-1"] },
        });
    });
});
