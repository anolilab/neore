import { describe, expect, it, vi } from "vitest";

import type { BrowserClient, BrowserStatus } from "./browser-api";
import { watchBrowserStatus } from "./browser-api";

describe(watchBrowserStatus, () => {
    it("passes on each status, and nothing while the client reloads its queries for a new sign-in", () => {
        let push: (value: unknown) => void = () => {};
        const client = {
            subscribe: vi.fn((_function: unknown, _args: unknown, callback: (value: unknown) => void) => {
                push = callback;

                return () => {};
            }),
        } as unknown as BrowserClient;
        const onStatus = vi.fn();
        const status = { kind: "none" } as unknown as BrowserStatus;

        watchBrowserStatus(client, "t-1", onStatus, () => {});
        push(status);
        push(undefined);

        expect(onStatus).toHaveBeenCalledTimes(1);
        expect(onStatus).toHaveBeenCalledWith(status);
    });
});
