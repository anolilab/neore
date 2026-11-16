import { describe, expect, it, vi } from "vitest";

import type { StartedChat } from "./chat-api";
import { ChatError } from "./chat-api";
import { createSendSessions } from "./send-sessions";
import { startWithRetries } from "./start-send";

describe("a send still retrying at sign-out", () => {
    it("tries nothing more after the sign-out, and is marked the departed account's", async () => {
        const sessions = createSendSessions();
        const controller = new AbortController();
        const session = sessions.begin(controller);
        const attempt = vi.fn<() => Promise<StartedChat>>().mockRejectedValue(new ChatError("The gateway did not answer in time."));

        // The first try gets no answer; the person signs out while the send waits to retry.
        const sending = startWithRetries({
            attempt,
            signal: controller.signal,
            sleep: async () => {
                sessions.signOut();
            },
        });

        await expect(sending).rejects.toThrow("The gateway did not answer in time.");
        expect(attempt).toHaveBeenCalledOnce();
        expect(session.isSignedOut()).toBe(true);
    });

    it("leaves a send that began after the next sign-in alone", () => {
        const sessions = createSendSessions();

        sessions.signOut();
        // The next sign-in opens the sessions again.
        sessions.open();

        const controller = new AbortController();
        const session = sessions.begin(controller);

        expect(controller.signal.aborted).toBe(false);
        expect(session.isSignedOut()).toBe(false);

        session.end();
        sessions.signOut();
        // Ended: a later sign-out no longer stops it.
        expect(controller.signal.aborted).toBe(false);
    });
});
