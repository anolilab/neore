/**
 * Fallback Language Model — LanguageModelV3 that runs a call on the user's
 * backup model when the primary fails with an infrastructure error.
 *
 * Only the gateway's own classification counts (`error.fallbackReason`, see
 * `GatewayLanguageModel`): a content-policy or context-overflow failure would
 * fail the same way on another model chosen for its availability, and an
 * unclassified error (no field) is not known to be safe to retry.
 *
 * The retry is made only for a call that failed before it produced anything:
 * the rejection of `doGenerate()` / `doStream()` itself, or a stream that errors
 * before its first content part. Once a part has been handed on, the agent has
 * consumed it and cannot be handed another reply.
 *
 * `modelId` / `provider` follow the model that served the latest call, so the
 * message the agent persists names the model that wrote it.
 */
import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    LanguageModelV3GenerateResult,
    LanguageModelV3StreamPart,
    LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

import { streamLogger } from "../../lib/logger";

/** Whether `error` is a gateway failure that another model could serve. */
export const isInfraFailure = (error: unknown): boolean =>
    typeof error === "object" && error !== null && (error as { fallbackReason?: unknown }).fallbackReason === "infra";

export class FallbackLanguageModel implements LanguageModelV3 {
    readonly specificationVersion = "v3" as const;

    readonly supportedUrls: LanguageModelV3["supportedUrls"];

    private readonly primary: LanguageModelV3;

    private readonly backup: LanguageModelV3;

    private readonly backupSupportsTools: boolean;

    private active: LanguageModelV3;

    constructor(primary: LanguageModelV3, backup: LanguageModelV3, { backupSupportsTools = true }: { backupSupportsTools?: boolean } = {}) {
        this.primary = primary;
        this.backup = backup;
        this.backupSupportsTools = backupSupportsTools;
        this.active = primary;
        this.supportedUrls = primary.supportedUrls;
    }

    get provider(): string {
        return this.active.provider;
    }

    get modelId(): string {
        return this.active.modelId;
    }

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
        this.active = this.primary;

        try {
            return await this.primary.doGenerate(options);
        } catch (error) {
            if (!this.shouldFallBack(error, options)) {
                throw error;
            }

            this.switchToBackup(error);

            return await this.backup.doGenerate(options);
        }
    }

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        this.active = this.primary;

        let result: LanguageModelV3StreamResult;

        try {
            result = await this.primary.doStream(options);
        } catch (error) {
            if (!this.shouldFallBack(error, options)) {
                throw error;
            }

            this.switchToBackup(error);

            return await this.backup.doStream(options);
        }

        // The gateway reports a provider failure after its 200 as an error event, so look at the stream up to its first content part before committing to it.
        const reader = result.stream.getReader();
        const head: LanguageModelV3StreamPart[] = [];

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                head.push(value);

                if (value.type !== "stream-start") {
                    break;
                }
            }
        } catch (error) {
            if (!this.shouldFallBack(error, options)) {
                throw error;
            }

            this.switchToBackup(error);

            return await this.backup.doStream(options);
        }

        const stream = new ReadableStream<LanguageModelV3StreamPart>({
            cancel: (reason) => reader.cancel(reason),
            pull: async (controller) => {
                const buffered = head.shift();

                if (buffered) {
                    controller.enqueue(buffered);

                    return;
                }

                const { done, value } = await reader.read();

                if (done) {
                    controller.close();
                } else {
                    controller.enqueue(value);
                }
            },
        });

        return { ...result, stream };
    }

    /** A stopped run must not hop to the backup, whatever the error said, and a backup that cannot call tools cannot take a call that carries them. */
    private shouldFallBack(error: unknown, options: LanguageModelV3CallOptions): boolean {
        if (!isInfraFailure(error) || options.abortSignal?.aborted === true) {
            return false;
        }

        return this.backupSupportsTools || !options.tools?.length;
    }

    private switchToBackup(error: unknown): void {
        streamLogger.warn(`[FallbackModel] ${this.primary.modelId} failed with an infrastructure error, retrying on ${this.backup.modelId}:`, error);
        this.active = this.backup;
    }
}
