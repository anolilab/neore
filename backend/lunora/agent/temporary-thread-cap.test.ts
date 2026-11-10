/**
 * A temporary chat started in an organization is not filed under it (it stays off that organization's list), but keeps
 * that organization for its permission cap (`threads.capOrganizationId`, read by `readRunPermissionCap`).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createTemporaryThread } from "./threads";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const thread = async (): Promise<Record<string, unknown>> => await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId));

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: "owner" }))) as string;
});

afterEach(() => {
    harness.close();
});

describe("createTemporaryThread", () => {
    it("keeps the organization a chat was started in for its cap, without filing the chat under it", async () => {
        await harness.run(async (ctx: any) => await ctx.runMutation(createTemporaryThread, { capOrganizationId: "org-a", expiresAt: 1, threadId }));

        expect(await thread()).toMatchObject({ capOrganizationId: "org-a", isTemporary: true });
        expect(await thread()).not.toHaveProperty("organizationId");
    });

    it("records no cap organization for a chat started in the personal space", async () => {
        await harness.run(async (ctx: any) => await ctx.runMutation(createTemporaryThread, { expiresAt: 1, threadId }));

        expect(await thread()).toMatchObject({ isTemporary: true });
        expect(await thread()).not.toHaveProperty("capOrganizationId");
    });
});
