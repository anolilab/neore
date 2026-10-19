import { describe, expect, it, vi } from "vitest";

import { retryClipStore } from "./clip-store-retry";

const noPause = (): number => 0;

describe("retryClipStore", () => {
    it("returns the first store that succeeds, and does not report", async () => {
        const store = vi.fn(async () => "stored");
        const onGiveUp = vi.fn();

        await expect(retryClipStore(store, { attempts: 3, onGiveUp, pauseMs: noPause })).resolves.toBe("stored");
        expect(store).toHaveBeenCalledTimes(1);
        expect(onGiveUp).not.toHaveBeenCalled();
    });

    it("retries a store that fails, and returns the one that succeeds", async () => {
        const store = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce("stored");
        const onGiveUp = vi.fn();

        await expect(retryClipStore(store, { attempts: 3, onGiveUp, pauseMs: noPause })).resolves.toBe("stored");
        expect(store).toHaveBeenCalledTimes(2);
        expect(onGiveUp).not.toHaveBeenCalled();
    });

    it("gives up after the last attempt: it reports once, with the last error, and rethrows that error", async () => {
        const store = vi.fn().mockRejectedValueOnce(new Error("first")).mockRejectedValueOnce(new Error("second")).mockRejectedValueOnce(new Error("last"));
        const onGiveUp = vi.fn();

        await expect(retryClipStore(store, { attempts: 3, onGiveUp, pauseMs: noPause })).rejects.toThrow("last");
        expect(store).toHaveBeenCalledTimes(3);
        expect(onGiveUp).toHaveBeenCalledTimes(1);
        expect(onGiveUp).toHaveBeenCalledWith(expect.objectContaining({ message: "last" }));
    });
});
