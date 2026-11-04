import { describe, expect, it, vi } from "vitest";

import type { Confirmation, ConfirmPage } from "./reply-confirmation";
import { readAllReplyStates, readReplyState, tallyChecks } from "./reply-confirmation";

/** One page of messages, given oldest first inside the page as the server returns them. */
const page = (messages: [id: string, role: string, status?: string][], next: { continueCursor: string | null; isDone: boolean }): ConfirmPage => {
    return {
        ...next,
        page: messages.map(([id, role, status = "success"]) => {
            return { id, role, status };
        }),
    };
};

const confirmation = (messageId: string): Confirmation => {
    return { holdsSend: true, messageId, steers: 0, threadId: "t1" };
};

describe("readReplyState", () => {
    it("reads the next page when the send is not on the newest one, and judges its reply", async () => {
        const fetchPage = vi.fn(async (_threadId: string, cursor: string | null): Promise<ConfirmPage> => {
            if (cursor === null) {
                return page(
                    [
                        ["other", "user"],
                        ["otherReply", "assistant"],
                    ],
                    { continueCursor: "older", isDone: false },
                );
            }

            return page(
                [
                    ["sent", "user"],
                    ["ours", "assistant"],
                ],
                { continueCursor: null, isDone: true },
            );
        });

        expect(await readReplyState(fetchPage, "t1", "sent", 0)).toBe("settled");
        expect(fetchPage.mock.calls.map((call) => call[1])).toEqual([null, "older"]);
    });

    it("is unknown when the send is on no page", async () => {
        const fetchPage = vi.fn(async (): Promise<ConfirmPage> => page([["other", "user"]], { continueCursor: null, isDone: true }));

        expect(await readReplyState(fetchPage, "t1", "sent", 0)).toBe("unknown");
    });
});

describe("readAllReplyStates", () => {
    it("requests each page once for all the confirmations of a round", async () => {
        const fetchPage = vi.fn(async (_threadId: string, _cursor: string | null): Promise<ConfirmPage> => page([["other", "user"]], { continueCursor: "older", isDone: false }));

        const outcomes = await readAllReplyStates(fetchPage, "t1", [confirmation("a"), confirmation("b")]);

        expect(outcomes.map((outcome) => outcome.state)).toEqual(["unknown", "unknown"]);
        expect(fetchPage.mock.calls.map((call) => call[1])).toEqual([null, "older"]);
    });

    it("reports a refused chat for the confirmations it could not read", async () => {
        const fetchPage = vi.fn(async (): Promise<ConfirmPage> => {
            throw Object.assign(new Error("Access denied to this thread"), { code: "UNAUTHORIZED" });
        });

        const [outcome] = await readAllReplyStates(fetchPage, "t1", [confirmation("a")]);

        expect(outcome?.isChatRefused).toBe(true);
    });
});

describe("tallyChecks", () => {
    it("ends a settled reply at once and asks for a re-read", () => {
        const round = tallyChecks([{ confirmation: confirmation("a"), state: "settled" }], new Map());

        expect([...round.ended]).toEqual(["a"]);
        expect(round.isRefreshDue).toBe(true);
    });

    it("re-reads the history at the sixth unsettled check, holds the send until the fifteenth, and gives up at the 150th", () => {
        const reads = new Map<string, number>();
        const pending = [{ confirmation: confirmation("a"), state: "pending" as const }];
        const check = () => tallyChecks(pending, reads);

        for (let index = 1; index < 6; index += 1) {
            expect(check().isRefreshDue).toBe(false);
        }

        expect(check().isRefreshDue).toBe(true);

        for (let index = 7; index < 15; index += 1) {
            expect(check().holdEnds.size).toBe(0);
        }

        expect([...check().holdEnds]).toEqual(["a"]);

        for (let index = 16; index < 150; index += 1) {
            expect(check().ended.size).toBe(0);
        }

        expect([...check().ended]).toEqual(["a"]);
    });
});
