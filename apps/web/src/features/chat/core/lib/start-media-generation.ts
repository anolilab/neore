/**
 * Kicks off image/audio/video generation for a reply `/v1/chat` already
 * created. `fetch` does not reject on 4xx/5xx, so a refusal (the 403 daily
 * limit, a 401, a 404) is read from `response.ok` and handed back as a result
 * for the caller to show. Nothing is retried here.
 */

import { fetchWithDeadline } from "./fetch-with-deadline";

/** The refusal body: most failures are `{ error, message }`, a rate limit nests them under `error`. */
interface MediaRefusalBody {
    error?: string | { code?: string; message?: string; retryAfter?: number };
    message?: string;
    retryAfter?: number;
}

export type MediaGenerationFailure =
    /** The request never got an answer (offline, DNS, CORS, abort, deadline). */
    | { cause: unknown; kind: "network"; ok: false }
    /** The server answered with a non-2xx status. */
    | { code?: string; kind: "refused"; message?: string; ok: false; retryAfter?: number; status: number };

export type MediaGenerationResult = MediaGenerationFailure | { ok: true };

interface StartMediaGenerationRequest {
    /** The JSON body, already carrying any unlock proof. */
    body: unknown;
    /** The auth header, read at call time. */
    headers: Record<string, string>;
    url: string;
}

const readRefusal = async (response: Response): Promise<MediaGenerationFailure> => {
    const body = (await response.json().catch(() => {
        return {};
    })) as MediaRefusalBody | null;
    const nested = typeof body?.error === "object" && body.error !== null ? body.error : undefined;
    const code = typeof body?.error === "string" ? body.error : nested?.code;

    return {
        code,
        kind: "refused",
        message: body?.message || nested?.message,
        ok: false,
        retryAfter: body?.retryAfter ?? nested?.retryAfter,
        status: response.status,
    };
};

export const startMediaGeneration = async (request: StartMediaGenerationRequest): Promise<MediaGenerationResult> => {
    let response: Response;

    try {
        response = await fetchWithDeadline(request.url, {
            body: JSON.stringify(request.body),
            headers: { "Content-Type": "application/json", ...request.headers },
            method: "POST",
        });
    } catch (error) {
        return { cause: error, kind: "network", ok: false };
    }

    if (response.ok) {
        return { ok: true };
    }

    return readRefusal(response);
};
