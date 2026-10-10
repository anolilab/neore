import { describe, expect, it, vi } from "vitest";

import type { DeviceRelayPorts } from "./device-relay";
import { createDeviceRelay, DEVICE_ONLINE_WINDOW_MS, isDeviceOnline, relayDeviceCall } from "./device-relay";

const CALL = { callId: "c1", envelope: "{}", signature: "s" };
const RESULT = { payload: '{"kind":"result"}', signature: "r" };

const ports = (overrides: Partial<DeviceRelayPorts> = {}): DeviceRelayPorts => {
    return {
        claim: vi.fn(async () => true),
        complete: vi.fn(async () => {}),
        execute: vi.fn(async () => RESULT),
        release: vi.fn(async () => {}),
        ...overrides,
    };
};

describe("relayDeviceCall", () => {
    it("claims, runs on the shell and sends back exactly the signed result", async () => {
        const relay = ports();

        await expect(relayDeviceCall(CALL, relay)).resolves.toBe("completed");
        expect(relay.execute).toHaveBeenCalledWith(CALL);
        expect(relay.complete).toHaveBeenCalledWith("c1", RESULT);
    });

    it("never runs a call another window claimed", async () => {
        const relay = ports({ claim: vi.fn(async () => false) });

        await expect(relayDeviceCall(CALL, relay)).resolves.toBe("not-claimed");
        expect(relay.execute).not.toHaveBeenCalled();
    });

    it("releases a call the shell refused, so the agent is not left waiting", async () => {
        const relay = ports({
            execute: vi.fn(async () => {
                throw new Error("the request has expired");
            }),
        });

        await expect(relayDeviceCall(CALL, relay)).resolves.toBe("refused");
        expect(relay.release).toHaveBeenCalledWith("c1", "the request has expired");
        expect(relay.complete).not.toHaveBeenCalled();
    });
});

describe("createDeviceRelay", () => {
    it("relays each call once however often the live list repeats it", async () => {
        const relay = ports();
        const push = createDeviceRelay(relay);

        push([CALL]);
        push([CALL, { ...CALL, callId: "c2" }]);
        await vi.waitFor(() => expect(relay.complete).toHaveBeenCalledTimes(2));
        expect(relay.claim).toHaveBeenCalledTimes(2);
    });
});

describe("isDeviceOnline", () => {
    it("is online within the heartbeat window only", () => {
        expect(isDeviceOnline(1000, 1000 + DEVICE_ONLINE_WINDOW_MS)).toBe(true);
        expect(isDeviceOnline(1000, 1001 + DEVICE_ONLINE_WINDOW_MS)).toBe(false);
        expect(isDeviceOnline(undefined, 0)).toBe(false);
    });
});
