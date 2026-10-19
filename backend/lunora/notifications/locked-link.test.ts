import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { LOCKED_THREAD_TITLE } from "../lib/thread-lock";
import { linksToLockedThread, redactForLockedThread } from "./locked-link";
import { toRedactedNotificationViews } from "./functions";

let harness: ReturnType<typeof lunoraTest>;
let lockedId: string;
let openId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    lockedId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { lockedAt: 1, status: "active", title: "Salary", userId: "u" }));
    openId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Open", userId: "u" }));
});

const isLocked = (link: string | undefined) => harness.run(async (ctx: any) => await linksToLockedThread(ctx.db, link));

describe("locked chat notifications", () => {
    it("recognises a link to a locked chat only", async () => {
        expect(await isLocked(`/chat/${lockedId}`)).toBe(true);
        expect(await isLocked(`/chat/${openId}`)).toBe(false);
        expect(await isLocked("/dashboard")).toBe(false);
        expect(await isLocked(undefined)).toBe(false);
    });

    it("replaces the subject and drops the body", () => {
        expect(redactForLockedThread({ body: "reply text", title: "Salary", type: "x" })).toEqual({ body: undefined, title: LOCKED_THREAD_TITLE, type: "x" });
    });

    it("redacts every notification row that links to a locked chat, on any surface", async () => {
        const rows = await harness.run(async (ctx: any) => {
            const base = { createdAt: 1, type: "task", userId: "u" };
            const locked = await ctx.db.insert("notifications", { ...base, body: "reply text", link: `/chat/${lockedId}`, title: "Salary" });
            const open = await ctx.db.insert("notifications", { ...base, body: "fine", link: `/chat/${openId}`, title: "Open" });

            return [await ctx.db.get(locked), await ctx.db.get(open)];
        });
        const views = await harness.run(async (ctx: any) => await toRedactedNotificationViews(ctx.db, rows));

        expect(views[0]).toMatchObject({ title: LOCKED_THREAD_TITLE });
        expect(views[0]?.body).toBeUndefined();
        expect(views[1]).toMatchObject({ body: "fine", title: "Open" });
    });
});
