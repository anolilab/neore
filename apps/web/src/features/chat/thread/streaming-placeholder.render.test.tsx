/**
 * Render-count harness for the streaming reply: how often the markdown renderer
 * (`MessageContent`) re-renders while chunks arrive, and while none do.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UIMessage } from "@/lib/agent";

const harness = vi.hoisted(() => {
    return {
        contentPaints: 0,
        /** Ends the stream the test is feeding. */
        finish: undefined as (() => void) | undefined,
        lastText: "",
        /** Sends one NDJSON line on the stream the test is feeding. */
        push: undefined as ((line: string) => void) | undefined,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/lib/lunora/crpc", async () => {
    const { skipToken } = await import("@tanstack/react-query");
    const leaf = {
        queryOptions: (args: unknown) => {
            return { queryFn: args === skipToken ? skipToken : async () => null, queryKey: ["stream-body", args] };
        },
    };
    // Any depth of namespace (`crpc.a.b.fn`) ends at `leaf`.
    const namespace: object = new Proxy({}, { get: (_target, key) => (Object.hasOwn(leaf, key) ? leaf[key as keyof typeof leaf] : namespace) });

    return { useCRPC: () => namespace };
});

vi.mock("@/features/chat/group/speaker-label", () => {
    return { SpeakerChip: () => null };
});

vi.mock("./message-content", () => {
    return {
        default: ({ message }: { message: UIMessage }) => {
            harness.contentPaints += 1;
            harness.lastText = message.text;

            return createElement("div", { "data-testid": "content" }, message.text);
        },
    };
});

const { StreamingPlaceholder } = await import("./streaming-placeholder");

const CHUNKS = 50;

const encoder = new TextEncoder();

const wait = (ms: number) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const mount = () => {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            harness.push = (line) => controller.enqueue(encoder.encode(`${line}\n`));
            harness.finish = () => {
                try {
                    controller.close();
                } catch {
                    // Already closed by the test.
                }
            };
        },
    });

    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 200 })),
    );

    render(
        <QueryClientProvider client={new QueryClient()}>
            <StreamingPlaceholder gatewayUrl="https://gateway.test" streamId="stream-1" streamToken="token" />
        </QueryClientProvider>,
    );
};

describe("streaming placeholder render cost", () => {
    // `act()` batches every update inside it into one commit, which would hide
    // exactly the per-chunk renders this measures. Let React schedule for real.
    beforeEach(() => {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
        harness.contentPaints = 0;
        harness.lastText = "";
    });

    afterEach(() => {
        harness.finish?.();
        vi.unstubAllGlobals();
    });

    it("renders the markdown once per frame for a burst of chunks, and shows all of them", async () => {
        // Frames run only when the test says so, which makes the count exact.
        const frames: FrameRequestCallback[] = [];

        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            frames.push(callback);

            return frames.length;
        });
        vi.stubGlobal("cancelAnimationFrame", () => {});

        mount();
        await wait(20);

        const baseline = harness.contentPaints;

        // One network read per chunk, all of them before the next frame.
        for (let index = 0; index < CHUNKS; index += 1) {
            harness.push?.(JSON.stringify({ text: `t${index} ` }));
            await wait(0);
        }

        const due = [...frames];

        frames.length = 0;

        for (const frame of due) {
            frame(performance.now());
        }

        await wait(20);

        // Before frame batching: one render per chunk, so 50 here.
        expect(harness.contentPaints - baseline).toBe(1);
        expect(harness.lastText).toBe(Array.from({ length: CHUNKS }, (_, index) => `t${index} `).join(""));
    });

    it("does not re-render the markdown while no chunk arrives", async () => {
        mount();

        harness.push?.(JSON.stringify({ text: "hello" }));
        // Polled, not a fixed sleep: a slow runner (Windows CI) had not painted the chunk after 50ms.
        await vi.waitFor(() => expect(harness.lastText).toBe("hello"));

        const baseline = harness.contentPaints;

        // The metrics bar ticks every 100ms; the reply itself did not change.
        await wait(550);

        // Before the metrics bar was split out: one render per tick (5 here).
        expect(harness.contentPaints - baseline).toBe(0);
        expect(screen.getByTestId("content").textContent).toBe("hello");
    });

    it("starts over at a group-chat speaker change inside one frame", async () => {
        mount();

        harness.push?.(JSON.stringify({ speaker: { name: "Ada", skillId: "ada" }, text: "a" }));
        harness.push?.(JSON.stringify({ text: "b" }));
        harness.push?.(JSON.stringify({ speaker: { name: "Bo", skillId: "bo" }, text: "c" }));
        harness.push?.(JSON.stringify({ text: "d" }));

        // Without the reset this settles on "abcd", never passing through "cd".
        await vi.waitFor(() => expect(harness.lastText).toBe("cd"));
    });

    it("shows the final text when the stream ends", async () => {
        mount();

        harness.push?.(JSON.stringify({ reasoning: "think", text: "a" }));
        harness.push?.(JSON.stringify({ text: "b" }));
        harness.finish?.();

        await vi.waitFor(() => expect(harness.lastText).toBe("ab"));
    });
});
