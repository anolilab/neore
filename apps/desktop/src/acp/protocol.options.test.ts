/**
 * An option request the agent answers after its timeout is refused on time, but its answer is still handed over, so the
 * options the session offers match what the agent did.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { setConfigOption, setMode } from "./protocol";

afterEach(() => {
    vi.useRealTimers();
});

describe("an option request the agent answers late", () => {
    it("is refused on time, and its answer is still handed over when it comes", async () => {
        // The request is answered 60 ms after it is made; the request's own timeout is 10 ms. The clock is driven past each point.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        const answer = { configOptions: [] };
        const connection = {
            request: () =>
                new Promise((resolve) => {
                    setTimeout(() => {
                        resolve(answer);
                    }, 60);
                }),
        };
        const late: unknown[] = [];

        const refused = expect(
            setConfigOption(connection as never, "s1", "model", "fast", 10, (value) => {
                late.push(value);
            }),
        ).rejects.toThrow("the agent did not answer");

        await vi.advanceTimersByTimeAsync(10);
        await refused;
        expect(late).toEqual([]);

        // The answer arrives after the timeout: it is handed over, not dropped.
        await vi.advanceTimersByTimeAsync(60);

        expect(late).toEqual([answer]);
    });

    it("hands nothing over for an answer that arrives in time", async () => {
        const connection = { request: () => Promise.resolve({ ok: true }) };
        const late: unknown[] = [];

        await expect(
            setMode(connection as never, "s1", "ask", 1000, (value) => {
                late.push(value);
            }),
        ).resolves.toEqual({ ok: true });

        expect(late).toEqual([]);
    });
});
