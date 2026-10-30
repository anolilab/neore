import { describe, expect, it } from "vitest";

import { githubDriver } from "./drivers/github";
import { HostApiError } from "./origin-fetch";
import { failureOf, readFromHost } from "./read-host";

const token = { accessToken: "tkn" } as const;

describe("readFromHost", () => {
    it("answers not_connected without calling the host", async () => {
        const via = async (): Promise<Response> => {
            throw new Error("must not be called");
        };

        expect(
            await readFromHost(
                githubDriver,
                { problem: "not_connected" },
                async () => {
                    return {};
                },
                via,
            ),
        ).toEqual({ status: "not_connected" });
    });

    it("answers needs_reconnect for a grant that no longer yields a token", async () => {
        expect(
            await readFromHost(githubDriver, { problem: "expired" }, async () => {
                return {};
            }),
        ).toEqual({ status: "needs_reconnect" });
    });

    it("returns what the read returned, with an ok status, through a requester bound to the driver's origin", async () => {
        const urls: string[] = [];
        const via = async (input: Request | string | URL): Promise<Response> => {
            urls.push(String(input));

            return Response.json({ login: "me" });
        };
        const outcome = await readFromHost(
            githubDriver,
            token,
            async (request) => {
                const response = await request("/user");

                return (await response.json()) as object;
            },
            via,
        );

        expect(outcome).toEqual({ login: "me", status: "ok" });
        expect(urls).toEqual(["https://api.github.com/user"]);
    });

    it("turns a host failure into a status, and lets an unexpected error through", async () => {
        expect(
            await readFromHost(githubDriver, token, async () => {
                throw new HostApiError("nope", 401);
            }),
        ).toEqual({ status: "needs_reconnect" });
        await expect(
            readFromHost(githubDriver, token, async () => {
                throw new RangeError("bug");
            }),
        ).rejects.toBeInstanceOf(RangeError);
    });

    it.each([
        [new HostApiError("x", 401), "needs_reconnect"],
        [new HostApiError("x", 403), "forbidden"],
        [new HostApiError("x", 403, true), "rate_limited"],
        [new HostApiError("x", 429, true), "rate_limited"],
        [new HostApiError("x", 404), "not_found"],
        [new HostApiError("x", 410), "not_found"],
        [new HostApiError("x", 500), "host_error"],
        [new HostApiError("x", 422), "host_error"],
        [new HostApiError("x", 0), "host_error"],
    ])("maps %o to %s", (error, failure) => {
        expect(failureOf(error)).toBe(failure);
    });
});
