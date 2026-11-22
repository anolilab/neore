/**
 * Saving the run webhook, end to end through the real session check: the save
 * returns the secret once, the read shows the saved settings, and a second save
 * updates them without another secret.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import schema from "../schema";
import { getRunWebhook, saveRunWebhook } from "./functions";

const SECRET_PREFIX = /^whsec_/u;

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
