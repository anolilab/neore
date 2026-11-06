/**
 * `neore login --device`: sign in by code.
 *
 * The CLI asks the backend for a device code, shows the person a URL and a
 * short code, and polls until the code is approved in the web app, denied or
 * expired. It never opens a browser and never listens on a port, so it works
 * over SSH. On approval the backend answers once with an API key.
 *
 * The wire format is the OAuth device grant's (RFC 8628): errors are
 * `{ error, error_description }` with a string `error`, which is NOT
 * the shape `errorFromResponse` reads for `/api/v1`, so this file parses its
 * own. Failures become `ApiError`s with codes of their own, so `--json` output
 * and the exit codes (`exitCodeFor`) branch on the code, not on message text:
 *
 * - `device_denied`, `device_expired`, `device_code_invalid` and `device_login_unsupported` exit 1 (sign-in failed)
 * - `rate_limited` exits 5, `network_error` and `service_unavailable` exit 6
 */
import { ApiError, stripTrailingSlashes } from "./client";

const CODE_PATH = "/api/auth/device/code";

const KEY_PATH = "/api/auth/device/key";

/** The client id the backend accepts for the CLI. */
export const CLI_CLIENT_ID = "neore-cli";

/** Per-request deadline for the short calls this flow makes. */
const REQUEST_TIMEOUT_MS = 15_000;

/** RFC 8628 3.5: on `slow_down`, wait this much longer from then on. */
const SLOW_DOWN_STEP_MS = 5000;

/** Consecutive transport / 5xx / 429 answers tolerated while polling before giving up. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** The lower bound on the poll interval, whatever the server says. */
const MIN_INTERVAL_MS = 1000;

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

export interface DeviceKey {
    apiKey: string;
    /** Epoch ms, or `null` for a key that does not expire. */
    expiresAt: number | null;
}

interface OAuthBody {
    error?: unknown;
    error_description?: unknown;
}

const readJson = async (response: Response): Promise<OAuthBody & Record<string, unknown>> => {
    try {
        const body = (await response.json()) as unknown;

        return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    } catch {
        return {};
    }
};

