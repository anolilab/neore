/**
 * Fallback Language Model — LanguageModelV3 that runs a call on the user's
 * backup model when the primary fails with an infrastructure error.
 *
 * Only the gateway's own classification counts (`error.fallbackReason`, see
 * `GatewayLanguageModel`): a content-policy or context-overflow failure would
 * fail the same way on another model chosen for its availability, and an
 * unclassified error (no field) is not known to be safe to retry.
 *
 * The retry is made only for a call that failed before it produced anything —
 * the rejection of `doGenerate()` / `doStream()` itself. Once a stream is
 * returned, the agent has consumed its parts and cannot be handed another reply.
 */
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult, LanguageModelV3StreamResult } from "@ai-sdk/provider";

/** Whether `error` is a gateway failure that another model could serve. */
export const isInfraFailure = (error: unknown): boolean =>
    typeof error === "object" && error !== null && (error as { fallbackReason?: unknown }).fallbackReason === "infra";

export class FallbackLanguageModel implements LanguageModelV3 {
    readonly specificationVersion = "v3" as const;

    readonly provider: string;

    readonly modelId: string;

    readonly supportedUrls: LanguageModelV3["supportedUrls"];

    private readonly primary: LanguageModelV3;

    private readonly backup: LanguageModelV3;

    constructor(primary: LanguageModelV3, backup: LanguageModelV3) {
        this.primary = primary;
        this.backup = backup;
        this.provider = primary.provider;
        this.modelId = primary.modelId;
        this.supportedUrls = primary.supportedUrls;
    }

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
        try {
            return await this.primary.doGenerate(options);
        } catch (error) {
            if (!this.shouldFallBack(error, options)) {
                throw error;
            }

            return await this.backup.doGenerate(options);
        }
    }

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        try {
            return await this.primary.doStream(options);
        } catch (error) {
            if (!this.shouldFallBack(error, options)) {
                throw error;
            }

            return await this.backup.doStream(options);
        }
    }

    /** A stopped run must not hop to the backup, whatever the error said. */
    private shouldFallBack(error: unknown, options: LanguageModelV3CallOptions): boolean {
        return isInfraFailure(error) && options.abortSignal?.aborted !== true;
    }
}
