import z from "zod/v4";
import { describe, expect, it } from "vitest";

import { graphqlRequest, statusOfGraphqlError } from "./graphql";
import type { HostRequest } from "./origin-fetch";

/** A requester that answers every call with `body` and records what it was sent. */
const answering = (body: unknown) => {
    const sent: { json: unknown; method: string | undefined; path: string }[] = [];
    const request: HostRequest = async (path, options) => {
        sent.push({ json: options?.json, method: options?.method, path });

        return Response.json(body);
    };

    return { request, sent };
};

const SCHEMA = z.object({ viewer: z.object({ login: z.string() }) });

describe("graphqlRequest", () => {
    it("posts the query with its variables and returns the parsed data", async () => {
        const { request, sent } = answering({ data: { viewer: { login: "octocat" } } });

        expect(await graphqlRequest(request, "query { viewer { login } }", { a: 1 }, SCHEMA)).toEqual({ viewer: { login: "octocat" } });
        expect(sent).toEqual([{ json: { query: "query { viewer { login } }", variables: { a: 1 } }, method: "POST", path: "/graphql" }]);
    });

    it("treats a 200 that carries errors as a failure, with the status the error type stands for", async () => {
        const { request } = answering({ data: null, errors: [{ message: "Could not resolve", type: "NOT_FOUND" }] });

        await expect(graphqlRequest(request, "q", {}, SCHEMA)).rejects.toMatchObject({ name: "HostApiError", status: 404 });
    });

    it("keeps the reason of a refused mutation, bounded, and flags a rate limit", async () => {
        const refused = answering({ errors: [{ message: "x".repeat(1000), type: "UNPROCESSABLE" }] });
        const limited = answering({ errors: [{ message: "slow down", type: "RATE_LIMITED" }] });

        await expect(graphqlRequest(refused.request, "q", {}, SCHEMA)).rejects.toMatchObject({ detail: "x".repeat(300), status: 422 });
        await expect(graphqlRequest(limited.request, "q", {}, SCHEMA)).rejects.toMatchObject({ rateLimited: true, status: 429 });
    });

    it("refuses data of the wrong shape", async () => {
        const { request } = answering({ data: { viewer: { login: 7 } } });

        await expect(graphqlRequest(request, "q", {}, SCHEMA)).rejects.toMatchObject({ name: "HostApiError" });
    });

    it.each([
        ["FORBIDDEN", 403],
        ["INSUFFICIENT_SCOPES", 403],
        ["NOT_FOUND", 404],
        ["SOMETHING_NEW", 422],
        [undefined, 422],
    ])("maps %s to %i", (type, status) => {
        expect(statusOfGraphqlError(type)).toBe(status);
    });
});
