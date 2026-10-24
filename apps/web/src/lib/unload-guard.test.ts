import { afterEach, describe, expect, it } from "vitest";

import { acquireUnloadGuard } from "./unload-guard";

/** Whether a `beforeunload` is cancelled, i.e. whether a guard listener is registered. */
const isGuarded = (): boolean => {
    const event = new Event("beforeunload", { cancelable: true });

    globalThis.dispatchEvent(event);

    return event.defaultPrevented;
};

const releases: (() => void)[] = [];

const acquire = () => {
    const release = acquireUnloadGuard();

    releases.push(release);

    return release;
};

afterEach(() => {
    for (const release of releases) {
        release();
    }

    releases.length = 0;
});

describe(acquireUnloadGuard, () => {
    it("is off until work starts", () => {
        expect(isGuarded()).toBe(false);
    });

    it("is on while work is in flight and off once it completes", () => {
        const release = acquire();

        expect(isGuarded()).toBe(true);

        release();

        expect(isGuarded()).toBe(false);
    });

    it("is off after work fails, when the caller releases in a finally", async () => {
        const run = async () => {
            const release = acquire();

            try {
                await Promise.reject(new Error("upload failed"));
            } finally {
                release();
            }
        };

        await expect(run()).rejects.toThrow("upload failed");
        expect(isGuarded()).toBe(false);
    });

    it("stays on while another job is still running", () => {
        const first = acquire();
        const second = acquire();

        first();

        expect(isGuarded()).toBe(true);

        second();

        expect(isGuarded()).toBe(false);
    });

    it("ignores a second release of the same guard", () => {
        const first = acquire();

        acquire();
        first();
        first();

        expect(isGuarded()).toBe(true);
    });
});
