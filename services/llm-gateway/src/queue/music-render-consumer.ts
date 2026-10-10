/**
 * Cloudflare Queue consumer for music render jobs.
 *
 * Mirrors `video-render-consumer.ts` (see that module for the full retry
 * rationale). The only music-specific differences are the queue name
 * suffix and the telemetry attribute namespace.
 */
import type { AppEnv } from "../env.js";
import { createQueueMessageTelemetry } from "../lib/otel/index.js";
import { markRenderFailed, runMusicRender } from "../routes/v1/music-render.js";
import type { MusicRenderMessage } from "../routes/v1/music-types.js";
import { MUSIC_RENDER_MESSAGE_VERSION } from "../routes/v1/music-types.js";

/**
 * Maximum delivery attempts before a message lands in the DLQ. Must stay
 * aligned with `maxRetries` in alchemy.run.ts (`maxRetries: 2 ↔ MAX_ATTEMPTS = 3`).
 * A mismatch silently drops messages on the final attempt before the DLQ
 * kicks in.
 */
export const MUSIC_RENDER_MAX_ATTEMPTS = 3;

/** Backoff (seconds) before redelivery. */
export const MUSIC_RENDER_RETRY_DELAY_SECONDS = 30;

const DLQ_SUFFIX = "-dlq";

export const handleMusicRenderBatch = async (batch: MessageBatch<MusicRenderMessage>, env: AppEnv, context: ExecutionContext): Promise<void> => {
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

const handleRenderMessage = async (message: Message<MusicRenderMessage>, queueName: string, env: AppEnv, context: ExecutionContext): Promise<void> => {
    const { body } = message;

    if (body?._version !== MUSIC_RENDER_MESSAGE_VERSION) {
        handleVersionMismatch(message, queueName, env, context);
        message.ack();

        return;
    }

    const { rootSpan, telemetry } = createQueueMessageTelemetry(
        env,
        { attempts: message.attempts, messageId: message.id, queueName },
        "music.render",
        {
            "messaging.message.enqueued_unix": body.enqueuedAt,
            "music.is_byok": body.isByok,
            "music.job_id": body.jobId,
            "music.model_api_id": body.modelInfo.modelApiId,
            "music.model_id": body.body.model,
            "music.provider": body.modelInfo.provider,
        },
        body.parentTraceparent,
    );

    const startMs = Date.now();
    const queueLatencyMs = startMs - body.enqueuedAt;

    telemetry.recordHistogram(
        "gateway.music.queue_latency",
        queueLatencyMs,
        { "music.model_id": body.body.model, "music.provider": body.modelInfo.provider },
        "ms",
    );

    let outcomeStatus: "completed" | "skipped" | "retried" | "failed" = "failed";
    let renderError: Error | undefined;

    try {
        const outcome = await runMusicRender(body, env, telemetry);

        if (outcome.kind === "completed") {
            outcomeStatus = "completed";
            message.ack();

            telemetry.recordHistogram(
                "gateway.music.render_duration_ms",
                outcome.latencyMs,
                { "music.model_id": body.body.model, "music.provider": body.modelInfo.provider },
                "ms",
            );
        } else if (outcome.kind === "skipped") {
            outcomeStatus = "skipped";
            message.ack();
        } else {
            renderError = new Error(outcome.errorMessage);

            const isAttemptsLeft = message.attempts < MUSIC_RENDER_MAX_ATTEMPTS;

            if (isAttemptsLeft && outcome.retryable) {
                outcomeStatus = "retried";
                message.retry({ delaySeconds: MUSIC_RENDER_RETRY_DELAY_SECONDS });
            } else {
                // `outcomeStatus` is already "failed" — its initial value.

                if (outcome.retryable) {
                    await markRenderFailed(env, body, `${outcome.errorMessage} (retries exhausted after ${message.attempts} attempts)`).catch((error) =>
                        console.error("[music] failed to finalise render after retries exhausted:", error),
                    );
                }

                message.ack();
            }
        }
    } catch (error) {
        renderError = error instanceof Error ? error : new Error(String(error));

        if (message.attempts < MUSIC_RENDER_MAX_ATTEMPTS) {
            outcomeStatus = "retried";
            message.retry({ delaySeconds: MUSIC_RENDER_RETRY_DELAY_SECONDS });
        } else {
            outcomeStatus = "failed";
            await markRenderFailed(env, body, `Consumer error: ${renderError.message}`).catch(() => {});
            message.ack();
        }
    } finally {
        telemetry.endSpan(rootSpan, {
            attributes: {
                "messaging.message.delivery.attempts": message.attempts,
                "music.outcome": outcomeStatus,
            },
            error: renderError,
        });

        telemetry.recordCounter(
            "gateway.music.renders_total",
            1,
            {
                "music.model_id": body.body.model,
                "music.outcome": outcomeStatus,
                "music.provider": body.modelInfo.provider,
            },
            "1",
        );

        context.waitUntil(telemetry.flush());
    }
};

const handleVersionMismatch = (message: Message<MusicRenderMessage>, queueName: string, env: AppEnv, context: ExecutionContext): void => {
    const got = (message.body as { _version?: unknown } | undefined)?._version;

    console.error("[music] dropping render message with unsupported envelope version", {
        attempts: message.attempts,
        expected: MUSIC_RENDER_MESSAGE_VERSION,
        got,
        messageId: message.id,
        queue: queueName,
    });

    const { rootSpan, telemetry } = createQueueMessageTelemetry(
        env,
        { attempts: message.attempts, messageId: message.id, queueName },
        "music.render.version_mismatch",
        {
            "music.version.expected": MUSIC_RENDER_MESSAGE_VERSION,
            "music.version.got": typeof got === "number" ? got : null,
        },
        undefined,
    );

    telemetry.recordCounter("gateway.music.version_mismatch_total", 1, {}, "1");
    telemetry.endSpan(rootSpan, { error: new Error("Unsupported MusicRenderMessage envelope version") });

    context.waitUntil(telemetry.flush());
};

const handleDlqMessage = (message: Message<MusicRenderMessage>, queueName: string, env: AppEnv, context: ExecutionContext): void => {
    const { body } = message;

    console.error(`[music-dlq] giving up on job ${body?.jobId ?? "<unknown>"} after ${message.attempts} attempts on ${queueName}`, {
        messageId: message.id,
        model: body?.body?.model,
        provider: body?.modelInfo?.provider,
    });

    const { rootSpan, telemetry } = createQueueMessageTelemetry(
        env,
        { attempts: message.attempts, messageId: message.id, queueName },
        "music.render.dlq",
        {
            "messaging.dead_letter": true,
            "music.job_id": body?.jobId,
            "music.model_id": body?.body?.model,
            "music.provider": body?.modelInfo?.provider,
        },
        body?.parentTraceparent,
    );

    telemetry.recordCounter(
        "gateway.music.dlq_total",
        1,
        {
            "music.model_id": body?.body?.model ?? "unknown",
            "music.provider": body?.modelInfo?.provider ?? "unknown",
        },
        "1",
    );

    telemetry.endSpan(rootSpan, {
        error: new Error(`Render exhausted retries after ${message.attempts} attempts`),
    });

    context.waitUntil(telemetry.flush());
};
