import { describe, expect, it, vi } from "vitest";

import type { DeviceRelayPorts, RelayClock } from "./device-relay";
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

/** A clock the test moves: `sleep` only advances it, so a retry costs no real time. */
const fakeClock = (start = 1_000_000) => {
    const clock = { now: start, sleeps: [] as number[] };
    const relayClock: RelayClock = {
        now: () => clock.now,
        random: () => 0.5,
        sleep: async (ms) => {
            clock.sleeps.push(ms);
            clock.now += ms;
        },
    };

    return { clock, relayClock };
};

const callExpiringAt = (expiresAt: number) => {
    return { ...CALL, envelope: JSON.stringify({ expiresAt }) };
};

/** Lets the relay's own bookkeeping after a call (a few promise turns) finish. */
const settled = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
};

const SERVER_ERROR = new Error("500 Internal Server Error");
const NETWORK_RESET = new TypeError("network connection lost");

describe("retrying a call until its deadline", () => {
    it("gets a claim through a server error and then a network reset", async () => {
        const { clock, relayClock } = fakeClock();
        const claim = vi.fn<DeviceRelayPorts["claim"]>().mockRejectedValueOnce(SERVER_ERROR).mockRejectedValueOnce(NETWORK_RESET).mockResolvedValue(true);
        const relay = ports({ claim });

        await expect(relayDeviceCall(callExpiringAt(clock.now + 60_000), relay, relayClock)).resolves.toBe("completed");
        expect(claim).toHaveBeenCalledTimes(3);
        expect(relay.execute).toHaveBeenCalledTimes(1);
        // Backing off between tries, not hammering.
        expect(clock.sleeps).toHaveLength(2);
        expect(clock.sleeps[1]).toBeGreaterThan(clock.sleeps[0] as number);
    });

    it("gets the signed result through whatever the backend throws, without running the call again", async () => {
        const { clock, relayClock } = fakeClock();
        const complete = vi.fn<DeviceRelayPorts["complete"]>().mockRejectedValueOnce(NETWORK_RESET).mockRejectedValueOnce(SERVER_ERROR).mockResolvedValue();
        const relay = ports({ complete });

        await expect(relayDeviceCall(callExpiringAt(clock.now + 60_000), relay, relayClock)).resolves.toBe("completed");
        expect(complete).toHaveBeenCalledTimes(3);
        expect(relay.execute).toHaveBeenCalledTimes(1);
    });

    it("keeps trying to release a refused call too", async () => {
        const { clock, relayClock } = fakeClock();
        const release = vi.fn<DeviceRelayPorts["release"]>().mockRejectedValueOnce(NETWORK_RESET).mockResolvedValue();
        const relay = ports({
            execute: vi.fn(async () => {
                throw new Error("the request has expired");
            }),
            release,
        });

        await expect(relayDeviceCall(callExpiringAt(clock.now + 60_000), relay, relayClock)).resolves.toBe("refused");
        expect(release).toHaveBeenCalledTimes(2);
    });

    it("does not retry an answer that cannot change, and stops after a bounded number of tries", async () => {
        const { clock, relayClock } = fakeClock();
        const forbidden = Object.assign(new Error("Result signature is invalid"), { code: "FORBIDDEN" });
        const wrapped = Object.assign(new Error("bad"), { data: { code: "BAD_REQUEST" } });
        const complete = vi.fn<DeviceRelayPorts["complete"]>().mockRejectedValueOnce(forbidden);

        await expect(relayDeviceCall(callExpiringAt(clock.now + 600_000), ports({ complete }), relayClock)).rejects.toBe(forbidden);
        expect(complete).toHaveBeenCalledTimes(1);

        const claim = vi.fn<DeviceRelayPorts["claim"]>().mockRejectedValue(wrapped);

        await expect(relayDeviceCall(callExpiringAt(clock.now + 600_000), ports({ claim }), relayClock)).rejects.toBe(wrapped);
        expect(claim).toHaveBeenCalledTimes(1);

        const failing = vi.fn(async () => {
            throw SERVER_ERROR;
        });

        await expect(relayDeviceCall(callExpiringAt(clock.now + 10 * 60 * 60_000), ports({ claim: failing }), relayClock)).rejects.toBe(SERVER_ERROR);
        expect(failing).toHaveBeenCalledTimes(20);
    });

    it("gives up, with the last error, once the call's deadline has passed", async () => {
        const { clock, relayClock } = fakeClock();
        const claim = vi.fn(async () => {
            throw SERVER_ERROR;
        });

        await expect(relayDeviceCall(callExpiringAt(clock.now + 5000), ports({ claim }), relayClock)).rejects.toBe(SERVER_ERROR);
        // Never sleeps past the deadline.
        expect(clock.now).toBeLessThanOrEqual(1_000_000 + 5000);
        expect(claim.mock.calls.length).toBeGreaterThan(2);
    });
});

describe("createDeviceRelay", () => {
    it("relays a call again when it comes back after its claim lapsed", async () => {
        const { relayClock } = fakeClock();
        const relay = ports();
        const push = createDeviceRelay(relay, undefined, relayClock);

        push([CALL]);
        await vi.waitFor(() => expect(relay.complete).toHaveBeenCalledTimes(1));
        await settled();
        // The shell never answered the backend in time; the call is back in the pending list.
        push([CALL]);
        await vi.waitFor(() => expect(relay.complete).toHaveBeenCalledTimes(2));
        expect(relay.claim).toHaveBeenCalledTimes(2);
    });

    it("leaves a call another window holds alone for a while, then looks again", async () => {
        const { clock, relayClock } = fakeClock();
        const relay = ports({ claim: vi.fn(async () => false) });
        const push = createDeviceRelay(relay, undefined, relayClock);

        push([CALL]);
        await vi.waitFor(() => expect(relay.claim).toHaveBeenCalledTimes(1));
        await settled();
        push([CALL]);
        await settled();
        expect(relay.claim).toHaveBeenCalledTimes(1);

        clock.now += 16_000;
        push([CALL]);
        await vi.waitFor(() => expect(relay.claim).toHaveBeenCalledTimes(2));
    });


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
