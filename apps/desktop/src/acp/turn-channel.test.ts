import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostEvent, PostResult } from "./host-events";
import type { ChannelHost } from "./turn-channel";
import { TurnChannel } from "./turn-channel";

afterEach(() => {
    vi.useRealTimers();
});

/** A host whose posts are recorded, and which accepts every event. */
const recordingHost = () => {
    const posts: HostEvent[][] = [];
    const host: ChannelHost = {
        endedByBackend: () => {},
        finished: () => {},
        log: () => {},
        now: () => 1_000_000,
        random: () => 0.5,
        send: async (_channel, _firstSeq, events): Promise<PostResult> => {
            posts.push(events);

            return { ended: false, kind: "ok", next: 0 };
        },
        threadOf: () => "thread-1",
    };

    return { host, posts };
};

describe("a turn's plan updates waiting to be posted", () => {
    it("holds one plan per wait, the latest, after the text sent before it", async () => {
        vi.useFakeTimers();
        const { host, posts } = recordingHost();
        const channel = new TurnChannel(host, "sess-1", "turn-1", "thread-1", false);

        channel.enqueue({ entries: [{ content: "first", priority: "medium", status: "pending" }], kind: "plan" } as HostEvent);
        channel.enqueue({ kind: "text", text: "between" });
        channel.enqueue({ entries: [{ content: "second", priority: "medium", status: "pending" }], kind: "plan" } as HostEvent);
        channel.enqueue({ entries: [{ content: "third", priority: "medium", status: "pending" }], kind: "plan" } as HostEvent);

        await vi.advanceTimersByTimeAsync(10_000);
        channel.stop();

        const posted = posts.flat();
        const plans = posted.filter((event) => event.kind === "plan");

        expect(plans).toHaveLength(1);
        expect(JSON.stringify(plans[0])).toContain("third");
        expect(posted.map((event) => event.kind)).toEqual(["text", "plan"]);
    });
});
