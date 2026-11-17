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

describe("a call's output and its status waiting to be posted", () => {
    it("never posts a call's final output before the status that finished it, when a batch ends between them", async () => {
        vi.useFakeTimers();
        const { host: recorded, posts } = recordingHost();
        let release = (): void => {};
        let holdFirst = true;
        const host: ChannelHost = {
            ...recorded,
            // The first batch is held in flight, so everything below queues behind it: the batch that carries the rest ends there.
            send: async (channel, firstSeq, events) => {
                if (holdFirst) {
                    holdFirst = false;
                    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` is not in this package's TypeScript lib
                    await new Promise<void>((resolve) => {
                        release = resolve;
                    });
                }

                return await recorded.send(channel, firstSeq, events);
            },
        };
        const channel = new TurnChannel(host, "sess-1", "turn-1", "thread-1", false);

        channel.enqueue({ id: "c1", kind: "tool", status: "in_progress", title: "build", toolKind: "execute" });
        await vi.advanceTimersByTimeAsync(10);

        channel.enqueue({ id: "c1", kind: "tool_output", output: "building" });
        channel.enqueue({ id: "c1", kind: "tool", status: "completed", title: "build", toolKind: "execute" });
        channel.enqueue({ exit: { code: 0 }, id: "c1", kind: "tool_output", output: "done" });

        release();
        await vi.advanceTimersByTimeAsync(10_000);
        channel.stop();

        const posted = posts.flat();
        const finished = posted.findIndex((event) => event.kind === "tool" && event.status === "completed");
        const finalOutput = posted.findIndex((event) => event.kind === "tool_output" && event.output === "done");

        expect(finished).toBeGreaterThan(-1);
        expect(finalOutput).toBeGreaterThan(finished);
    });
});