const post = async (dependencies: DeviceFlowDependencies, baseUrl: string, path: string, body: unknown): Promise<Response> => {
    try {
        return await dependencies.fetch(`${stripTrailingSlashes(baseUrl)}${path}`, {
            body: JSON.stringify(body),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "POST",
            // A 307/308 would replay the code to another origin; the person confirmed THIS host only.
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

const describe = (body: OAuthBody): string => (typeof body.error_description === "string" ? body.error_description : "");

/** Ask for a code. `hostname` is shown to the person approving, as plain text. */
export const requestDeviceCode = async (dependencies: DeviceFlowDependencies, baseUrl: string, hostname: string): Promise<DeviceCode> => {
    const response = await post(dependencies, baseUrl, CODE_PATH, { client_id: CLI_CLIENT_ID, hostname });
    const body = await readJson(response);

    if (!response.ok) {
        if (response.status === 404) {
            throw new ApiError({
                code: "device_login_unsupported",
                message: "This server does not offer sign-in by code. Create an API key in Settings -> API keys and run `neore login`.",
                status: 404,
            });
        }

        if (response.status === 429) {
            throw new ApiError({ code: "rate_limited", message: "Too many sign-in attempts. Wait a minute and try again.", status: 429 });
        }

        throw new ApiError({
            code: response.status >= 500 ? "service_unavailable" : "device_login_unsupported",
            message: describe(body) || `The server refused the sign-in request (${String(response.status)}).`,
            status: response.status,
        });
    }

    const { device_code: deviceCode, expires_in: expiresIn, interval, user_code: userCode, verification_uri: uri, verification_uri_complete: complete } = body;

    const isTiming = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value * 1000) && value > 0;

    if (
        typeof deviceCode !== "string" ||
        typeof userCode !== "string" ||
        typeof uri !== "string" ||
        !isTiming(expiresIn) ||
        (interval !== undefined && !isTiming(interval))
    ) {
        throw new ApiError({
            code: "invalid_response",
            message: "The server answered the sign-in request in a form this CLI does not understand.",
            status: response.status,
        });
    }

    return {
        deviceCode,
        expiresAtMs: dependencies.now() + expiresIn * 1000,
        intervalMs: Math.max(MIN_INTERVAL_MS, (isTiming(interval) ? interval : 5) * 1000),
        userCode,
        verificationUri: uri,
        verificationUriComplete: typeof complete === "string" ? complete : uri,
    };
};

/** `ABCDEFGH` -> `ABCD-EFGH`, easier to read aloud and to type; the server ignores the dash. */
export const formatUserCode = (code: string): string => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

const expired = (): ApiError =>
    new ApiError({ code: "device_expired", message: "The code expired before it was approved. Run `neore login --device` to get a new one.", status: 0 });

/** What a 4xx answer from the key route means: keep waiting, wait longer, or stop with an error. */
const classify = (body: OAuthBody, status: number): ApiError | "pending" | "slow_down" => {
    switch (body.error) {
        case "access_denied": {
            return new ApiError({
                code: "device_denied",
                message: `Sign-in was denied${describe(body) ? `: ${describe(body)}` : "."} Run \`neore login --device\` to try again.`,
                status,
            });
        }
        case "authorization_pending": {
            return "pending";
        }
        case "expired_token": {
            return expired();
        }
        case "invalid_grant": {
            return new ApiError({
                code: "device_code_invalid",
                message: "This code was already used or is not valid. Run `neore login --device` to get a new one.",
                status,
            });
        }
        case "slow_down": {
            return "slow_down";
        }
        default: {
            return new ApiError({ code: "device_login_unsupported", message: describe(body) || `The server refused the sign-in (${String(status)}).`, status });
        }
    }
};

/**
 * Poll until the code is approved, denied or expired. Resolves with the key;
 * throws an `ApiError` otherwise. The waits go through `deps.sleep` and the
 * clock through `deps.now`, so a test runs it without real time.
 */
export const pollForKey = async (dependencies: DeviceFlowDependencies, baseUrl: string, code: DeviceCode, signal?: AbortSignal): Promise<DeviceKey> => {
    let { intervalMs } = code;
    let failures = 0;

    while (true) {
        if (signal?.aborted) {
            throw new ApiError({ code: "device_cancelled", message: "Sign-in cancelled.", status: 0 });
        }

        if (dependencies.now() >= code.expiresAtMs) {
            throw expired();
        }

        await dependencies.sleep(intervalMs);

        // The wait itself may have crossed the deadline: report that, not whatever the next request meets.
        if (dependencies.now() >= code.expiresAtMs) {
            throw expired();
        }

        let response: Response;

        try {
            response = await post(dependencies, baseUrl, KEY_PATH, { client_id: CLI_CLIENT_ID, device_code: code.deviceCode });
        } catch (error) {
            failures += 1;

            if (failures >= MAX_CONSECUTIVE_FAILURES) {
                throw error;
            }

            continue;
        }

        const body = await readJson(response);

        if (response.ok) {
            const { api_key: apiKey, expires_at: expiresAt } = body;

            if (typeof apiKey !== "string" || apiKey.length === 0) {
                throw new ApiError({ code: "invalid_response", message: "The server approved the sign-in but sent no key.", status: response.status });
            }

            return { apiKey, expiresAt: typeof expiresAt === "number" ? expiresAt : null };
        }

        // A proxy's 5xx page or the per-address limit: back off and keep going, up to a bound.
        if (response.status === 429 || response.status >= 500) {
            failures += 1;

            if (failures >= MAX_CONSECUTIVE_FAILURES) {
                throw new ApiError({
                    code: response.status === 429 ? "rate_limited" : "service_unavailable",
                    message:
                        response.status === 429
                            ? "The server is limiting sign-in polls. Wait a minute and run `neore login --device` again."
                            : "The server is unavailable. Try again shortly.",
                    status: response.status,
                });
            }

            intervalMs += SLOW_DOWN_STEP_MS;
            continue;
        }

        failures = 0;

        const outcome = classify(body, response.status);

        if (outcome instanceof ApiError) {
            throw outcome;
        }

        if (outcome === "slow_down") {
            intervalMs += SLOW_DOWN_STEP_MS;
        }
    }
};
