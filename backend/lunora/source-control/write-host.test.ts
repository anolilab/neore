import { describe, expect, it } from "vitest";

import { githubDriver } from "./drivers/github";
import type { HostRequest } from "./origin-fetch";
import { HostApiError } from "./origin-fetch";
import { writeToHost } from "./write-host";

const token = {
    accessToken: "tkn",
    renew: async () => {
        return { problem: "expired" as const };
    },
};

const failing = (error: unknown) => async () => {
    throw error;
};

describe("writeToHost", () => {
    it("calls nothing when the user has no usable grant", async () => {
        const write = failing(new Error("must not run"));

        expect(await writeToHost(githubDriver, { problem: "not_connected" }, write)).toEqual({ status: "not_connected" });
        expect(await writeToHost(githubDriver, { problem: "expired" }, write)).toEqual({ status: "needs_reconnect" });
        expect(await writeToHost(githubDriver, { problem: "unavailable" }, write)).toEqual({ status: "host_error" });
    });

    describe("a 401", () => {
        const renewing = (next: Parameters<typeof writeToHost>[1]) => {
            let renewals = 0;
            const first = {
                accessToken: "stale",
                renew: async () => {
                    renewals += 1;

                    return next;
                },
            };

            return { first, renewals: () => renewals };
        };

        it("renews the token once and writes again with the new one, since a 401 means the host did nothing", async () => {
            const { first, renewals } = renewing({ accessToken: "fresh", renew: token.renew });
            const used: string[] = [];
            const via = async (_input: Request | string | URL, init?: RequestInit): Promise<Response> => {
                used.push(new Headers(init?.headers).get("authorization") ?? "");

                return used.length === 1 ? new Response("{}", { status: 401 }) : Response.json({ ok: true });
            };
            const outcome = await writeToHost(
                githubDriver,
                first,
                async (request: HostRequest) => {
                    await request("/user", { json: { a: 1 }, method: "POST" });

                    return {};
                },
                via,
            );

            expect(outcome).toEqual({ status: "ok" });
            expect(renewals()).toBe(1);
            expect(used).toEqual(["Bearer stale", "Bearer fresh"]);
        });

        it("asks to reconnect when the renewal yields no token, and does not write again", async () => {
            const { first, renewals } = renewing({ problem: "expired" });
            let writes = 0;
            const outcome = await writeToHost(githubDriver, first, async () => {
                writes += 1;

                throw new HostApiError("x", 401);
            });

            expect(outcome).toEqual({ status: "needs_reconnect" });
            expect(renewals()).toBe(1);
            expect(writes).toBe(1);
        });

        it("gives up after one renewal when the host still answers 401", async () => {
            const { first, renewals } = renewing({ accessToken: "fresh", renew: token.renew });
            let writes = 0;
            const outcome = await writeToHost(githubDriver, first, async () => {
                writes += 1;

                throw new HostApiError("x", 401);
            });

            expect(outcome).toEqual({ status: "needs_reconnect" });
            expect(renewals()).toBe(1);
            expect(writes).toBe(2);
        });

        it("never repeats a write that failed any other way", async () => {
            const { first, renewals } = renewing({ accessToken: "fresh", renew: token.renew });
            let writes = 0;

            await writeToHost(githubDriver, first, async () => {
                writes += 1;

                throw new HostApiError("x", 500);
            });

            expect(writes).toBe(1);
            expect(renewals()).toBe(0);
        });
    });

    it("returns what the write returned with an ok status", async () => {
        expect(
            await writeToHost(githubDriver, token, async () => {
                return { review: { id: "1" } };
            }),
        ).toEqual({ review: { id: "1" }, status: "ok" });
    });

    it.each([400, 409, 422])("reports a %i as a refusal and keeps the host's reason, bounded", async (status) => {
        const outcome = await writeToHost(githubDriver, token, failing(new HostApiError("x", status, false, { detail: "No." })));

        expect(outcome).toEqual({ reason: "No.", status: "rejected" });
    });

    it("reports a refusal with no reason as such", async () => {
        expect(await writeToHost(githubDriver, token, failing(new HostApiError("x", 422)))).toEqual({ reason: null, status: "rejected" });
    });

    it("reports a write whose answer never came as unconfirmed, never as a plain failure", async () => {
        expect(await writeToHost(githubDriver, token, failing(new HostApiError("x", 0, false, { unconfirmed: true })))).toEqual({ status: "unconfirmed" });
    });

    it.each([
        [new HostApiError("x", 401), "needs_reconnect"],
        [new HostApiError("x", 403), "forbidden"],
        [new HostApiError("x", 403, true), "rate_limited"],
        [new HostApiError("x", 422, true), "rate_limited"],
        [new HostApiError("x", 404), "not_found"],
        [new HostApiError("x", 0), "host_error"],
    ])("maps %o to %s", async (error, status) => {
        expect(await writeToHost(githubDriver, token, failing(error))).toEqual({ status });
    });

    it.each([500, 502, 504])("reports a %i as unconfirmed: the host may have acted before it failed", async (status) => {
        expect(await writeToHost(githubDriver, token, failing(new HostApiError("x", status)))).toEqual({ status: "unconfirmed" });
    });

    it("lets an unexpected error through", async () => {
        await expect(writeToHost(githubDriver, token, failing(new RangeError("bug")))).rejects.toBeInstanceOf(RangeError);
    });

    it("answers rate_limited, not a refusal or no access, for a throttled write, bare 403 included", async () => {
        const answers: Response[] = [
            new Response("{}", { headers: { "retry-after": "60" }, status: 403 }),
            new Response("{}", { status: 429 }),
            Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403 }),
        ];

        for (const answer of answers) {
            expect(
                await writeToHost(
                    githubDriver,
                    token,
                    async (request) => await request("/x", { json: {}, method: "POST" }),
                    async () => answer,
                ),
            ).toEqual({
                status: "rate_limited",
            });
        }
    });
});
