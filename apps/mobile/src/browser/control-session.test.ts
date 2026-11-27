import { CONTROL_KEEP_INTERVAL_MS, CONTROL_LEASE_MS } from "@neore/client-runtime";
import { describe, expect, it, vi } from "vitest";

import type { ControlApi, ControlState } from "./control-session";
import { CONTROL_ELSEWHERE, CONTROL_ENDED, CONTROL_OFFLINE, createControlSession, forgetClaim, rememberClaim, rememberedClaim } from "./control-session";

const NOW = 1_000_000;
const OK = { claim: "c-1", claimId: "id-1", status: "ok" as const, until: NOW + CONTROL_LEASE_MS };

const setup = (overrides: Partial<ControlApi> = {}) => {
    const ticks: (() => void)[] = [];
    const stopped = vi.fn();
    const states: ControlState[] = [];
    const api: ControlApi = {
        handBack: vi.fn(async () => true),
        keep: vi.fn(async () => {
            return { until: NOW + 2 * CONTROL_LEASE_MS };
        }),
        navigate: vi.fn(async () => {
            return { status: "ok" as const };
        }),
        take: vi.fn(async () => OK),
        ...overrides,
    };
    const session = createControlSession({
        api,
        every: (ms, run) => {
            expect(ms).toBe(CONTROL_KEEP_INTERVAL_MS);
            ticks.push(run);

            return stopped;
        },
        onChange: (state) => {
            states.push(state);
        },
    });

    return { api, session, states, stopped, tick: () => ticks.at(-1)?.() };
};

