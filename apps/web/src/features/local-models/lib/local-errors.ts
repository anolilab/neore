/**
 * Why a browser → local model server request failed, told apart as far as a
 * browser allows.
 *
 * `fetch` rejects with the same opaque `TypeError: Failed to fetch` for a
 * refused connection, a CORS rejection, a mixed-content block and a denied
 * local-network permission — by design, so a page cannot port-scan. Three
 * extra signals separate the cases that matter for the fix:
 *
 * - a follow-up `mode: "no-cors"` probe (`reachableWithoutCors`): it resolves
 *   with an opaque response whenever SOMETHING answered on that port, so a
 *   CORS-only failure is "reachable" and a refused connection is not;
 * - Chrome's Local Network Access permission (`localNetworkPermission`), which
 *   a public site needs before it may reach loopback at all;
 * - the browser engine: WebKit (Safari) still applies
 *   `upgrade-insecure-requests` to loopback and treats `http://localhost` from
 *   an https page as mixed content, which Chromium and Firefox exempt.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { LocalStreamError } from "./openai-sse";

export type LocalErrorKind =
    "aborted" | "cors" | "http" | "mixed-content" | "not-found" | "permission-denied" | "stream" | "timeout" | "unknown" | "unreachable";

export interface LocalErrorInfo {
    /** The server's own message (an `{ error }` body or stream error), when it sent one. */
    detail?: string;
    kind: LocalErrorKind;
    status?: number;
}

/** Thrown by the local client for a non-2xx answer, carrying the server's `{ error }` text. */
export class LocalHttpError extends Error {
    public readonly status: number;

    public constructor(status: number, detail: string | undefined) {
        super(detail || `HTTP ${status}`);
        this.name = "LocalHttpError";
        this.status = status;
    }
}

export interface ClassifyContext {
    endpointUrl: string;
    /** `navigator.permissions` state for `local-network-access`, where the browser has it. */
    localNetworkPermission?: PermissionState;
    /** `location.protocol` of the app page. */
    pageProtocol: string;
    /** Result of the `no-cors` follow-up probe; `undefined` when it was not run. */
    reachableWithoutCors?: boolean;
    userAgent?: string;
}

const SAFARI_RE = /^(?:(?!chrome|chromium|crios|edg|android|firefox|fxios).)*safari/iu;

/** WebKit on desktop — the one engine that still blocks/upgrades `http://localhost` from https. */
export const isSafariUserAgent = (userAgent: string | undefined): boolean => Boolean(userAgent && SAFARI_RE.test(userAgent));

const errorName = (error: unknown): string | undefined => (error && typeof error === "object" && "name" in error ? String(error.name) : undefined);

export const classifyLocalError = (error: unknown, context: ClassifyContext): LocalErrorInfo => {
    const name = errorName(error);

    if (name === "TimeoutError") {
        return { kind: "timeout" };
    }

    if (name === "AbortError") {
        return { kind: "aborted" };
    }

    if (error instanceof LocalHttpError) {
        return { detail: error.message, kind: error.status === 404 ? "not-found" : "http", status: error.status };
    }

    if (error instanceof LocalStreamError) {
        return { detail: error.message, kind: "stream" };
    }

    // Everything below is the opaque network TypeError.
    if (!(error instanceof TypeError)) {
        return { detail: error instanceof Error ? error.message : undefined, kind: "unknown" };
    }

    let endpointProtocol: string | undefined;

    try {
        endpointProtocol = new URL(context.endpointUrl).protocol;
    } catch {
        endpointProtocol = undefined;
    }

    if (context.pageProtocol === "https:" && endpointProtocol === "http:" && isSafariUserAgent(context.userAgent)) {
        return { kind: "mixed-content" };
    }

    if (context.localNetworkPermission === "denied") {
        return { kind: "permission-denied" };
    }

    if (context.reachableWithoutCors === true) {
        return { kind: "cors" };
    }

    return { kind: "unreachable" };
};

/**
 * `mode: "no-cors"` GET to the endpoint's origin. Resolves `true` when anything
 * answered (the opaque response hides what), `false` when the connection
 * itself failed. Never throws.
 */
export const probeReachableWithoutCors = async (endpointUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 3000): Promise<boolean> => {
    try {
        const response = await fetchImpl(new URL(endpointUrl).origin, { cache: "no-store", mode: "no-cors", signal: AbortSignal.timeout(timeoutMs) });

        // Opaque: nothing to read, but release the connection.
        await response.body?.cancel();

        return true;
    } catch {
        return false;
    }
};

/** Chrome's Local Network Access permission, where queryable. `undefined` elsewhere. */
export const queryLocalNetworkPermission = async (): Promise<PermissionState | undefined> => {
    try {
        // Not in TypeScript's PermissionName union yet (Chrome 142+).
        const status = await navigator.permissions.query({ name: "local-network-access" as PermissionName });

        return status.state;
    } catch {
        return undefined;
    }
};

/** Classify with every signal the browser can give — the one call UI code makes. */
export const diagnoseLocalError = async (error: unknown, endpointUrl: string): Promise<LocalErrorInfo> => {
    if (!(error instanceof TypeError)) {
        return classifyLocalError(error, { endpointUrl, pageProtocol: globalThis.location?.protocol ?? "https:" });
    }

    const [reachableWithoutCors, localNetworkPermission] = await Promise.all([probeReachableWithoutCors(endpointUrl), queryLocalNetworkPermission()]);

    return classifyLocalError(error, {
        endpointUrl,
        localNetworkPermission,
        pageProtocol: globalThis.location?.protocol ?? "https:",
        reachableWithoutCors,
        userAgent: globalThis.navigator?.userAgent,
    });
};

/** A one-line explanation; the setup guide carries the commands. */
export const describeLocalError = (info: LocalErrorInfo): MessageDescriptor => {
    switch (info.kind) {
        case "aborted": {
            return msg`Stopped.`;
        }
        case "cors": {
            return msg`Your local server answered, but refused this site (CORS). Allow this site's origin — for Ollama set OLLAMA_ORIGINS, for LM Studio turn on "Enable CORS" — then restart the server.`;
        }
        case "http": {
            return info.detail
                ? msg`The local server answered HTTP ${info.status ?? 0}: ${info.detail}`
                : msg`The local server answered HTTP ${info.status ?? 0}.`;
        }
        case "mixed-content": {
            return msg`Safari blocks this secure page from calling http://localhost. Use Chrome, Edge or Firefox for local models.`;
        }
        case "not-found": {
            return msg`The local server does not have this model. Pull it first (Ollama: ollama pull <model>) or pick another one.`;
        }
        case "permission-denied": {
            return msg`Your browser blocked access to local network devices for this site. Allow "Local network access" in the site settings (the icon left of the address bar), then try again.`;
        }
        case "stream": {
            return info.detail ? msg`The local model reported an error: ${info.detail}` : msg`The local model reported an error.`;
        }
        case "timeout": {
            return msg`The local server did not answer in time. Is it still loading the model?`;
        }
        case "unreachable": {
            return msg`Nothing is listening at that address. Start Ollama or LM Studio's server, check the port, and make sure the URL ends in /v1.`;
        }
        default: {
            return info.detail ? msg`Local request failed: ${info.detail}` : msg`Local request failed.`;
        }
    }
};
