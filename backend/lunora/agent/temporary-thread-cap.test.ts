/**
 * A temporary chat started in an organization is not filed under it (it stays off that organization's list), but keeps
 * that organization for its permission cap (`threads.capOrganizationId`, read by `readRunPermissionCap`).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { convertTemporaryToPermanent, createTemporaryThread, threadForViewer } from "./threads";

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

describe("convertTemporaryToPermanent", () => {
    it("files a kept chat under the organization it was started in, so it keeps that organization's cap", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: "owner" }));
        await harness.run(async (ctx: any) => await ctx.runMutation(createTemporaryThread, { capOrganizationId: "org-a", expiresAt: 1, threadId }));
        await harness.run(async (ctx: any) => await ctx.runMutation(convertTemporaryToPermanent, { threadId }));

        expect(await thread()).toMatchObject({ organizationId: "org-a" });
        expect(await thread()).not.toHaveProperty("capOrganizationId");
        expect(await thread()).not.toHaveProperty("isTemporary");
    });

    it("keeps a chat whose owner left its organization in their personal list, still capped by that organization", async () => {
        await harness.run(async (ctx: any) => await ctx.runMutation(createTemporaryThread, { capOrganizationId: "org-a", expiresAt: 1, threadId }));
        await harness.run(async (ctx: any) => await ctx.runMutation(convertTemporaryToPermanent, { threadId }));

        expect(await thread()).toMatchObject({ capOrganizationId: "org-a" });
        expect(await thread()).not.toHaveProperty("organizationId");
        expect(await thread()).not.toHaveProperty("isTemporary");
    });

    it("leaves a kept chat from the personal space unfiled", async () => {
        await harness.run(async (ctx: any) => await ctx.runMutation(createTemporaryThread, { expiresAt: 1, threadId }));
        await harness.run(async (ctx: any) => await ctx.runMutation(convertTemporaryToPermanent, { threadId }));

        expect(await thread()).not.toHaveProperty("organizationId");
        expect(await thread()).not.toHaveProperty("isTemporary");
    });
});

describe("threadForViewer", () => {
    it("shows the organization a temporary chat was started in to its owner only", async () => {
        await harness.run(async (ctx: any) => await ctx.runMutation(createTemporaryThread, { capOrganizationId: "org-a", expiresAt: 1, threadId }));
        const row = (await thread()) as never;

        expect(threadForViewer(row, "owner")).toMatchObject({ capOrganizationId: "org-a" });
        expect(threadForViewer(row, "grantee")).not.toHaveProperty("capOrganizationId");
    });
});
