/**
 * Fallback Language Model — LanguageModelV3 that runs a call on the user's
 * backup models, in order, when the primary fails with an infrastructure error.
 *
 * Only the gateway's own classification counts (`error.fallbackReason`, see
 * `GatewayLanguageModel`): a content-policy or context-overflow failure would
 * fail the same way on another model chosen for its availability, and an
 * unclassified error (no field) is not known to be safe to retry.
 *
 * The retry is made only for a call that failed before it produced anything:
 * the rejection of `doGenerate()` / `doStream()` itself, or a stream that errors
 * before its first content part. Once a part has been handed on, the agent has
 * consumed it and cannot be handed another reply. A backup that fails the same
 * way hands the call to the next one; the last failure surfaces.
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

/** One backup model of a chain, with what it can take on a call (registry traits, read by `getAgent`). */
export interface FallbackBackup {
    model: LanguageModelV3;
    providerKey?: string;
    supportsFiles?: boolean;
    supportsImages?: boolean;
    supportsReasoning?: boolean;
    supportsTools?: boolean;
}

interface Slot {
    capabilities: BackupCapabilities;
    model: LanguageModelV3;
    traits: { providerKey?: string; supportsReasoning?: boolean };
}

export class FallbackLanguageModel implements LanguageModelV3 {
    readonly specificationVersion = "v3" as const;

    readonly supportedUrls: LanguageModelV3["supportedUrls"];

    private readonly primary: LanguageModelV3;

    private readonly backups: ReadonlyArray<Slot>;

    private active: LanguageModelV3;

    /**
     * The backup the latest fallback landed on (an index into `backups`), kept for the life of this instance. A wrapper is
     * built per run (\`getAgent\` makes a new one for every run, group turn and continuation, never shared across users), so
     * the later steps of that run start there instead of each waiting on the failing models before it.
     */
    private onBackup: number | undefined;

    constructor(primary: LanguageModelV3, backups: ReadonlyArray<FallbackBackup>) {
        this.primary = primary;
        this.backups = backups.map((backup) => {
            return {
                capabilities: { files: backup.supportsFiles ?? true, images: backup.supportsImages ?? true, tools: backup.supportsTools ?? true },
                model: backup.model,
                traits: { providerKey: backup.providerKey, supportsReasoning: backup.supportsReasoning },
            };
        });
        this.active = primary;
        this.supportedUrls = primary.supportedUrls;
    }

    /** The model the call is first made on, whichever one served the latest call. */
    get primaryModelId(): string {
        return this.primary.modelId;
    }

    /**
     * The backups that could take a call carrying these tools and messages, in order: the one rule for switching and for
     * sizing the prompt, which must fit the smallest window among them.
     */
    backupsServing(call: { hasTools: boolean; messages: unknown }): string[] {
        return this.backups.filter((slot) => backupCanServe(slot.capabilities, call)).map((slot) => slot.model.modelId);
    }

    get backupModelIds(): string[] {
        return this.backups.map((slot) => slot.model.modelId);
    }

    get provider(): string {
        return this.active.provider;
    }

    get modelId(): string {
        return this.active.modelId;
    }

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
        let index = this.firstAttempt(options);

        while (true) {
            const model = this.modelAt(index);

            this.active = model;

            try {
                return await model.doGenerate(this.optionsFor(index, options));
            } catch (error) {
                index = this.nextAttempt(index, error, options);
            }
        }
    }

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        let index = this.firstAttempt(options);

        while (true) {
            const model = this.modelAt(index);

            this.active = model;

            let result: LanguageModelV3StreamResult;

            try {
                result = await model.doStream(this.optionsFor(index, options));
            } catch (error) {
                index = this.nextAttempt(index, error, options);

                continue;
            }

            // The last backup's stream is handed on as it is: nothing is left to fall back to.
            if (index >= 0 && this.nextServing(index, options) === undefined) {
                return result;
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
                index = this.nextAttempt(index, error, options);
                // Release the abandoned stream before the next model starts.
                await reader.cancel().catch(() => undefined);

                continue;
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
    }

    /** The model at `index`: -1 is the primary, and 0 and up index `backups`. */
    private modelAt(index: number): LanguageModelV3 {
        return index < 0 ? this.primary : this.backups[index]!.model;
    }

    /** Where a call starts: the backup an earlier step landed on, or the next one after it that can take this call, else the primary. */
    private firstAttempt(options: LanguageModelV3CallOptions): number {
        if (this.onBackup === undefined) {
            return -1;
        }

        return this.canTakeCall(this.onBackup, options) ? this.onBackup : (this.nextServing(this.onBackup, options) ?? -1);
    }

    /**
     * The model to try after `index` failed with `error`, or a throw of that error: only an infrastructure failure moves on,
     * a stopped run never does (checked before every hop), and a call no later backup can take keeps the error it got.
     */
    private nextAttempt(index: number, error: unknown, options: LanguageModelV3CallOptions): number {
        if (!isInfraFailure(error) || options.abortSignal?.aborted === true) {
            throw error;
        }

        const next = this.nextServing(index, options);

        if (next === undefined) {
            throw error;
        }

        streamLogger.warn(
            `[FallbackModel] ${this.modelAt(index).modelId} failed with an infrastructure error, retrying on backup ${next + 1} of ${this.backups.length} (${this.modelAt(next).modelId}):`,
            error,
        );
        this.onBackup = next;

        return next;
    }

    /** The first backup after `index` that can take the call. */
    private nextServing(index: number, options: LanguageModelV3CallOptions): number | undefined {
        for (let next = index + 1; next < this.backups.length; next += 1) {
            if (this.canTakeCall(next, options)) {
                return next;
            }
        }

        return undefined;
    }

    /**
     * The final word on whether a backup can take this call, whatever sizing and compression did before: it supports
     * the tools and attachments in it (\`backupCanServe\`), and the prompt fits its context window (the estimator and the
     * 95% line the gateway's overflow rule uses). A prompt sized for a larger model would only fail again on it.
     */
    private canTakeCall(index: number, options: LanguageModelV3CallOptions): boolean {
        const slot = this.backups[index]!;

        if (!backupCanServe(slot.capabilities, { hasTools: (options.tools?.length ?? 0) > 0, messages: options.prompt })) {
            return false;
        }

        return estimateTokens(options.prompt as never) <= getModelContextWindow(slot.model.modelId) * 0.95;
    }

    private optionsFor(index: number, options: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
        return index < 0 ? options : { ...options, providerOptions: providerOptionsForBackup(options.providerOptions, this.backups[index]!.traits) };
    }
}
