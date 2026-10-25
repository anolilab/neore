"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Calendar, Globe } from "lucide-react";
import type { FC } from "react";

/** The types a user can create. "event" rows still exist, but nothing dispatches them, so it is not offered. */
export const SELECTABLE_TRIGGER_TYPES = ["schedule", "webhook"] as const;

export type SelectableTriggerType = (typeof SELECTABLE_TRIGGER_TYPES)[number];

const TRIGGER_TYPE_LABELS: Record<SelectableTriggerType, MessageDescriptor> = {
    schedule: msg`Schedule`,
    webhook: msg`Webhook`,
};

interface TriggerTypePickerProps {
    onSelect: (type: SelectableTriggerType) => void;
    value: string;
}

const TriggerTypePicker: FC<TriggerTypePickerProps> = ({ onSelect, value }) => {
    const { i18n, t } = useLingui();

    return (
        <div aria-label={t`Trigger type`} className="flex gap-2" role="group">
            {SELECTABLE_TRIGGER_TYPES.map((type) => (
                <button
                    aria-pressed={value === type}
                    className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        value === type ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                    key={type}
                    onClick={() => onSelect(type)}
                    type="button"
                >
                    {type === "schedule" && <Calendar aria-hidden="true" className="size-4" />}
                    {type === "webhook" && <Globe aria-hidden="true" className="size-4" />}
                    {i18n._(TRIGGER_TYPE_LABELS[type])}
                </button>
            ))}
        </div>
    );
};

export default TriggerTypePicker;
