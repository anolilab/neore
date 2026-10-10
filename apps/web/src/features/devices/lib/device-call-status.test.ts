import { describe, expect, it } from "vitest";

import { deviceCallDisplay, isDeviceCallInFlight, isDeviceCallWaiting } from "./device-call-status";

const running = { state: "input-available" } as const;

describe("deviceCallDisplay", () => {
    it("follows the live call while the tool waits", () => {
        expect(deviceCallDisplay(running, undefined)).toBe("queued");
        expect(deviceCallDisplay(running, null)).toBe("queued");
        expect(deviceCallDisplay(running, { status: "pending" })).toBe("queued");
        expect(deviceCallDisplay(running, { status: "claimed" })).toBe("claimed");
        expect(deviceCallDisplay(running, { phase: "prompting", status: "claimed" })).toBe("awaiting_approval");
        expect(deviceCallDisplay(running, { phase: "running", status: "claimed" })).toBe("running");
        // Finished on the device, before the tool's own output landed.
        expect(deviceCallDisplay(running, { phase: "running", status: "completed" })).toBe("done");
        expect(deviceCallDisplay(running, { status: "denied" })).toBe("denied");
    });

    it("reads how it ended from the tool output, whatever the live row says", () => {
        expect(deviceCallDisplay({ output: { ok: true, output: "" }, state: "output-available" }, { status: "claimed" })).toBe("done");
        expect(deviceCallDisplay({ output: { error: "x", ok: false, status: "denied" }, state: "output-available" }, undefined)).toBe("denied");
        expect(deviceCallDisplay({ output: { error: "x", ok: false, status: "expired" }, state: "output-available" }, undefined)).toBe("expired");
        expect(deviceCallDisplay({ output: { error: "x", ok: false }, state: "output-available" }, undefined)).toBe("failed");
        expect(deviceCallDisplay({ state: "output-error" }, undefined)).toBe("failed");
        expect(deviceCallDisplay({ state: "output-denied" }, undefined)).toBe("not_approved");
    });
});

describe("isDeviceCallInFlight", () => {
    it("is true only until the tool returns", () => {
        expect(isDeviceCallInFlight(running)).toBe(true);
        expect(isDeviceCallInFlight({ state: "input-streaming" })).toBe(true);
        expect(isDeviceCallInFlight({ state: "output-available" })).toBe(false);
        expect(isDeviceCallInFlight({ state: "output-denied" })).toBe(false);
    });
});

describe("isDeviceCallWaiting", () => {
    it("spins only for a call still moving", () => {
        expect(isDeviceCallWaiting("awaiting_approval")).toBe(true);
        expect(isDeviceCallWaiting("done")).toBe(false);
        expect(isDeviceCallWaiting("expired")).toBe(false);
    });
});
