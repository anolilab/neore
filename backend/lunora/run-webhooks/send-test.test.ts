/**
 * `sendRunWebhookTest` is an `authAction`. The session check is NOT mocked here, so this
 * exercises the real middleware: a signed-in user with no saved URL must reach the handler and
 * get its "save a URL first" refusal, not an authentication error.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { encryptKey } from "../lib/encryption";
import { runInShard } from "../lib/shard-context";
import schema from "../schema";
import { sendRunWebhookTest } from "./functions";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "run_webhooks_functions", await import("./functions"));
});

describe("sendRunWebhookTest", () => {
    it("reaches its handler for a signed-in user, which then refuses because no URL is saved", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const { sessionId, userId } = (await harness.run(async (context: any) => {
                const user = await context.db.insert("user", {
                    createdAt: 0,
                    email: "signed-in@example.com",
                    emailVerified: true,
                    name: "Signed In",
                    updatedAt: 0,
                });
                const session = await context.db.insert("session", {
                    createdAt: 0,
                    expiresAt: Date.now() + 86_400_000,
                    token: "session-token-for-test",
                    updatedAt: 0,
                    userId: user,
                });

                return { sessionId: session, userId: user };
            })) as { sessionId: string; userId: string };

            await expect(harness.withIdentity({ sessionId, userId } as never).action(sendRunWebhookTest as never, {} as never)).rejects.toMatchObject({
                code: "NOT_FOUND",
                message: "Save a webhook URL first.",
            });
        } finally {
            harness.close();
        }
    });
});

describe("sendRunWebhookTest while an admin impersonates the owner", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("refuses before reading the secret, and nothing is sent to the saved URL", async () => {
        const harness = lunoraTest(schema as never);
        const fetchSpy = vi.fn();

        vi.stubGlobal("fetch", fetchSpy);

        try {
            const secretCiphertext = await encryptKey("whsec_kept", "tool-keys");
            const { sessionId, userId } = (await harness.run(async (context: any) => {
                const user = await context.db.insert("user", {
                    createdAt: 0,
                    email: "impersonated@example.com",
                    emailVerified: true,
                    name: "Impersonated",
                    updatedAt: 0,
                });
                const session = await context.db.insert("session", {
                    createdAt: 0,
                    expiresAt: Date.now() + 86_400_000,
                    impersonatedBy: "admin-1",
                    token: "impersonated-session-token",
                    updatedAt: 0,
                    userId: user,
                });

                await context.db.insert("runWebhooks", {
                    createdAt: 0,
                    enabled: true,
                    secretCiphertext,
                    updatedAt: 0,
                    url: "https://hooks.example.com/neore",
                    userId: user,
                });

                return { sessionId: session, userId: user };
            })) as { sessionId: string; userId: string };

            await runInShard(userId, async () => {
                await expect(harness.withIdentity({ sessionId, userId } as never).action(sendRunWebhookTest as never, {} as never)).rejects.toMatchObject({
                    code: "FORBIDDEN",
                });
            });
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            harness.close();
        }
    });
});
