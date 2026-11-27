/**
 * The owner's approved callback hosts, through the real session check: approving, listing, and removing a host, the refusal of a
 * name that is not a host, and the idempotent add and remove.
 */
/* eslint-disable sonarjs/no-hardcoded-ip -- test data: an address the host rule must refuse, never dialled */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { beginAccountMove } from "../lib/account-moves";
import { cascadeDeleteUser } from "./hooks";
import schema from "../schema";
import { addEventWebhookHost, listEventWebhookHosts, removeEventWebhookHost } from "./event-webhook-hosts";

const signedIn = async (harness: ReturnType<typeof lunoraTest>) =>
    (await harness.run(async (context: any) => {
        const user = await context.db.insert("user", {
            createdAt: 0,
            email: "hosts@example.com",
            emailVerified: true,
            name: "Hosts",
            updatedAt: 0,
        });

        await context.db.insert("session", {
            createdAt: 0,
            expiresAt: Date.now() + 86_400_000,
            token: "hosts-session-token",
            updatedAt: 0,
            userId: user,
        });

        return { sessionId: "hosts-session", userId: user };
    })) as { sessionId: string; userId: string };

describe("the owner's approved callback hosts", () => {
    it("erases the owner's approved hosts with the account's cascade delete, as the admin cleanup runs it", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);
            const as = harness.withIdentity(identity as never);

            await as.mutation(addEventWebhookHost as never, { host: "hooks.example.com" } as never);
            await harness.run(async (context: any) => await context.runMutation(cascadeDeleteUser, { userId: identity.userId }));

            const left = await harness.run(async (context: any) => await context.db.eventWebhookHosts.findMany({ where: { userId: identity.userId } }));

            expect(left.page).toStrictEqual([]);
        } finally {
            harness.close();
        }
    });

    it("refuses a host approved once the account's erasure has begun, and stores nothing", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);
            const as = harness.withIdentity(identity as never);

            await harness.run(async (context: any) => await beginAccountMove(context, identity.userId, "erasing", Date.now()));

            await expect(as.mutation(addEventWebhookHost as never, { host: "hooks.example.com" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });

            const left = await harness.run(async (context: any) => await context.db.eventWebhookHosts.findMany({ where: { userId: identity.userId } }));

            expect(left.page).toStrictEqual([]);
        } finally {
            harness.close();
        }
    });

    it("erases the owner's Events subscriptions, with their callback secrets, in the cascade delete", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);

            await harness.run(async (context: any) => {
                await context.db.insert("eventWebhookSubscriptions", {
                    argumentsKey: "{}",
                    createdAt: 0,
                    expiresAt: Date.now() + 86_400_000,
                    id: "sub_1",
                    keyHash: "hash-1",
                    minTimestamp: 0,
                    name: "run.completed",
                    principal: "key-1",
                    scanSeq: 0,
                    secretCiphertext: "ciphertext",
                    updatedAt: 0,
                    url: "https://hooks.example.com/neore",
                    userId: identity.userId,
                });
            });
            await harness.run(async (context: any) => await context.runMutation(cascadeDeleteUser, { userId: identity.userId }));

            const left = await harness.run(async (context: any) => await context.db.eventWebhookSubscriptions.findMany({ where: { userId: identity.userId } }));

            expect(left.page).toStrictEqual([]);
        } finally {
            harness.close();
        }
    });

    it("erases every host of the owner, past one page of rows, in the account's cascade delete", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);

            await harness.run(async (context: any) => {
                for (let index = 0; index < 60; index += 1) {
                    await context.db.insert("eventWebhookHosts", { createdAt: 0, host: `host-${index}.example.com`, userId: identity.userId });
                }
            });
            await harness.run(async (context: any) => await context.runMutation(cascadeDeleteUser, { userId: identity.userId }));

            const left = await harness.run(async (context: any) => await context.db.eventWebhookHosts.findMany({ where: { userId: identity.userId } }));

            expect(left.page).toStrictEqual([]);
        } finally {
            harness.close();
        }
    });

    it("removes a host held in more rows than the add cap, so none of them is left approved", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);
            const as = harness.withIdentity(identity as never);

            await harness.run(async (context: any) => {
                for (let index = 0; index < 51; index += 1) {
                    await context.db.insert("eventWebhookHosts", { createdAt: 0, host: "hooks.example.com", userId: identity.userId });
                }
            });

            expect(await as.mutation(removeEventWebhookHost as never, { host: "hooks.example.com" } as never)).toStrictEqual({ removed: true });
            expect(await as.query(listEventWebhookHosts as never, {} as never)).toStrictEqual({ hosts: [] });
        } finally {
            harness.close();
        }
    });

    it("counts distinct host names against the add cap, so duplicate rows from a merge do not refuse an eligible host", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);
            const as = harness.withIdentity(identity as never);

            await harness.run(async (context: any) => {
                for (let index = 0; index < 50; index += 1) {
                    await context.db.insert("eventWebhookHosts", { createdAt: 0, host: `host-${index % 25}.example.com`, userId: identity.userId });
                }
            });

            expect(await as.mutation(addEventWebhookHost as never, { host: "fresh.example.com" } as never)).toStrictEqual({ host: "fresh.example.com" });
        } finally {
            harness.close();
        }
    });

    it("lists every host a merge left the owner with, past the add cap", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);
            const as = harness.withIdentity(identity as never);

            await harness.run(async (context: any) => {
                for (let index = 0; index < 60; index += 1) {
                    await context.db.insert("eventWebhookHosts", { createdAt: 0, host: `host-${index}.example.com`, userId: identity.userId });
                }
            });

            const listed = (await as.query(listEventWebhookHosts as never, {} as never)) as { hosts: unknown[] };

            expect(listed.hosts).toHaveLength(60);
        } finally {
            harness.close();
        }
    });

    it("removes a host held in two rows, as a merge can leave one, so it is no longer approved", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const identity = await signedIn(harness);
            const as = harness.withIdentity(identity as never);

            await harness.run(async (context: any) => {
                for (let index = 0; index < 2; index += 1) {
                    await context.db.insert("eventWebhookHosts", { createdAt: 0, host: "hooks.example.com", userId: identity.userId });
                }
            });

            expect(await as.mutation(removeEventWebhookHost as never, { host: "hooks.example.com" } as never)).toStrictEqual({ removed: true });
            expect(await as.query(listEventWebhookHosts as never, {} as never)).toStrictEqual({ hosts: [] });
        } finally {
            harness.close();
        }
    });

    it("approves a host, lists it, approves it again without a second row, and removes it", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const as = harness.withIdentity((await signedIn(harness)) as never);

            expect(await as.mutation(addEventWebhookHost as never, { host: "Hooks.Example.com" } as never)).toStrictEqual({ host: "hooks.example.com" });
            expect(await as.mutation(addEventWebhookHost as never, { host: "hooks.example.com" } as never)).toStrictEqual({ host: "hooks.example.com" });

            const listed = (await as.query(listEventWebhookHosts as never, {} as never)) as { hosts: { host: string }[] };

            expect(listed.hosts.map((row) => row.host)).toStrictEqual(["hooks.example.com"]);
            expect(await as.mutation(removeEventWebhookHost as never, { host: "hooks.example.com" } as never)).toStrictEqual({ removed: true });
            expect(await as.mutation(removeEventWebhookHost as never, { host: "hooks.example.com" } as never)).toStrictEqual({ removed: false });
            expect(await as.query(listEventWebhookHosts as never, {} as never)).toStrictEqual({ hosts: [] });
        } finally {
            harness.close();
        }
    });

    it("refuses a value that is not a host name: an address, a single label, or a URL", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const as = harness.withIdentity((await signedIn(harness)) as never);

            for (const host of ["10.0.0.1", "localhost", "https://hooks.example.com"]) {
                await expect(as.mutation(addEventWebhookHost as never, { host } as never)).rejects.toThrow();
            }
        } finally {
            harness.close();
        }
    });
});
