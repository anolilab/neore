/**
 * Cloudflare Queue consumer for video render jobs.
 *
 * Producer: POST `/v1/videos` in `routes/v1/video.ts` enqueues a
 * `VideoRenderMessage`. We consume here, run the render through the pure
 * `runVideoRender` core, and decide ack-vs-retry from the structured
 * `RenderOutcome`.
 *
 * Each message gets its own `RequestTelemetry` + CONSUMER-kind root span,
 * adopted from the producer's `traceparent` so render spans link into the
 * originating request's trace. Spans/metrics flush via `ctx.waitUntil()`.
 *
 * Retry policy:
 *   - `completed` / `skipped`              → ack
 *   - `failed` + transient + attempts left → retry with backoff (job stays
 *                                            `in_progress` for the next try)
 *   - `failed` + terminal                  → ack (`runVideoRender` already
 *                                            wrote `failed` state)
 *   - `failed` + retries exhausted         → ack, but persist `failed`
 *                                            ourselves via `markRenderFailed`
 *                                            because the render core leaves
 *                                            the row as `in_progress` for
 *                                            transient errors and would
 *                                            otherwise rely on the 10-min
 *                                            stall reaper to clean up.
 *
 * DLQ messages land here too (different queue name) — we emit a CONSUMER
 * span + counter so on-call has metrics + a trace link back to the
 * originating request, then ack so the queue stops redelivering.
 */
import type { AppEnv } from "../env.js";
import { createQueueMessageTelemetry } from "../lib/otel/index.js";
import { markRenderFailed, runVideoRender } from "../routes/v1/video-render.js";
import type { VideoRenderMessage } from "../routes/v1/video-types.js";
import { VIDEO_RENDER_MESSAGE_VERSION } from "../routes/v1/video-types.js";

/**
 * Maximum delivery attempts before we stop retrying and let the message land
 * in the DLQ. MUST stay aligned with `maxRetries` in the Worker's
 * `eventSources` configuration (see alchemy.run.ts) — Alchemy's value is the
 * retry count on top of the initial delivery, so `maxRetries: 2 ↔ MAX_ATTEMPTS = 3`.
 * A mismatch silently drops messages on the final attempt before the DLQ
 * kicks in.
 */
export const VIDEO_RENDER_MAX_ATTEMPTS = 3;

/** Backoff (seconds) before redelivery. Provider transient errors usually clear in &lt;1 min. */
export const VIDEO_RENDER_RETRY_DELAY_SECONDS = 60;

/**
 * Queue name suffix used to recognise the DLQ vs the primary queue. Alchemy
 * names these `llm-gateway-video-renders` and `llm-gateway-video-renders-dlq`
 * across stages.
 */
const DLQ_SUFFIX = "-dlq";

export const handleVideoRenderBatch = async (batch: MessageBatch<VideoRenderMessage>, env: AppEnv, context: ExecutionContext): Promise<void> => {
    const isDlq = batch.queue.endsWith(DLQ_SUFFIX);

    for (const message of batch.messages) {
        if (isDlq) {
            handleDlqMessage(message, batch.queue, env, context);
            message.ack();
            continue;
        }

        await handleRenderMessage(message, batch.queue, env, context);
    }
};

