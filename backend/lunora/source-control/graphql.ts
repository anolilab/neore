/**
 * One GraphQL call through a bound requester. GraphQL reports most failures with
 * status 200 and an `errors` array, so a response that carries one is turned into
 * a `HostApiError` here, with the status its first error type stands for. The query
 * text is always a constant in the caller; host and user data travel as variables.
 */
import type z from "zod/v4";

import type { HostRequest } from "./origin-fetch";
import { HostApiError } from "./origin-fetch";
import { parse, readJson } from "./response";

const ERROR_STATUS: Record<string, number> = {
    FORBIDDEN: 403,
    INSUFFICIENT_SCOPES: 403,
    NOT_FOUND: 404,
    RATE_LIMITED: 429,
};

const DETAIL_MAX_CHARS = 300;

/** The status a GraphQL error type stands for; an error type this does not know is a refused request. */
export const statusOfGraphqlError = (type: string | undefined): number => ERROR_STATUS[type ?? ""] ?? 422;

export const graphqlRequest = async <T>(
    request: HostRequest,
    query: string,
    variables: Record<string, unknown>,
    dataSchema: z.ZodType<T>,
    path = "/graphql",
): Promise<T> => {
    const body = (await readJson(await request(path, { json: { query, variables }, method: "POST" }))) as {
        data?: unknown;
        errors?: { message?: unknown; type?: unknown }[];
    } | null;

    const [first] = body?.errors ?? [];

    if (first !== undefined) {
        const status = statusOfGraphqlError(typeof first.type === "string" ? first.type : undefined);
        const detail = typeof first.message === "string" ? first.message.slice(0, DETAIL_MAX_CHARS) : undefined;

        throw new HostApiError("The host refused the GraphQL request", status, status === 429, { detail });
    }

    return parse(dataSchema, body?.data);
};
