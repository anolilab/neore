/**
 * Runs one read against a host for a user and answers with a status instead of
 * throwing for the failures a person can act on: not connected, the grant needs
 * signing in again, no access, rate limited. An unexpected error stays unhandled.
 */
import type { GithubTokenOutcome } from "../connectors/lib/github-token";
import type { HostDriver } from "./driver";
import type { HostRequest } from "./origin-fetch";
import { createBoundRequester, HostApiError } from "./origin-fetch";
import type { BoundRequesterConfig } from "./origin-fetch";

export type ReadFailure = "forbidden" | "host_error" | "needs_reconnect" | "not_connected" | "not_found" | "rate_limited";

export type ReadOutcome<T extends object> = (T & { status: "ok" }) | { status: ReadFailure };

export const failureOf = (error: HostApiError): ReadFailure => {
    if (error.rateLimited) {
        return "rate_limited";
    }

    switch (error.status) {
        case 401: {
            return "needs_reconnect";
        }
        case 403: {
            return "forbidden";
        }
        case 404:
        case 410: {
            return "not_found";
        }
        default: {
            return "host_error";
        }
    }
};

const PROBLEM_STATUS = { expired: "needs_reconnect", not_connected: "not_connected", unavailable: "host_error" } as const;

export const readFromHost = async <T extends object>(
    driver: HostDriver,
    token: GithubTokenOutcome,
    read: (request: HostRequest) => Promise<T>,
    via?: BoundRequesterConfig["via"],
): Promise<ReadOutcome<T>> => {
    let current = token;

    // A 401 gets one forced refresh before it is called a sign-in problem.
    for (let attempt = 0; ; attempt += 1) {
        if ("problem" in current) {
            return { status: PROBLEM_STATUS[current.problem] };
        }

        const request = createBoundRequester({ headers: driver.headers, origin: driver.apiOrigin, token: current.accessToken, via });

        try {
            return { ...(await read(request)), status: "ok" };
        } catch (error) {
            if (!(error instanceof HostApiError)) {
                throw error;
            }

            if (error.status !== 401 || attempt > 0) {
                return { status: failureOf(error) };
            }

            current = await current.renew();
        }
    }
};
