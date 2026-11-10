/**
 * `neore login --device`: sign in by code.
 *
 * The CLI asks the backend for a device code, shows a URL and a short code, and
 * polls until the code is approved in the web app, denied or expired. It opens
 * no browser and listens on no port, so it works over SSH. On approval the
 * backend answers once with a read-only API key.
 *
 * Errors on these routes are OAuth-style (`{ error, error_description }`), not
 * the `/api/v1` shape `errorFromResponse` reads, so this file parses its own.
 * They become `ApiError`s with codes of their own; `exitCodeFor` maps
 * `rate_limited` to 5 and `network_error` / `service_unavailable` to 6, and
 * every `device_*` code exits 1.
 */
import { UsageError } from "./args";
import { ApiError, stripTrailingSlashes } from "./client";

const CODE_PATH = "/api/auth/device/code";
const KEY_PATH = "/api/auth/device/key";
const REVOKE_PATH = "/api/auth/device/revoke";

/** The one client id the backend accepts for the CLI. */
const CLIENT_ID = "neore-cli";

const REQUEST_TIMEOUT_MS = 15_000;

/** RFC 8628 3.5: after `slow_down`, wait this much longer from then on. */
const SLOW_DOWN_STEP_MS = 5000;

/** Consecutive transport, 5xx and 429 answers tolerated while polling. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** The poll interval stays in 1-60 s and a code is waited on for at most an hour, whatever the server says. */
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 60_000;
const MAX_LIFETIME_MS = 60 * 60 * 1000;

/** What a flow needs from the outside; injected so tests run without real time or network. */
export interface DeviceFlowDependencies {
    fetch: typeof fetch;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}

export interface DeviceCode {
    deviceCode: string;
    expiresAtMs: number;
    intervalMs: number;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
}

type Body = Record<string, unknown>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** The code and the new key travel over this URL: https, or http to a loopback host for local development. */
export const assertSecureBaseUrl = (baseUrl: string): void => {
    const { hostname, protocol } = new URL(baseUrl);

    if (protocol !== "https:" && !(protocol === "http:" && LOOPBACK_HOSTS.has(hostname))) {
        throw new UsageError("--device needs an https:// API URL (http:// is accepted only for localhost).");
    }
};

const readJson = async (response: Response): Promise<Body> => {
    try {
        const body = (await response.json()) as unknown;

        return body && typeof body === "object" ? (body as Body) : {};
    } catch {
        return {};
    }
};

/** The server's text, written to a terminal: control characters (ESC included) are dropped. */
const describe = (body: Body): string => (typeof body["error_description"] === "string" ? body["error_description"].replaceAll(/\p{Cc}/gu, "") : "");

const post = async (dependencies: DeviceFlowDependencies, baseUrl: string, path: string, body: unknown): Promise<Response> => {
    try {
        return await dependencies.fetch(`${stripTrailingSlashes(baseUrl)}${path}`, {
            body: JSON.stringify(body),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "POST",
            // A redirect would resend the device code or the new key to wherever it points.
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        throw new ApiError({
            code: "network_error",
            message: `Could not reach ${stripTrailingSlashes(baseUrl)}: ${error instanceof Error ? error.message : String(error)}`,
            status: 0,
        });
    }
};

/** ESC and the other control characters: what a terminal escape sequence is made of. */
const CONTROL = /(?![\t\n])\p{Cc}/u;

const isSeconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

const failure = (code: string, message: string, status: number): ApiError => new ApiError({ code, message, status });

/** Ask for a code. `hostname` is shown, as plain text, to the person approving it. */
export const requestDeviceCode = async (dependencies: DeviceFlowDependencies, baseUrl: string, hostname: string): Promise<DeviceCode> => {
    const response = await post(dependencies, baseUrl, CODE_PATH, { client_id: CLIENT_ID, hostname });
    const body = await readJson(response);

    if (!response.ok) {
        if (response.status === 404) {
            throw failure(
                "device_login_unsupported",
                "This server does not offer sign-in by code. Create an API key in Settings -> API keys and run `neore login`.",
                404,
            );
        }

        if (response.status === 429) {
            throw failure("rate_limited", "Too many sign-in attempts. Wait a minute and try again.", 429);
        }

        throw failure(
            response.status >= 500 ? "service_unavailable" : "device_login_unsupported",
            describe(body) || `The server refused the sign-in request (${String(response.status)}).`,
            response.status,
        );
    }

    const { device_code: deviceCode, expires_in: expiresIn, interval, user_code: userCode, verification_uri: uri, verification_uri_complete: complete } = body;

    if (
        typeof deviceCode !== "string" ||
        typeof userCode !== "string" ||
        typeof uri !== "string" ||
        [userCode, uri, complete].some((value) => typeof value === "string" && CONTROL.test(value)) ||
        !isSeconds(expiresIn) ||
        (interval !== undefined && !isSeconds(interval))
    ) {
        throw failure("invalid_response", "The server answered the sign-in request in a form this CLI does not understand.", response.status);
    }

    return {
        deviceCode,
        expiresAtMs: dependencies.now() + Math.min(expiresIn * 1000, MAX_LIFETIME_MS),
        intervalMs: Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, (interval ?? 5) * 1000)),
        userCode,
        verificationUri: uri,
        verificationUriComplete: typeof complete === "string" ? complete : uri,
    };
};

