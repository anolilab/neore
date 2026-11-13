import { describe, expect, it } from "vitest";

import type { Scoped, SyncState } from "./live-follow";
import { EMPTY_LIVE, followLive, liveFor, ownSyncState } from "./live-follow";

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

    it("reports each answer with rows as a successful read, and an error as none", () => {
        const fake = fakeWatch();
        let answered = 0;

        followLive("a:projects", fake.watch, recorder().publish, () => {
            answered += 1;
        });
        fake.error("FORBIDDEN");
        expect(answered).toBe(0);

        for (const rows of [["p1"], []]) {
            fake.push(rows);
        }

        expect(answered).toBe(2);
    });

    it("does not count a held value replayed while subscribing, and counts the server's answer after it", () => {
        let answered = 0;
        let onRows: ((rows: string[]) => void) | undefined;
        let onError: ((message: string) => void) | undefined;
        const seen = recorder();

        followLive(
            "a:projects",
            (rowsCallback, errorCallback) => {
                onRows = rowsCallback;
                onError = errorCallback;
                // The Lunora client hands a held value to a new subscriber inside `subscribe()`, before the server answers.
                rowsCallback(["cached"]);

                return () => {};
            },
            seen.publish,
            () => {
                answered += 1;
            },
        );

        expect(seen.latest().rows).toEqual(["cached"]);
        expect(answered).toBe(0);

        onError?.("FORBIDDEN");
        expect(answered).toBe(0);

        onRows?.(["p1"]);
        expect(answered).toBe(1);
    });

    it("reports a reconnect the server answers with no rows callback (a resume frame), but not the state at subscribing", async () => {
        let answered = 0;
        let report: ((status: SyncState) => void) | undefined;
        let syncStopped = 0;
        const fake = fakeWatch();

        const stop = followLive(
            "a:projects",
            fake.watch,
            recorder().publish,
            () => {
                answered += 1;
            },
            (listener) => {
                report = listener;
                // `onSyncStatus` reports the current state at once, while it is being registered.
                listener({ synced: true });

                return () => {
                    syncStopped += 1;
                };
            },
        );

        expect(answered).toBe(0);

        // The connection drops and comes back; the server acknowledges the unchanged subscription and no rows arrive.
        report?.({ synced: false });
        await Promise.resolve();
        expect(answered).toBe(0);
        report?.({ synced: true });
        await Promise.resolve();
        expect(answered).toBe(1);

        stop();
        expect(syncStopped).toBe(1);
        expect(fake.stopped()).toBe(1);
    });

    it("keeps writes blocked for a subscription the server refuses after a reconnect, which the client reports synced first", async () => {
        let answered = 0;
        let report: ((status: SyncState) => void) | undefined;
        const fake = fakeWatch();

        followLive(
            "a:projects",
            fake.watch,
            recorder().publish,
            () => {
                answered += 1;
            },
            (listener) => {
                report = listener;

                return () => {};
            },
        );

        // `markQueryRejected` marks the refused subscription answered and emits `synced`, then `failSubscription` calls the error callback.
        report?.({ synced: true });
        fake.error("FORBIDDEN");
        await Promise.resolve();
        expect(answered).toBe(0);

        // Other subscriptions settling later report `synced` again: the refused one still counts as no answer.
        report?.({ synced: false });
        report?.({ synced: true });
        await Promise.resolve();
        expect(answered).toBe(0);

        // Its rows arriving again are an answer.
        fake.push(["p1"]);
        expect(answered).toBe(1);
    });

    it("reports nothing when the connection drops before a synced report's turn comes", async () => {
        let answered = 0;
        let report: ((status: SyncState) => void) | undefined;

        followLive(
            "a:projects",
            fakeWatch().watch,
            recorder().publish,
            () => {
                answered += 1;
            },
            (listener) => {
                report = listener;

                return () => {};
            },
        );

        report?.({ synced: true });
        // The connection drops before the deferred report runs.
        report?.({ synced: false });
        await Promise.resolve();
        expect(answered).toBe(0);

        // A drop and a return in one turn: the report from before the drop does not count, the answer after it does, once.
        report?.({ synced: true });
        report?.({ synced: false });
        report?.({ synced: true });
        await Promise.resolve();
        expect(answered).toBe(1);
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

describe("ownSyncState", () => {
    const projects = "projects_functions:listProjects";

    it("answers a project screen once its own subscription is acknowledged, though others and queued writes still wait", () => {
        const status = { connection: "connected", synced: false };

        expect(
            ownSyncState(
                status,
                [
                    { acked: true, functionPath: projects },
                    { acked: false, functionPath: "chat_functions:listThreads" },
                ],
                projects,
            ),
        ).toStrictEqual({ synced: true });
    });

    it("waits while any subscription of its own query is unanswered, or none is open", () => {
        const status = { connection: "connected", synced: true };

        expect(
            ownSyncState(
                status,
                [
                    { acked: true, functionPath: projects },
                    { acked: false, functionPath: projects },
                ],
                projects,
            ),
        ).toStrictEqual({ synced: false });
        expect(ownSyncState(status, [], projects)).toStrictEqual({ synced: false });
    });

    it("falls back to the client's aggregate over HTTP polling, where no subscription is acknowledged", () => {
        expect(ownSyncState({ connection: "polling", synced: true }, [{ acked: false, functionPath: projects }], projects)).toStrictEqual({ synced: true });
        expect(ownSyncState({ connection: "offline", synced: false }, [{ acked: true, functionPath: projects }], projects)).toStrictEqual({ synced: false });
    });
});
