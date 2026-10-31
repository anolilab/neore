import { describe, expect, it } from "vitest";

import type { Scoped } from "./live-follow";
import { EMPTY_LIVE, followLive, liveFor } from "./live-follow";

/** A watch the test drives by hand. */
const fakeWatch = () => {
    let onRows: ((rows: string[]) => void) | undefined;
    let onError: ((message: string) => void) | undefined;
    let stopped = 0;

    return {
        error: (message: string) => onError?.(message),
        push: (rows: string[]) => onRows?.(rows),
        stopped: () => stopped,
        watch: (rowsCallback: (rows: string[]) => void, errorCallback: (message: string) => void) => {
            onRows = rowsCallback;
            onError = errorCallback;

            return () => {
                stopped += 1;
            };
        },
    };
};

const recorder = () => {
    let latest: Scoped<string> = { ...EMPTY_LIVE, scope: "none" };

    return {
        latest: () => latest,
        publish: (next: Scoped<string>) => {
            latest = next;
        },
    };
};

describe("followLive", () => {
    it("starts empty and hands over rows", () => {
        const fake = fakeWatch();
        const seen = recorder();

        followLive("a:projects", fake.watch, seen.publish);
        expect(seen.latest()).toEqual({ error: undefined, rows: undefined, scope: "a:projects" });

        fake.push(["p1"]);
        expect(seen.latest().rows).toEqual(["p1"]);
    });

    it("drops the rows when the subscription fails", () => {
        const fake = fakeWatch();
        const seen = recorder();

        followLive("a:projects", fake.watch, seen.publish);
        fake.push(["p1"]);
        fake.error("FORBIDDEN");

        expect(seen.latest()).toEqual({ error: "FORBIDDEN", rows: undefined, scope: "a:projects" });
    });

    it("never shows the previous user's rows after the user changes", () => {
        const first = fakeWatch();
        const second = fakeWatch();
        const seen = recorder();

        const stopFirst = followLive("user-a:projects", first.watch, seen.publish);

        first.push(["A's project"]);
        stopFirst();
        expect(first.stopped()).toBe(1);

        followLive("user-b:projects", second.watch, seen.publish);

        expect(liveFor(seen.latest(), "user-b:projects").rows).toBeUndefined();

        second.error("FORBIDDEN");
        expect(liveFor(seen.latest(), "user-b:projects")).toEqual({ error: "FORBIDDEN", rows: undefined });
    });
});

describe("liveFor", () => {
    it("hides state that belongs to another scope", () => {
        const stale: Scoped<string> = { error: undefined, rows: ["A's project"], scope: "user-a:projects" };

        expect(liveFor(stale, "user-b:projects")).toEqual(EMPTY_LIVE);
        expect(liveFor(stale, undefined)).toEqual(EMPTY_LIVE);
        expect(liveFor(stale, "user-a:projects").rows).toEqual(["A's project"]);
    });
});
