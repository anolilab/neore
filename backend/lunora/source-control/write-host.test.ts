import { describe, expect, it } from "vitest";

import { githubDriver } from "./drivers/github";
import { HostApiError } from "./origin-fetch";
import { writeToHost } from "./write-host";

const token = { accessToken: "tkn" } as const;

const failing = (error: unknown) => async () => {
    throw error;
};

describe("writeToHost", () => {
    it("calls nothing when the user has no usable grant", async () => {
        const write = failing(new Error("must not run"));

        expect(await writeToHost(githubDriver, { problem: "not_connected" }, write)).toEqual({ status: "not_connected" });
        expect(await writeToHost(githubDriver, { problem: "expired" }, write)).toEqual({ status: "needs_reconnect" });
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
        [new HostApiError("x", 500), "host_error"],
        [new HostApiError("x", 0), "host_error"],
    ])("maps %o to %s", async (error, status) => {
        expect(await writeToHost(githubDriver, token, failing(error))).toEqual({ status });
    });

    it("lets an unexpected error through", async () => {
        await expect(writeToHost(githubDriver, token, failing(new RangeError("bug")))).rejects.toBeInstanceOf(RangeError);
    });
});
