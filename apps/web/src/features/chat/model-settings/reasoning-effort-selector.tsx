"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { Label } from "@neore/ui/components/label";
import { Slider } from "@neore/ui/components/slider";
import type { FC } from "react";

import { EFFORT_DEFAULT, EFFORT_MAX, EFFORT_MIN, EFFORT_STEP } from "./reasoning-effort-steps";

/**
 * Translatable effort labels for reasoning effort levels — resolve with `i18n._(...)`.
 */
export const EFFORT_LABEL_MESSAGES: Record<number, MessageDescriptor> = {
    0: msg`Low`,
    25: msg`Medium-Low`,
    50: msg`Medium`,
    75: msg`Medium-High`,
    100: msg`High`,
};

interface ReasoningEffortSelectorProps {
    model: GatewayModel;
    onChange: (value: number | undefined) => void;
    value?: number;
}

export const ReasoningEffortSelector: FC<ReasoningEffortSelectorProps> = ({ model, onChange, value }) => {
    const { i18n, t } = useLingui();

    // `GatewayModel` carries neither `supportsReasoning` nor `reasoning`; the
    // registry marks reasoning models with `filterCapabilities: ["reasoning"]`.
    // Testing the former two meant this was always falsy, so the selector never
    // rendered in the project and prompt dialogs that mount it.
    const supportsReasoning = model.filterCapabilities?.includes("reasoning") ?? false;

    if (!supportsReasoning) {
        return null;
    }

    const currentMessage = EFFORT_LABEL_MESSAGES[value ?? EFFORT_DEFAULT];
    const currentLabel = currentMessage ? i18n._(currentMessage) : t`Medium`;

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">{t`Reasoning Effort`}</Label>
                <span className="text-muted-foreground text-xs">{currentLabel}</span>
            </div>
            <Slider
                max={EFFORT_MAX}
                min={EFFORT_MIN}
                onValueChange={(nextValue: number | ReadonlyArray<number>) => onChange(Array.isArray(nextValue) ? nextValue[0] : nextValue)}
                step={EFFORT_STEP}
                value={[value ?? EFFORT_DEFAULT]}
            />
            <p className="text-muted-foreground text-xs">{t`Higher reasoning effort may produce more thoughtful responses but takes longer.`}</p>
        </div>
    );
};
