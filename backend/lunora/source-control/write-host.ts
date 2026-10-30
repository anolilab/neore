/**
 * Runs one write against a host for a user, like `readFromHost` for a read, with the
 * two outcomes only a write has: the host REFUSED it (its own reason is kept, as
 * untrusted text), or it may have TAKEN it without our hearing (the answer never
 * arrived). A write is never repeated here, with one exception: a 401 means the host did
 * nothing, so it gets one forced token renewal and one more try. The caller decides what
 * a person may do after anything else.
 */
import type { GithubTokenOutcome } from "../connectors/lib/github-token";
import type { HostDriver } from "./driver";
import type { BoundRequesterConfig, HostRequest } from "./origin-fetch";
import { createBoundRequester, HostApiError } from "./origin-fetch";
import type { ReadFailure } from "./read-host";
import { failureOf, PROBLEM_STATUS } from "./read-host";

export type WriteFailure = ReadFailure | "rejected" | "unconfirmed";

export type WriteOutcome<T extends object> =
    (T & { status: "ok" }) | { reason: string | null; status: "rejected" } | { status: Exclude<WriteFailure, "rejected"> };

/** The statuses a host answers a request it understood and will not carry out. */
const REFUSAL_STATUSES = new Set([400, 409, 422]);

/** Longest reason from the host that is passed on to a person. */
const REASON_MAX_CHARS = 300;

/** What a write the host answered with an error comes to; a 401 is the caller's to retry. */
const outcomeOfFailure = (error: HostApiError): WriteOutcome<never> => {
    if (error.unconfirmed) {
        return { status: "unconfirmed" };
    }

    if (!error.rateLimited && REFUSAL_STATUSES.has(error.status)) {
        return { reason: error.detail?.slice(0, REASON_MAX_CHARS) ?? null, status: "rejected" };
    }

    return { status: failureOf(error) };
};

export const writeToHost = async <T extends object>(
    driver: HostDriver,
    token: GithubTokenOutcome,
    write: (request: HostRequest) => Promise<T>,
    via?: BoundRequesterConfig["via"],
): Promise<WriteOutcome<T>> => {
    let current = token;

    for (let attempt = 0; ; attempt += 1) {
        if ("problem" in current) {
            return { status: PROBLEM_STATUS[current.problem] };
        }

        const request = createBoundRequester({ headers: driver.headers, origin: driver.apiOrigin, token: current.accessToken, via });

        try {
            return { ...(await write(request)), status: "ok" };
        } catch (error) {
            if (!(error instanceof HostApiError)) {
                throw error;
            }

            if (error.status !== 401 || error.unconfirmed || attempt > 0) {
                return outcomeOfFailure(error);
            }

            current = await current.renew();
        }
    }
};
