import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const appConfig = JSON.parse(readFileSync(new URL("../../app.json", import.meta.url), "utf8")) as {
    expo: {
        runtimeVersion?: { policy?: string };
        updates?: { checkAutomatically?: string; enabled?: boolean; fallbackToCacheTimeout?: number };
    };
};

describe("app.json update settings", () => {
    it("keys the runtime version on the native fingerprint, so an update never reaches a binary it does not fit", () => {
        expect(appConfig.expo.runtimeVersion).toEqual({ policy: "fingerprint" });
    });

    it("checks on load and never makes launch wait for the network", () => {
        expect(appConfig.expo.updates).toMatchObject({
            checkAutomatically: "ON_LOAD",
            enabled: true,
            fallbackToCacheTimeout: 0,
        });
    });
});
