/**
 * An option request the agent answers after its timeout is refused on time, but its answer is still handed over, so the
 * options the session offers match what the agent did.
 */
import { describe, expect, it } from "vitest";

import { setConfigOption, setMode } from "./protocol";

describe("an option request the agent answers late", () => {
    it("is refused on time, and its answer is still handed over when it comes", async () => {
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

        await expect(
            setConfigOption(connection as never, "s1", "model", "fast", 10, (value) => {
                late.push(value);
            }),
        ).rejects.toThrow("the agent did not answer");

        await new Promise((resolve) => {
            setTimeout(() => {
                resolve(undefined);
            }, 120);
        });

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
