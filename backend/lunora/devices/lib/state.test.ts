/**
 * Whether a computer is outdated (`isDeviceOutdated`): its reported protocol is below the floor the backend still serves
 * (`MIN_DEVICE_PROTOCOL`), the same floor the refusal of a call to it uses. Only a report can say it: no report is not an old build.
 */
import { describe, expect, it } from "vitest";

import { MIN_DEVICE_PROTOCOL } from "./constants";
import { isDeviceOutdated } from "./state";

describe("isDeviceOutdated", () => {
    it("is true for a protocol below the floor", () => {
        expect(isDeviceOutdated({ hostProtocol: MIN_DEVICE_PROTOCOL - 1 })).toBe(true);
        expect(isDeviceOutdated({ hostProtocol: 0 })).toBe(true);
    });

    it("is false at the floor, and above it", () => {
        expect(isDeviceOutdated({ hostProtocol: MIN_DEVICE_PROTOCOL })).toBe(false);
        expect(isDeviceOutdated({ hostProtocol: MIN_DEVICE_PROTOCOL + 1 })).toBe(false);
    });

    it("is false when the computer reported no protocol", () => {
        expect(isDeviceOutdated({})).toBe(false);
        expect(isDeviceOutdated({ hostProtocol: undefined })).toBe(false);
    });
});
