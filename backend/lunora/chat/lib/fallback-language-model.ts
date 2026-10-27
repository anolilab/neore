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

import { isVisiblePart } from "@neore/ai/models";

import { streamLogger } from "../../lib/logger";
import { estimateTokens, getModelContextWindow } from "./auto-continue";
import { type BackupCapabilities, backupCanServe } from "./backup-model";

/** Provider option keys that only a reasoning model accepts (sending one to another is a 400). */
const REASONING_OPTION_KEYS: ReadonlySet<string> = new Set([
    "reasoning",
    "reasoningEffort",
    "reasoningFormat",
    "reasoningSummary",
    "sendReasoning",
    "thinking",
    "thinkingConfig",
]);

/**
 * The call's provider options as the backup can take them. They were built for the primary's provider and
 * reasoning support (`buildReasoningProviderOptions`), keyed by provider: another provider's bucket means
 * nothing to the backup, and a backup without reasoning must not get a reasoning key.
 */
export const providerOptionsForBackup = (
    providerOptions: LanguageModelV3CallOptions["providerOptions"],
    backup: { providerKey?: string; supportsReasoning?: boolean },
): LanguageModelV3CallOptions["providerOptions"] => {
    if (!providerOptions) {
        return providerOptions;
    }

    const kept: NonNullable<LanguageModelV3CallOptions["providerOptions"]> = {};

    for (const [provider, bucket] of Object.entries(providerOptions)) {
        if (provider !== backup.providerKey) {
            continue;
        }

        const entries = Object.entries(bucket).filter(([key]) => backup.supportsReasoning === true || !REASONING_OPTION_KEYS.has(key));

        if (entries.length > 0) {
            kept[provider] = Object.fromEntries(entries) as (typeof kept)[string];
        }
    }

    return Object.keys(kept).length > 0 ? kept : undefined;
};

/** Whether `error` is a gateway failure that another model could serve. */
export const isInfraFailure = (error: unknown): boolean =>
    typeof error === "object" && error !== null && (error as { fallbackReason?: unknown }).fallbackReason === "infra";

export class FallbackLanguageModel implements LanguageModelV3 {
    readonly specificationVersion = "v3" as const;

    readonly supportedUrls: LanguageModelV3["supportedUrls"];

    private readonly primary: LanguageModelV3;

    private readonly backup: LanguageModelV3;

    private readonly backupCapabilities: BackupCapabilities;

    private active: LanguageModelV3;

    /**
     * Set once a call fell back on an infrastructure failure, and kept for the life of this instance. A wrapper is built
     * per run (\`getAgent\` makes a new one for every run, group turn and continuation, never shared across users), so
     * the later steps of that run go straight to the backup instead of each waiting on the failing primary first.
     */
    private onBackup = false;

    private readonly backupTraits: { providerKey?: string; supportsReasoning?: boolean };

    constructor(
        primary: LanguageModelV3,
        backup: LanguageModelV3,
        {
            backupProviderKey,
            backupSupportsFiles = true,
            backupSupportsImages = true,
            backupSupportsReasoning,
            backupSupportsTools = true,
        }: {
            backupProviderKey?: string;
            backupSupportsFiles?: boolean;
            backupSupportsImages?: boolean;
            backupSupportsReasoning?: boolean;
            backupSupportsTools?: boolean;
        } = {},
    ) {
        this.backupTraits = { providerKey: backupProviderKey, supportsReasoning: backupSupportsReasoning };
        this.primary = primary;
        this.backup = backup;
        this.backupCapabilities = { files: backupSupportsFiles, images: backupSupportsImages, tools: backupSupportsTools };
        this.active = primary;
        this.supportedUrls = primary.supportedUrls;
    }

    /** The model the call is first made on, whichever one served the latest call. */
    get primaryModelId(): string {
        return this.primary.modelId;
    }

    /** Whether the backup could take a call carrying these tools and messages: the one rule for switching and for sizing the prompt. */
    canServe(call: { hasTools: boolean; messages: unknown }): boolean {
        return backupCanServe(this.backupCapabilities, call);
    }

    get backupModelId(): string {
        return this.backup.modelId;
    }

    get provider(): string {
        return this.active.provider;
    }

    get modelId(): string {
        return this.active.modelId;
    }

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
        if (this.onBackup && this.canTakeCall(options)) {
            this.active = this.backup;

            return await this.backup.doGenerate(this.optionsForBackup(options));
        }

        this.active = this.primary;

        try {
            return await this.primary.doGenerate(options);
        } catch (error) {
            if (!this.shouldFallBack(error, options)) {
                throw error;
            }

            this.switchToBackup(error);

            return await this.backup.doGenerate(this.optionsForBackup(options));
        }
    }

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        if (this.onBackup && this.canTakeCall(options)) {
            this.active = this.backup;

            return await this.backup.doStream(this.optionsForBackup(options));
        }

        this.active = this.primary;

        let result: LanguageModelV3StreamResult;

        try {
            result = await this.primary.doStream(options);
        } catch (error) {
            if (!this.shouldFallBack(error, options)) {
                throw error;
            }

            this.switchToBackup(error);

            return await this.backup.doStream(this.optionsForBackup(options));
        }

        // The gateway reports a provider failure after its 200 as an error event, so look at the stream up to its first visible part before committing to it.
        const reader = result.stream.getReader();
        const head: LanguageModelV3StreamPart[] = [];

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                head.push(value);

                if (isVisiblePart(value)) {
                    break;
                }
            }
        } catch (error) {
            if (!this.shouldFallBack(error, options)) {
                throw error;
            }

            // Release the abandoned primary stream before the backup starts.
            await reader.cancel().catch(() => undefined);
            this.switchToBackup(error);

            return await this.backup.doStream(this.optionsForBackup(options));
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

        // A call the backup could not take keeps the primary's own error.
        return this.canTakeCall(options);
    }

    /**
     * The final word on whether the backup can take this call, whatever sizing and compression did before: it supports
     * the tools and attachments in it (\`canServe\`), and the prompt fits its context window (the estimator and the
     * 95% line the gateway's overflow rule uses). A prompt sized for a larger primary would only fail again on the backup.
     */
    private canTakeCall(options: LanguageModelV3CallOptions): boolean {
        if (!this.canServe({ hasTools: (options.tools?.length ?? 0) > 0, messages: options.prompt })) {
            return false;
        }

        return estimateTokens(options.prompt as never) <= getModelContextWindow(this.backup.modelId) * 0.95;
    }

    private optionsForBackup(options: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
        return { ...options, providerOptions: providerOptionsForBackup(options.providerOptions, this.backupTraits) };
    }

    private switchToBackup(error: unknown): void {
        streamLogger.warn(`[FallbackModel] ${this.primary.modelId} failed with an infrastructure error, retrying on ${this.backup.modelId}:`, error);
        this.active = this.backup;
        this.onBackup = true;
    }
}
