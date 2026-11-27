import { describe, expect, it, vi } from "vitest";

import type { PostResult } from "./host-events";
import { SessionLink } from "./session-link";

const INFO = { agentKey: "claude", agentLabel: "Claude Code", folderId: "f1", folderLabel: "neore" };

describe("a session link after its poster stops", () => {
    it("does not open the session again when a retry is answered after the stop", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        try {
            const requests: string[] = [];
            const answers: ((result: PostResult) => void)[] = [];
            const link = new SessionLink("s1", INFO, {
                bound: () => {},
                deviceId: () => "dev1",
                flushReport: async () => {},
                now: () => 1000,
                random: () => 0.5,
                released: () => {},
                request: async (payload: string) => {
                    requests.push(payload);

                    return await new Promise<PostResult>((resolve) => {
                        answers.push(resolve);
                    });
                },
            });

            const opened = link.open();

            // The poster stops while the open is in flight, and the backend then asks for a retry.
            link.stop();
            answers[0]?.({ kind: "retry" });
            await opened;
            await vi.advanceTimersByTimeAsync(120_000);

            expect(requests).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
