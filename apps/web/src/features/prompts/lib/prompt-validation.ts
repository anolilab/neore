import type { GatewayModel } from "@neore/ai/models";

export interface ValidationResult {
    errors: {
        enabledFeatures?: string[];
        model?: string;
        reasoningEffort?: string;
    };
    isValid: boolean;
}

/**
 * Validate prompt settings against available models.
 */
/** Capabilities the model exposes but the user never picks directly. */
const NON_SELECTABLE_FEATURES = new Set(["effort_control", "fast", "reasoning"]);

const validatePromptSettings = (
    modelId: string | undefined,
    reasoningEffort: number | undefined,
    enabledFeatures: string[] | undefined,
    availableModels: GatewayModel[],
): ValidationResult => {
    // If no model is specified, settings are valid (optional)
    if (!modelId) {
        return {
            errors: {},
            isValid: true,
        };
    }

    const errors: ValidationResult["errors"] = {};

    // Find the model in available models
    const model = availableModels.find((m) => m.id === modelId);

    if (!model) {
        errors.model = `Model '${modelId}' is no longer available. Please select a different model.`;

        return {
            errors,
            isValid: false,
        };
    }

    // Validate reasoning effort if specified
    if (reasoningEffort !== undefined) {
        const supportsReasoningEffort = model.filterCapabilities?.includes("effort_control") || model.filterCapabilities?.includes("reasoning");
        const maxReasoningEffort = supportsReasoningEffort ? 4 : 3;

        if (!supportsReasoningEffort) {
            errors.reasoningEffort = `Model '${model.name ?? model.id}' does not support reasoning effort.`;
        } else if (reasoningEffort > maxReasoningEffort) {
            errors.reasoningEffort = `Model '${model.name ?? model.id}' does not support reasoning effort level ${reasoningEffort}. Maximum supported: ${maxReasoningEffort}`;
        } else if (reasoningEffort < 0 || reasoningEffort > 4) {
            errors.reasoningEffort = `Reasoning effort must be between 0 and 4.`;
        }
    }

    // Validate enabled features if specified
    if (enabledFeatures && enabledFeatures.length > 0) {
        const unsupportedFeatures: string[] = [];
        const availableFeatures = new Set<string>(model.filterCapabilities);

        for (const feature of enabledFeatures) {
            // Skip "fast" and "effort_control" as they're not user-selectable features
            if (NON_SELECTABLE_FEATURES.has(feature)) {
                continue;
            }

            if (!availableFeatures.has(feature)) {
                unsupportedFeatures.push(feature);
            }
        }

        if (unsupportedFeatures.length > 0) {
            errors.enabledFeatures = unsupportedFeatures.map((feature) => `Model '${model.name ?? model.id}' does not support feature '${feature}'.`);
        }
    }

    return {
        errors,
        isValid: Object.keys(errors).length === 0,
    };
};

export default validatePromptSettings;
