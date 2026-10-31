import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createReconnectRefresher, renewTokenThenRefresh } from "./reconnect";
import { requireOnline } from "./write-gate";

const SOURCE_FILE = /\.tsx?$/;
const CLIENT_WRITE = /\.(?:mutation|action)\(/;

describe("renewTokenThenRefresh", () => {
    it("reads again only once the token has been renewed, so no read runs on a lapsed one", async () => {
        const calls: string[] = [];
        let finishRenewal: () => void = () => undefined;
        const run = renewTokenThenRefresh({
            refresh: () => {
                calls.push("refresh");
            },
            renewToken: () => new Promise<void>((resolve) => {
                calls.push("renew");
                finishRenewal = resolve;
            }),
        });
        const done = run();

        expect(calls).toEqual(["renew"]);

        finishRenewal();
        await done;

        expect(calls).toEqual(["renew", "refresh"]);
    });

    it("still reads again when the token could not be renewed", async () => {
        const refresh = vi.fn();

        const run = renewTokenThenRefresh({
            refresh,
            renewToken: async () => {
                throw new Error("offline");
            },
        });

        await expect(run()).rejects.toThrow("offline");

        expect(refresh).toHaveBeenCalledTimes(1);
    });
});

describe("reconnect", () => {
    it("refreshes on reconnect and sends nothing that was refused offline", async () => {
        const send = vi.fn(async () => {});
        const refresh = vi.fn(async () => {});
        const refresher = createReconnectRefresher(refresh);

        refresher.update(true);
        // The user taps Send while offline: refused, and nothing is held back for later.
        await expect(requireOnline({ isOffline: true }, send)).rejects.toThrow("Unavailable offline");
        refresher.update(false);

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
    });

    it("does not refresh while the state stays the same", () => {
        const refresh = vi.fn(async () => {});
        const refresher = createReconnectRefresher(refresh);

        refresher.update(false);
        refresher.update(false);
        refresher.update(true);
        refresher.update(true);

        expect(refresh).not.toHaveBeenCalled();
    });

    it("never opts a Lunora write into the client's offline queue", () => {
        const root = join(import.meta.dirname, "..", "..");
        const offenders: string[] = [];
        const visit = (directory: string) => {
            const entries = readdirSync(directory, { withFileTypes: true });

            for (const entry of entries) {
                const path = join(directory, entry.name);

                if (entry.isDirectory()) {
                    if (entry.name !== "node_modules") {
                        visit(path);
                    }
                } else if (SOURCE_FILE.test(entry.name) && !entry.name.includes(".test.")) {
                    const source = readFileSync(path, "utf8");

                    // The client queues a write made offline and replays it on reconnect, unless it is told `onlineOnly`.
                    if (CLIENT_WRITE.test(source) && !source.includes("onlineOnly: true")) {
                        offenders.push(path);
                    }
                }
            }
        };

        visit(join(root, "src"));
        visit(join(root, "app"));

        expect(offenders).toEqual([]);
    });
});
