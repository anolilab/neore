/**
 * Server errors to PostHog Error Tracking — the same project the web app reports
 * to. Lunora's `webhookSink` hands us every failed RPC (worker side) and every
 * `ctx.log` line (shard side), each with the thrown error's real name, message
 * and stack; this keeps an RPC that failed with a 5xx (a 4xx is the caller's
 * mistake, not ours) and a log line that carried an error, as one `$exception`
 * capture each (lunora docs: concepts/error-tracking).
 *
 * Without `POSTHOG_API_KEY` there is no sink, and nothing is sent.
 */
import type { ObservabilitySink, ReportedError } from "lunorash/runtime";
import { parseStackFrames, webhookSink } from "lunorash/runtime";

const DEFAULT_HOST = "https://eu.i.posthog.com";
const TRAILING_SLASH = /\/$/u;

interface PostHogEnv {
    ENVIRONMENT?: string;
    POSTHOG_API_KEY?: string;
    POSTHOG_HOST?: string;
}

export const posthogErrorSink = (env: PostHogEnv): ObservabilitySink | undefined => {
    const apiKey = env.POSTHOG_API_KEY?.trim();

    if (!apiKey) {
        return undefined;
    }

    const capture = (error: ReportedError, properties: { code?: string; function_path: string; shard_key?: string; trace_id?: string }, userId?: string) => {
        return {
            api_key: apiKey,
            distinct_id: userId ?? "neore-backend",
            event: "$exception",
            properties: {
                ...properties,
                $exception_level: "error",
                $exception_list: [
                    {
                        mechanism: { handled: false, synthetic: false },
                        stacktrace: {
                            frames: parseStackFrames(error.stack).map((frame) => {
                                return { ...frame, lang: "javascript", platform: "custom" };
                            }),
                            type: "raw",
                        },
                        type: error.name ?? error.code ?? "Error",
                        value: error.message,
                    },
                ],
                // Server-side: no person profile for a capture without a user.
                ...(userId === undefined && { $process_person_profile: false }),
                environment: env.ENVIRONMENT ?? "unknown",
                source: "backend",
            },
        };
    };

    return webhookSink({
        transform: (event) =>
            event.error && event.error.status >= 500
                ? capture(event.error, { code: event.error.code, function_path: event.functionPath, trace_id: event.traceId })
                : null,
        transformLog: (event) =>
            event.error ? capture(event.error, { function_path: event.functionPath, shard_key: event.shardKey, trace_id: event.traceId }, event.userId) : null,
        url: `${(env.POSTHOG_HOST?.trim() || DEFAULT_HOST).replace(TRAILING_SLASH, "")}/i/v0/e/`,
    });
};