describe(createControlSession, () => {
    it("takes control exclusively, renews it on each interval, and opens a page under its claim", async () => {
        const { api, session, tick } = setup();

        await session.take();
        expect(session.state()).toStrictEqual({ claim: "c-1", claimId: "id-1", kind: "holding", until: OK.until });

        tick();
        await vi.waitFor(() => expect(session.state()).toMatchObject({ until: NOW + 2 * CONTROL_LEASE_MS }));
        expect(api.keep).toHaveBeenCalledWith("c-1");

        await expect(session.navigate("https://example.com")).resolves.toBeUndefined();
        expect(api.navigate).toHaveBeenCalledWith("c-1", "https://example.com");
    });

    it("says why control was refused while the web holds it, and holds nothing", async () => {
        const held = vi.fn(async () => {
            return { status: "held" as const };
        });
        const { session } = setup({ take: held });

        await session.take();

        expect(session.state()).toStrictEqual({ kind: "idle", message: expect.stringContaining("Hand it back there first") });
    });

    it("hands the claim back when the screen goes, and stops renewing", async () => {
        const { api, session, stopped } = setup();

        await session.take();
        session.release("left");

        expect(api.handBack).toHaveBeenCalledWith("c-1", "left");
        expect(stopped).toHaveBeenCalled();
        expect(session.state()).toStrictEqual({ kind: "idle" });
    });

    it("remembers a claim whose answer came after the phone went offline, so a hand back that could not go out never locks it out", async () => {
        const late = Promise.withResolvers<typeof OK>();
        const onClaim = vi.fn();
        const onReleased = vi.fn();
        const api: ControlApi = {
            handBack: vi.fn(async () => {
                throw new TypeError("Network request failed");
            }),
            keep: vi.fn(async () => null),
            navigate: vi.fn(async () => {
                return { status: "ok" as const };
            }),
            take: vi.fn(async () => await late.promise),
        };
        const session = createControlSession({ api, every: () => () => {}, onChange: () => {}, onClaim, onReleased });
        const taking = session.take();

        session.suspend();
        late.resolve(OK);
        await taking;

        expect(onClaim).toHaveBeenCalledWith("c-1");
        await vi.waitFor(() => expect(api.handBack).toHaveBeenCalledWith("c-1", "left"));
        expect(onReleased).not.toHaveBeenCalled();
    });

    it("gives back a claim whose answer came after the screen went", async () => {
        const late = Promise.withResolvers<typeof OK>();
        const { api, session } = setup({ take: vi.fn(async () => await late.promise) });
        const taking = session.take();

        session.release("left");
        late.resolve(OK);
        await taking;

        expect(api.handBack).toHaveBeenCalledWith("c-1", "left");
        expect(session.state()).toStrictEqual({ kind: "idle" });
    });

    it("stops when a renewal says the lease is gone", async () => {
        const { session, tick } = setup({ keep: vi.fn(async () => null) });

        await session.take();
        tick();

        await vi.waitFor(() => expect(session.state()).toStrictEqual({ kind: "idle", message: CONTROL_ENDED }));
    });

    it("stops at once when another of the person's views took the lease, but not on a status from before its claim", async () => {
        const { session } = setup();

        await session.take();
        // A status read before the claim was written names no lease: it says nothing about this claim.
        session.noteLease(undefined, NOW - 1);
        expect(session.state().kind).toBe("holding");

        session.noteLease({ byYou: true, claimIds: ["id-1"], until: OK.until }, NOW);
        expect(session.state().kind).toBe("holding");

        session.noteLease({ byYou: true, claimIds: ["id-web"], until: OK.until }, NOW + 1);
        expect(session.state()).toStrictEqual({ kind: "idle", message: CONTROL_ELSEWHERE });
    });

    it("gives up control offline without sending anything, and asks for its own lease back on the next take", async () => {
        const { api, session } = setup();

        await session.take();
        session.suspend();

        expect(session.state()).toStrictEqual({ kind: "idle", message: CONTROL_OFFLINE });
        expect(api.handBack).not.toHaveBeenCalled();

        await session.take();
        expect(api.take).toHaveBeenLastCalledWith("c-1");
    });

    it("names the claim a screen opened before held, so its own leftover lease is not refused as another window's", async () => {
        const onClaim = vi.fn();
        const onReleased = vi.fn();
        const api: ControlApi = {
            handBack: vi.fn(async () => true),
            keep: vi.fn(async () => null),
            navigate: vi.fn(async () => {
                return { status: "ok" as const };
            }),
            take: vi.fn(async () => OK),
        };
        const session = createControlSession({ api, every: () => () => {}, lastClaim: "c-0", onChange: () => {}, onClaim, onReleased });

        await session.take();
        expect(api.take).toHaveBeenCalledWith("c-0");
        expect(onClaim).toHaveBeenLastCalledWith("c-1");

        session.release("handed_back");
        await vi.waitFor(() => expect(onReleased).toHaveBeenCalledWith("c-1"));
    });

    it("keeps the claim per account and thread across screens until it is handed back", () => {
        rememberClaim("u:t", "c-1");
        expect(rememberedClaim("u:t")).toBe("c-1");
        expect(rememberedClaim("u:other")).toBeUndefined();

        // A late hand back of an older claim leaves the newer one remembered since.
        rememberClaim("u:t", "c-2");
        forgetClaim("u:t", "c-1");
        expect(rememberedClaim("u:t")).toBe("c-2");

        forgetClaim("u:t", "c-2");
        expect(rememberedClaim("u:t")).toBeUndefined();
    });

    it("stops showing control once a whole lease passed with no renewal landing", async () => {
        const clock = { at: NOW };
        const ticks: (() => void)[] = [];
        const session = createControlSession({
            api: {
                handBack: vi.fn(async () => true),
                keep: vi.fn(async () => {
                    throw new TypeError("Network request failed");
                }),
                navigate: vi.fn(async () => {
                    return { status: "ok" as const };
                }),
                take: vi.fn(async () => OK),
            },
            deviceNow: () => clock.at,
            every: (_ms, run) => {
                ticks.push(run);

                return () => {};
            },
            onChange: () => {},
        });

        await session.take();
        clock.at += CONTROL_LEASE_MS - 1;
        ticks[0]?.();
        expect(session.state().kind).toBe("holding");

        clock.at += 1;
        ticks[0]?.();
        expect(session.state()).toStrictEqual({ kind: "idle", message: CONTROL_ENDED });
    });

    it("counts a page that loaded as a renewal, from when it was asked for", async () => {
        const clock = { at: NOW };
        const ticks: (() => void)[] = [];
        const session = createControlSession({
            api: {
                handBack: vi.fn(async () => true),
                keep: vi.fn(async () => {
                    throw new TypeError("Network request failed");
                }),
                navigate: vi.fn(async () => {
                    clock.at += 5000;

                    return { status: "ok" as const };
                }),
                take: vi.fn(async () => OK),
            },
            deviceNow: () => clock.at,
            every: (_ms, run) => {
                ticks.push(run);

                return () => {};
            },
            onChange: () => {},
        });

        await session.take();
        clock.at += 60_000;
        await expect(session.navigate("https://example.com")).resolves.toBeUndefined();

        // The lease taken at NOW would have ended; the one the page renewed, asked for at NOW + 60 s, has not.
        clock.at = NOW + 60_000 + CONTROL_LEASE_MS - 1;
        ticks[0]?.();
        expect(session.state().kind).toBe("holding");

        clock.at += 1;
        ticks[0]?.();
        expect(session.state()).toStrictEqual({ kind: "idle", message: CONTROL_ENDED });
    });

    it("stops holding when opening a page finds the lease gone, but keeps it for any other refusal", async () => {
        const navigate = vi.fn(async () => {
            return { error: "The page you opened is still loading.", status: "refused" as const };
        });
        const { session } = setup({ navigate });

        await session.take();
        await expect(session.navigate("https://example.com")).resolves.toBe("The page you opened is still loading.");
        expect(session.state().kind).toBe("holding");

        navigate.mockResolvedValueOnce({ error: "You do not have control of the browser.", status: "refused" as const });
        await expect(session.navigate("https://example.com")).resolves.toBe(CONTROL_ENDED);
        expect(session.state()).toStrictEqual({ kind: "idle", message: CONTROL_ENDED });
    });

    it("waits for a hand back still out before a retake, and names no claim it gave back", async () => {
        const handBack = Promise.withResolvers<boolean>();
        const take = vi.fn(async () => OK);
        const session = createControlSession({
            api: {
                handBack: vi.fn(async () => await handBack.promise),
                keep: vi.fn(async () => null),
                navigate: vi.fn(async () => {
                    return { status: "ok" as const };
                }),
                take,
            },
            every: () => () => {},
            onChange: () => {},
        });

        await session.take();
        session.release("left");

        const retaking = session.take();

        await Promise.resolve();
        expect(take).toHaveBeenCalledTimes(1);

        handBack.resolve(true);
        await retaking;
        expect(take).toHaveBeenLastCalledWith(undefined);
    });

    it("asks for nothing when the screen is left while a hand back it waited for was still out", async () => {
        const handBack = Promise.withResolvers<boolean>();
        const take = vi.fn(async () => OK);
        const session = createControlSession({
            api: {
                handBack: vi.fn(async () => await handBack.promise),
                keep: vi.fn(async () => null),
                navigate: vi.fn(async () => {
                    return { status: "ok" as const };
                }),
                take,
            },
            every: () => () => {},
            onChange: () => {},
        });

        await session.take();
        session.release("left");

        const retaking = session.take();

        session.release("left");
        handBack.resolve(true);
        await retaking;

        expect(take).toHaveBeenCalledTimes(1);
        expect(session.state()).toStrictEqual({ kind: "idle" });
    });

    it("keeps a newer take's claim when an older, abandoned take answers last", async () => {
        const first = Promise.withResolvers<typeof OK>();
        const take = vi.fn().mockImplementationOnce(async () => await first.promise).mockResolvedValueOnce({ ...OK, claim: "c-2", claimId: "id-2" });
        const onClaim = vi.fn();
        const session = createControlSession({
            api: {
                handBack: vi.fn(async () => true),
                keep: vi.fn(async () => null),
                navigate: vi.fn(async () => {
                    return { status: "ok" as const };
                }),
                take,
            },
            every: () => () => {},
            onChange: () => {},
            onClaim,
        });
        const abandoned = session.take();

        await vi.waitFor(() => expect(take).toHaveBeenCalledTimes(1));
        session.release("left");
        await session.take();
        first.resolve(OK);
        await abandoned;

        expect(onClaim).toHaveBeenLastCalledWith("c-2");
        expect(session.state()).toMatchObject({ claim: "c-2", kind: "holding" });
    });

    it("sends one renewal at a time, and times the lease from when the renewal was sent", async () => {
        const clock = { at: NOW };
        const ticks: (() => void)[] = [];
        const answer = Promise.withResolvers<{ until: number }>();
        const keep = vi.fn(async () => await answer.promise);
        const session = createControlSession({
            api: {
                handBack: vi.fn(async () => true),
                keep,
                navigate: vi.fn(async () => {
                    return { status: "ok" as const };
                }),
                take: vi.fn(async () => OK),
            },
            deviceNow: () => clock.at,
            every: (_ms, run) => {
                ticks.push(run);

                return () => {};
            },
            onChange: () => {},
        });

        await session.take();
        clock.at = NOW + 30_000;
        ticks[0]?.();
        ticks[0]?.();
        expect(keep).toHaveBeenCalledTimes(1);

        // The answer is slow: the lease still ends a whole lease after the renewal was SENT.
        clock.at = NOW + 60_000;
        answer.resolve({ until: NOW + 150_000 });
        await vi.waitFor(() => expect(session.state()).toMatchObject({ until: NOW + 150_000 }));

        clock.at = NOW + 30_000 + CONTROL_LEASE_MS;
        ticks[0]?.();
        expect(session.state()).toStrictEqual({ kind: "idle", message: CONTROL_ENDED });
    });
});
