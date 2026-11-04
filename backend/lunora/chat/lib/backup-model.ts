import {
    deriveModelRegions,
    parseCustomModelId,
    getModelRejectionReason,
    hasActiveFilters,
    MODEL_LOOKUP,
    type ModelDefinition,
    type ModelFilterRules,
} from "@neore/ai/models";

/**
 * The registry row of the user's backup model (`userSettings.backupModel`), when
 * it can serve a chat reply in place of `primaryModel`: a known, enabled text
 * model the gateway can reach, and not the primary itself. A stored id can go
 * stale (a model is retired), so this is checked on write and again per run.
 */
export const eligibleBackupModel = (backupModel: string | undefined, primaryModel: string): ModelDefinition | undefined => {
    if (!backupModel || backupModel === primaryModel) {
        return undefined;
    }

    const definition = MODEL_LOOKUP.get(backupModel);

    if (!definition || definition.enabled === false || definition.provider === "external" || (definition.mode ?? "text") !== "text") {
        return undefined;
    }

    return definition;
};

/**
 * Why the user's model filters exclude `definition`, or `null`: the rule the gateway answers `MODEL_BLOCKED` with,
 * evaluated here so a backup the filters would refuse is not picked for a retry that could only fail.
 */
export const backupFilterRejection = (definition: ModelDefinition, rules: ModelFilterRules | undefined): string | null =>
    hasActiveFilters(rules)
        ? getModelRejectionReason({ modelId: definition.id, provider: definition.provider, regions: deriveModelRegions(definition) }, rules)
        : null;

/**
 * Whether a run on `primaryModel` can fall back at all: only a registry model served by the gateway is wrapped
 * (`getAgent`), never a custom endpoint. Backup resolution and the wrapper both ask this, so prompt sizing
 * never plans for a retry that cannot happen.
 */
export const supportsBackupFallback = (primaryModel: string): boolean => {
    if (parseCustomModelId(primaryModel)) {
        return false;
    }

    const definition = MODEL_LOOKUP.get(primaryModel);

    return definition !== undefined && definition.provider !== "external";
};

/** What a backup model can take on a call, read from its registry row. */
export interface BackupCapabilities {
    /** Documents (PDF and the like). */
    files: boolean;
    /** Image parts. */
    images: boolean;
    /** Tool definitions. */
    tools: boolean;
}

export const backupCapabilities = (definition: ModelDefinition): BackupCapabilities => {
    return {
        files: definition.supportsFileInput === true || definition.filterCapabilities?.includes("pdf_comprehension") === true,
        images: definition.supportsImages === true || definition.filterCapabilities?.includes("vision") === true,
        tools: definition.supportsToolCalling !== false,
    };
};

const IMAGE_PART_TYPES: ReadonlySet<unknown> = new Set(["image", "image-data", "image-url"]);
const FILE_PART_TYPES: ReadonlySet<unknown> = new Set(["file", "file-data", "file-url"]);

/** Records one media part by its type, and by its media type when it is a file: an image file counts as an image. */
const noteMedia = (found: { files: boolean; images: boolean }, type: unknown, mediaType: unknown): void => {
    if (IMAGE_PART_TYPES.has(type)) {
        found.images = true;
    } else if (FILE_PART_TYPES.has(type)) {
        if (typeof mediaType === "string" && mediaType.startsWith("image/")) {
            found.images = true;
        } else {
            found.files = true;
        }
    }
};

/** The media a `content` tool result carries (an answer's files, a screenshot): the same kinds as a message's own parts. */
const noteToolResultMedia = (part: { output?: unknown }, found: { files: boolean; images: boolean }): void => {
    const output = part.output as { type?: unknown; value?: unknown } | undefined;

    if (output?.type !== "content" || !Array.isArray(output.value)) {
        return;
    }

    for (const item of output.value as ({ mediaType?: unknown; type?: unknown } | null)[]) {
        noteMedia(found, item?.type, item?.mediaType);
    }
};

/** The kinds of attachment in a conversation, for either a model prompt (`file` parts with a media type) or AI SDK messages (`image` and `file` parts, and media inside a tool result). */
export const attachmentsIn = (messages: unknown): { files: boolean; images: boolean } => {
    const found = { files: false, images: false };

    if (!Array.isArray(messages)) {
        return found;
    }

    for (const message of messages as ({ content?: unknown } | null)[]) {
        if (!Array.isArray(message?.content)) {
            continue;
        }

        for (const part of message.content as ({ mediaType?: unknown; mimeType?: unknown; output?: unknown; type?: unknown } | null)[]) {
            if (part?.type === "tool-result") {
                noteToolResultMedia(part, found);
            } else {
                noteMedia(found, part?.type, part?.mediaType ?? part?.mimeType);
            }
        }
    }

    return found;
};

/**
 * Whether a backup with `capabilities` can serve a call: tools it cannot call, images it cannot see and documents it
 * cannot read would fail it. The fallback wrapper asks this to decide whether to switch, and prompt sizing asks it to
 * decide whether the backup's window counts, so the two always agree.
 */
export const backupCanServe = (capabilities: BackupCapabilities, call: { hasTools: boolean; messages: unknown }): boolean => {
    const needs = attachmentsIn(call.messages);

    return (capabilities.tools || !call.hasTools) && (capabilities.images || !needs.images) && (capabilities.files || !needs.files);
};
