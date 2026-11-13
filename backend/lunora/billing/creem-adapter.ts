/**
 * The one place the Creem adapter is built. `ctx.payments` (`src/server.ts`) and the internal billing
 * surface (`./provider.ts`) both build theirs here, so the timeout and test-mode switch cannot drift
 * between the two.
 */
import { createCreemAdapter } from "@lunora/payment/creem";

/** Every outbound Creem call holds the shard it runs on while it waits, so it gets a deadline. */
const CREEM_TIMEOUT_MS = 10_000;

interface CreemSettings {
    readonly apiKey: string | undefined;
    readonly testMode: string | undefined;
    readonly webhookSecret: string | undefined;
}

export const buildCreemAdapter = (settings: CreemSettings): ReturnType<typeof createCreemAdapter> =>
    createCreemAdapter({
        // The adapter calls this once, on first use, so the SDK is not loaded at worker startup.
        client: async () => {
            const { Creem } = await import("creem");

            return new Creem({
                apiKey: settings.apiKey ?? "",
                server: settings.testMode === "true" ? "test" : "prod",
                timeoutMs: CREEM_TIMEOUT_MS,
            });
        },
        webhookSecret: settings.webhookSecret ?? "",
    });
