import { describe, expect, it } from "vitest";

import { isTimingEnabled } from "./development-timing";

describe(isTimingEnabled, () => {
    it("is on only for SHARD_TIMING=on in development", () => {
        expect(isTimingEnabled({ ENVIRONMENT: "development", SHARD_TIMING: "on" })).toBe(true);
        expect(isTimingEnabled({ ENVIRONMENT: "development" })).toBe(false);
        expect(isTimingEnabled({ ENVIRONMENT: "development", SHARD_TIMING: "off" })).toBe(false);
    });

    it.each(["production", "preview", undefined])("stays off outside development (ENVIRONMENT=%s)", (environment) => {
        expect(isTimingEnabled({ ENVIRONMENT: environment, SHARD_TIMING: "on" })).toBe(false);
    });
});