/** `ABCDEFGH` -> `ABCD-EFGH`: easier to read aloud; the server ignores the dash. */
export const formatUserCode = (code: string): string => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

const expired = (): ApiError => failure("device_expired", "The code expired before it was approved. Run `neore login --device` to get a new one.", 0);

/** What a 4xx answer from the key route means: keep waiting, wait longer, or stop. */
const classify = (body: Body, status: number): ApiError | "pending" | "slow_down" => {
    switch (body["error"]) {
        case "access_denied": {
            return failure(
                "device_denied",
                `Sign-in was denied${describe(body) ? `: ${describe(body)}` : "."} Run \`neore login --device\` to try again.`,
                status,
            );
        }
        case "authorization_pending": {
            return "pending";
        }
        case "expired_token": {
            return expired();
        }
        case "invalid_grant": {
            return failure("device_code_invalid", "This code was already used or is not valid. Run `neore login --device` to get a new one.", status);
        }
        case "slow_down": {
            return "slow_down";
        }
        default: {
            return failure("device_login_unsupported", describe(body) || `The server refused the sign-in (${String(status)}).`, status);
        }
    }
};

/** Poll until the code is approved (resolves with the key), denied or expired (throws an `ApiError`). */
export const pollForKey = async (dependencies: DeviceFlowDependencies, baseUrl: string, code: DeviceCode): Promise<string> => {
    let { intervalMs } = code;
    let failures = 0;

    while (true) {
        await dependencies.sleep(intervalMs);

        // The wait itself may have crossed the deadline: report that, not whatever the next request meets.
        if (dependencies.now() >= code.expiresAtMs) {
            throw expired();
        }

        let response: Response;

        try {
            response = await post(dependencies, baseUrl, KEY_PATH, { client_id: CLIENT_ID, device_code: code.deviceCode });
        } catch (error) {
            failures += 1;

            if (failures >= MAX_CONSECUTIVE_FAILURES) {
                throw error;
            }

            continue;
        }

        const body = await readJson(response);

        if (response.ok) {
            const apiKey = body["api_key"];

            if (typeof apiKey !== "string" || apiKey.length === 0) {
                throw failure("invalid_response", "The server approved the sign-in but sent no key.", response.status);
            }

            return apiKey;
        }

        // The per-address limit or an outage: back off and keep going, up to a bound.
        if (response.status === 429 || response.status >= 500) {
            failures += 1;

            if (failures >= MAX_CONSECUTIVE_FAILURES) {
                throw response.status === 429
                    ? failure("rate_limited", "The server is limiting sign-in polls. Wait a minute and run `neore login --device` again.", 429)
                    : failure("service_unavailable", "The server is unavailable. Try again shortly.", response.status);
            }

            // Only a 429 means "slower"; raising the interval for an outage would slow every later poll.
            if (response.status === 429) {
                intervalMs = Math.min(MAX_INTERVAL_MS, intervalMs + SLOW_DOWN_STEP_MS);
            }

            continue;
        }

        failures = 0;

        const outcome = classify(body, response.status);

        if (outcome instanceof ApiError) {
            throw outcome;
        }

        if (outcome === "slow_down") {
            intervalMs = Math.min(MAX_INTERVAL_MS, intervalMs + SLOW_DOWN_STEP_MS);
        }
    }
};

/**
 * Best effort: ask the server to delete the key it just issued, for when this machine could not use it. Resolves
 * false on any failure, so the caller can say to revoke it in Settings.
 */
export const revokeIssuedKey = async (dependencies: DeviceFlowDependencies, baseUrl: string, apiKey: string): Promise<boolean> => {
    try {
        const response = await post(dependencies, baseUrl, REVOKE_PATH, { api_key: apiKey });

        await response.body?.cancel();

        return response.ok;
    } catch {
        return false;
    }
};
