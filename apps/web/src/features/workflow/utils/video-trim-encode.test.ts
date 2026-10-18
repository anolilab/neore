import { describe, expect, it, vi } from "vitest";

import { trimVideo } from "./video-trim-encode";

// The encoder is replaced by a fake whose `init` can be aborted mid-flight. Only the members `trimVideo` touches are here.
const fake = vi.hoisted(() => {
    return {
        cancel: vi.fn(async () => undefined),
        execute: vi.fn(async () => undefined),
        onInit: undefined as (() => void) | undefined,
    };
});

vi.mock("mediabunny", () => {
    // One stand-in class for every constructor `trimVideo` calls: the calls only need an object back.
    class Stub {
        buffer: ArrayBuffer | undefined = undefined;

        dispose: () => void;

        constructor() {
            this.dispose = () => undefined;
        }
    }

    const Conversion = {
        init: async () => {
            fake.onInit?.();

            return {
                cancel: fake.cancel,
                discardedTracks: [],
                execute: fake.execute,
                isValid: true,
                utilizedTracks: [{ isVideoTrack: () => true }],
            };
        },
    };

    return {
        BlobSource: Stub,
        BufferTarget: Stub,
        Conversion,
        ConversionCanceledError: Error,
        Input: Stub,
        MP4: {},
        Mp4OutputFormat: Stub,
        Output: Stub,
        QTFF: {},
    };
});

describe("trimVideo", () => {
    it("does not encode when the abort fires while the encoder is still initialising, and cancels what it made", async () => {
        const controller = new AbortController();

        fake.onInit = () => {
            controller.abort();
        };

        await expect(
            trimVideo(new File(["source"], "clip.mp4", { type: "video/mp4" }), { range: { end: 3, start: 0 }, signal: controller.signal }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(fake.execute).not.toHaveBeenCalled();
        expect(fake.cancel).toHaveBeenCalledTimes(1);
    });
});