const handleRenderMessage = async (message: Message<VideoRenderMessage>, queueName: string, env: AppEnv, context: ExecutionContext): Promise<void> => {
    const { body } = message;

    // Version gate: reject messages whose envelope version we don't
    // recognise. A future schema bump must not silently corrupt in-flight
    // renders; explicit drop + telemetry is safer than guessing at fields.
    if (body?._version !== VIDEO_RENDER_MESSAGE_VERSION) {
        handleVersionMismatch(message, queueName, env, context);
        message.ack();

        return;
    }

    const { rootSpan, telemetry } = createQueueMessageTelemetry(
        env,
        { attempts: message.attempts, messageId: message.id, queueName },
        "video.render",
        {
            "messaging.message.enqueued_unix": body.enqueuedAt,
            "video.is_byok": body.isByok,
            // Identifiers safe for tracing backends. User ID intentionally
            // omitted — exporting it would leak per-user identity to OTEL
            // vendors. The trace's parent span (HTTP server span) already
            // carries the auth context if a backend operator needs to
            // correlate.
            "video.job_id": body.jobId,
            "video.model_api_id": body.modelInfo.modelApiId,
            "video.model_id": body.body.model,
            "video.provider": body.modelInfo.provider,
        },
        body.parentTraceparent,
    );

    const startMs = Date.now();
    const queueLatencyMs = startMs - body.enqueuedAt;

    telemetry.recordHistogram(
        "gateway.video.queue_latency",
        queueLatencyMs,
        { "video.model_id": body.body.model, "video.provider": body.modelInfo.provider },
        "ms",
    );

    let outcomeStatus: "completed" | "skipped" | "retried" | "failed" = "failed";
    let renderError: Error | undefined;

    try {
        const outcome = await runVideoRender(body, env, telemetry);

        if (outcome.kind === "completed") {
            outcomeStatus = "completed";
            message.ack();

            telemetry.recordHistogram(
                "gateway.video.render_duration_ms",
                outcome.latencyMs,
                { "video.model_id": body.body.model, "video.provider": body.modelInfo.provider },
                "ms",
            );
        } else if (outcome.kind === "skipped") {
            outcomeStatus = "skipped";
            message.ack();
        } else {
            // outcome.kind === "failed"
            renderError = new Error(outcome.errorMessage);

            const isAttemptsLeft = message.attempts < VIDEO_RENDER_MAX_ATTEMPTS;

            if (isAttemptsLeft && outcome.retryable) {
                outcomeStatus = "retried";
                message.retry({ delaySeconds: VIDEO_RENDER_RETRY_DELAY_SECONDS });
            } else {
                // `outcomeStatus` is already "failed" — its initial value.

                // Transient errors leave the job `in_progress` in the render
                // core (so a retry can resume); when we decide to stop
                // retrying, we must persist the terminal state ourselves.
                // Non-retryable errors were already finalised inside
                // `runVideoRender` — `markRenderFailed` no-ops on an
                // already-terminal row.
                if (outcome.retryable) {
                    await markRenderFailed(env, body, `${outcome.errorMessage} (retries exhausted after ${message.attempts} attempts)`).catch((error) =>
                        console.error("[video] failed to finalise render after retries exhausted:", error),
                    );
                }

                message.ack();
            }
        }
    } catch (error) {
        // `runVideoRender` is supposed to swallow its own errors and return a
        // structured outcome. Reaching this catch means something inside the
        // wrapper itself threw (e.g. KV read rejected before render started).
        // Retry up to the cap; on the final attempt persist failed state
        // because the render core never got a chance to.
        renderError = error instanceof Error ? error : new Error(String(error));

        if (message.attempts < VIDEO_RENDER_MAX_ATTEMPTS) {
            outcomeStatus = "retried";
            message.retry({ delaySeconds: VIDEO_RENDER_RETRY_DELAY_SECONDS });
        } else {
            outcomeStatus = "failed";
            await markRenderFailed(env, body, `Consumer error: ${renderError.message}`).catch(() => {});
            message.ack();
        }
    } finally {
        telemetry.endSpan(rootSpan, {
            attributes: {
                "messaging.message.delivery.attempts": message.attempts,
                "video.outcome": outcomeStatus,
            },
            error: renderError,
        });

        telemetry.recordCounter(
            "gateway.video.renders_total",
            1,
            {
                "video.model_id": body.body.model,
                "video.outcome": outcomeStatus,
                "video.provider": body.modelInfo.provider,
            },
            "1",
        );

        context.waitUntil(telemetry.flush());
    }
};

/**
 * Telemetry-only handler for version-mismatch poison messages. We can't
 * inspect the body, but we still want a counter + a span so the DLQ
 * dashboard tells the operator what's going on. Caller acks the message
 * after this returns.
 */
const handleVersionMismatch = (message: Message<VideoRenderMessage>, queueName: string, env: AppEnv, context: ExecutionContext): void => {
    const got = (message.body as { _version?: unknown } | undefined)?._version;

    console.error("[video] dropping render message with unsupported envelope version", {
        attempts: message.attempts,
        expected: VIDEO_RENDER_MESSAGE_VERSION,
        got,
        messageId: message.id,
        queue: queueName,
    });

    const { rootSpan, telemetry } = createQueueMessageTelemetry(
        env,
        { attempts: message.attempts, messageId: message.id, queueName },
        "video.render.version_mismatch",
        {
            "video.version.expected": VIDEO_RENDER_MESSAGE_VERSION,
            "video.version.got": typeof got === "number" ? got : null,
        },
        undefined,
    );

    telemetry.recordCounter("gateway.video.version_mismatch_total", 1, {}, "1");
    telemetry.endSpan(rootSpan, { error: new Error("Unsupported VideoRenderMessage envelope version") });

    context.waitUntil(telemetry.flush());
};

/**
 * DLQ handler — messages here have already exhausted the main queue's retry
 * budget. We have no recovery path, so just emit a counter + CONSUMER span
 * linked to the original trace so dashboards can alert on DLQ growth, and
 * the persisted job row (written by `markRenderFailed` on the last attempt)
 * remains the authoritative failure record.
 */
const handleDlqMessage = (message: Message<VideoRenderMessage>, queueName: string, env: AppEnv, context: ExecutionContext): void => {
    const { body } = message;

    console.error(`[video-dlq] giving up on job ${body?.jobId ?? "<unknown>"} after ${message.attempts} attempts on ${queueName}`, {
        messageId: message.id,
        model: body?.body?.model,
        provider: body?.modelInfo?.provider,
    });

    const { rootSpan, telemetry } = createQueueMessageTelemetry(
        env,
        { attempts: message.attempts, messageId: message.id, queueName },
        "video.render.dlq",
        {
            "messaging.dead_letter": true,
            "video.job_id": body?.jobId,
            "video.model_id": body?.body?.model,
            "video.provider": body?.modelInfo?.provider,
        },
        body?.parentTraceparent,
    );

    telemetry.recordCounter(
        "gateway.video.dlq_total",
        1,
        {
            "video.model_id": body?.body?.model ?? "unknown",
            "video.provider": body?.modelInfo?.provider ?? "unknown",
        },
        "1",
    );

    telemetry.endSpan(rootSpan, {
        error: new Error(`Render exhausted retries after ${message.attempts} attempts`),
    });

    context.waitUntil(telemetry.flush());
};
