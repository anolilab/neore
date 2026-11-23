/**
 * Saving the run webhook, end to end through the real session check: the save
 * returns the secret once, the read shows the saved settings, and a second save
 * updates them without another secret.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { ROOT_SHARD_KEY, runInShard } from "../lib/shard-context";
import schema from "../schema";
import { getRunWebhook, rotateRunWebhookSecret, saveRunWebhook } from "./functions";
import { collectRunWebhookForExport, deleteUserRunWebhooks } from "./gdpr";

const SECRET_PREFIX = /^whsec_/u;
const OWN_ACCOUNT_ONLY = /own account only/u;
const URL = "https://hooks.example.com/neore";

const signedIn = async (harness: ReturnType<typeof lunoraTest>) =>
    (await harness.run(async (context: any) => {
        const user = await context.db.insert("user", {
            createdAt: 0,
            email: "settings@example.com",
            emailVerified: true,
            name: "Settings",
            updatedAt: 0,
        });
        const session = await context.db.insert("session", {
            createdAt: 0,
            expiresAt: Date.now() + 86_400_000,
            token: "settings-session-token",
            updatedAt: 0,
            userId: user,
        });

        return { sessionId: session, userId: user };
    })) as { sessionId: string; userId: string };

describe("saving the run webhook", () => {
    it("creates the webhook, returns its secret once, and reads back the saved settings", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);
            const as = harness.withIdentity(identity as never);

            const created = (await as.mutation(saveRunWebhook as never, { enabled: true, url: "https://hooks.example.com/neore" } as never)) as {
                secret?: string;
            };

            expect(created.secret).toMatch(SECRET_PREFIX);
            expect(await as.query(getRunWebhook as never, {} as never)).toMatchObject({
                configured: true,
                enabled: true,
                url: "https://hooks.example.com/neore",
            });

            const updated = (await as.mutation(saveRunWebhook as never, { enabled: false, url: "https://hooks.example.com/other" } as never)) as {
                secret?: string;
            };

            expect(updated.secret).toBeUndefined();
            expect(await as.query(getRunWebhook as never, {} as never)).toMatchObject({
                configured: true,
                enabled: false,
                url: "https://hooks.example.com/other",
            });
        } finally {
            harness.close();
        }
    });
});

describe("the run webhook stays on its owner's own shard", () => {
    const exported = async (harness: ReturnType<typeof lunoraTest>, userId: string) =>
        ((await harness.run(async (ctx: any) => await ctx.runQuery(collectRunWebhookForExport, { userId }))) as { runWebhooks: { url: string }[] }).runWebhooks;

    it("a save on the caller's own shard is in their GDPR export and gone after their account deletion", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);
            const as = harness.withIdentity(identity as never);

            await runInShard(identity.userId, async () => {
                await as.mutation(saveRunWebhook as never, { enabled: true, url: URL } as never);
                // GDPR export, erasure and the account merge run on the user's own shard (`gdpr/workflows/*`, `lib/account-merge.ts`).
                expect(await exported(harness, identity.userId)).toMatchObject([{ enabled: true, url: URL }]);
                expect(await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserRunWebhooks, { userId: identity.userId }))).toStrictEqual({
                    hasMore: false,
                });
                expect(await exported(harness, identity.userId)).toStrictEqual([]);
                expect(await as.query(getRunWebhook as never, {} as never)).toStrictEqual({ configured: false, enabled: false });
            });
        } finally {
            harness.close();
        }
    });

    it("refuses a save or a rotation on a shared thread owner's shard, where the row would escape the caller's export and erasure", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);
            const as = harness.withIdentity(identity as never);

            await runInShard("user-owner-of-a-shared-thread", async () => {
                await expect(as.mutation(saveRunWebhook as never, { enabled: true, url: URL } as never)).rejects.toThrow(OWN_ACCOUNT_ONLY);
                await expect(as.mutation(rotateRunWebhookSecret as never, {} as never)).rejects.toThrow(OWN_ACCOUNT_ONLY);
            });
            expect(await exported(harness, identity.userId)).toStrictEqual([]);
        } finally {
            harness.close();
        }
    });

    it("refuses a save on the root shard and reads nothing there, even with a row saved on the caller's own", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);
            const as = harness.withIdentity(identity as never);

            await runInShard(identity.userId, async () => {
                await as.mutation(saveRunWebhook as never, { enabled: true, url: URL } as never);
            });
            await runInShard(ROOT_SHARD_KEY, async () => {
                await expect(as.mutation(saveRunWebhook as never, { enabled: false, url: URL } as never)).rejects.toThrow(OWN_ACCOUNT_ONLY);
                expect(await as.query(getRunWebhook as never, {} as never)).toStrictEqual({ configured: false, enabled: false });
            });
            expect(await exported(harness, identity.userId)).toMatchObject([{ enabled: true, url: URL }]);
        } finally {
            harness.close();
        }
    });
});
