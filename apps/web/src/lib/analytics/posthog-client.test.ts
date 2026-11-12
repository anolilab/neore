import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => {
    return {
        __loaded: false,
        captureException: vi.fn(),
        has_opted_out_capturing: vi.fn(() => false),
    };
});

vi.mock("./posthog-js", () => {
    return { posthog };
});

/** A fresh module, so each case starts with an empty, open queue. */
const loadClientModule = async () => {
    vi.resetModules();

    return await import("./posthog-client");
};

describe("captureException before PostHog initialises", () => {
    beforeEach(() => {
        posthog.__loaded = false;
        posthog.captureException.mockClear();
        posthog.has_opted_out_capturing.mockReturnValue(false);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("queues what is caught while the chunk loads and sends it, in order, once the client is flushed", async () => {
        const client = await loadClientModule();
        const early = new Error("hydration failed");

        client.captureException(early, { errorBoundary: "global" });
        client.captureException("rejected");

        expect(posthog.captureException).not.toHaveBeenCalled();

        const loaded = await client.loadPostHog();

        loaded.__loaded = true;
        client.flushPendingExceptions(loaded);

        expect(posthog.captureException.mock.calls).toStrictEqual([
            [early, { errorBoundary: "global" }],
            ["rejected", undefined],
        ]);

        // Initialised: later exceptions go straight to PostHog, nothing is queued.
        client.captureException("later");

        expect(posthog.captureException).toHaveBeenLastCalledWith("later", undefined);
        expect(posthog.captureException).toHaveBeenCalledTimes(3);
    });

    it("keeps only the latest MAX_PENDING_EXCEPTIONS", async () => {
        const client = await loadClientModule();

        for (let index = 0; index < client.MAX_PENDING_EXCEPTIONS + 5; index += 1) {
            client.captureException(`error ${index}`);
        }

        client.flushPendingExceptions(await client.loadPostHog());

        const sent = posthog.captureException.mock.calls.map(([error]) => error);

        expect(sent).toHaveLength(client.MAX_PENDING_EXCEPTIONS);
        expect(sent[0]).toBe("error 5");
        expect(sent.at(-1)).toBe(`error ${client.MAX_PENDING_EXCEPTIONS + 4}`);
    });

    it("drops the queue when the user opted out", async () => {
        const client = await loadClientModule();

        client.captureException(new Error("early"));
        posthog.has_opted_out_capturing.mockReturnValue(true);
        client.flushPendingExceptions(await client.loadPostHog());

        expect(posthog.captureException).not.toHaveBeenCalled();
    });

    it("drops the queue, and queues nothing more, when analytics will not load", async () => {
        const client = await loadClientModule();

        client.captureException(new Error("early"));
        client.discardPendingExceptions();
        client.captureException(new Error("after"));
        client.flushPendingExceptions(await client.loadPostHog());

        expect(posthog.captureException).not.toHaveBeenCalled();
    });

    it("sends the rest of the queue when one report throws", async () => {
        const client = await loadClientModule();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        client.captureException("first");
        client.captureException("second");
        posthog.captureException.mockImplementationOnce(() => {
            throw new Error("report failed");
        });

        expect(() => client.flushPendingExceptions(posthog as never)).not.toThrow();
        expect(posthog.captureException.mock.calls.map(([error]) => error)).toStrictEqual(["first", "second"]);
        expect(warn).toHaveBeenCalledOnce();
    });

    it("queues nothing while measurement consent is refused, and a refusal drops what was queued", async () => {
        const client = await loadClientModule();

        client.captureException("before the refusal");
        client.setMeasurementConsent(false);
        client.captureException("while refused");
        client.setMeasurementConsent(true);
        client.captureException("after the grant");
        client.flushPendingExceptions(await client.loadPostHog());

        expect(posthog.captureException.mock.calls.map(([error]) => error)).toStrictEqual(["after the grant"]);
    });
});
