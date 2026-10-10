"use client";

import { Checkbox } from "@neore/ui/components/checkbox";
import { Label } from "@neore/ui/components/label";
import { useId, useMemo } from "react";

export interface SkillToolOption {
    category: string;
    description: string;
    name: string;
}

const NO_TOOLS: string[] = [];

interface SkillToolPickerProps {
    /** Tool names that are unavailable here (e.g. already chosen in the other list). */
    conflicting?: string[];
    description?: string;
    errorMessage?: string;
    legend: string;
    onChange: (value: string[]) => void;
    tools: SkillToolOption[];
    value: string[];
}

/**
 * A fieldset of tool checkboxes grouped by category. The `legend` names the
 * group for assistive tech; each checkbox is labelled by its tool name and
 * described by the tool's description.
 */
const SkillToolPicker = ({ conflicting = NO_TOOLS, description, errorMessage, legend, onChange, tools, value }: SkillToolPickerProps) => {
    const baseId = useId();
    const selected = useMemo(() => new Set(value), [value]);
    const conflictingSet = useMemo(() => new Set(conflicting), [conflicting]);

    const grouped = useMemo(() => {
        const groups = new Map<string, SkillToolOption[]>();

        for (const tool of tools) {
            groups.set(tool.category, [...(groups.get(tool.category) ?? []), tool]);
        }

        return [...groups];
    }, [tools]);

    const toggle = (name: string, checked: boolean) => {
        onChange(checked ? [...value, name] : value.filter((tool) => tool !== name));
    };

    const descriptionId = description ? `${baseId}-description` : undefined;
    const errorId = errorMessage ? `${baseId}-error` : undefined;

    return (
        <fieldset aria-describedby={[descriptionId, errorId].filter(Boolean).join(" ") || undefined} aria-invalid={!!errorMessage} className="space-y-3">
            <legend className="text-sm font-medium">{legend}</legend>
            {description && (
                <p className="text-muted-foreground text-xs" id={descriptionId}>
                    {description}
                </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
                {grouped.map(([category, categoryTools]) => (
                    <div className="space-y-2" key={category}>
                        <p aria-hidden="true" className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                            {category}
                        </p>
                        {categoryTools.map((tool) => {
                            const id = `${baseId}-${tool.name}`;
                            const isSelected = selected.has(tool.name);

                            return (
                                <div className="flex items-start gap-2" key={tool.name}>
                                    <Checkbox
                                        aria-describedby={`${id}-description`}
                                        checked={isSelected}
                                        disabled={!isSelected && conflictingSet.has(tool.name)}
                                        id={id}
                                        onCheckedChange={(checked) => toggle(tool.name, checked === true)}
                                    />
                                    <div className="grid gap-0.5 leading-none">
                                        <Label className="cursor-pointer font-mono text-xs" htmlFor={id}>
                                            {tool.name}
                                        </Label>
                                        <span className="text-muted-foreground text-xs" id={`${id}-description`}>
                                            {tool.description}
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
            {errorMessage && (
                <p className="text-destructive text-sm" id={errorId}>
                    {errorMessage}
                </p>
            )}
        </fieldset>
    );
};

export default SkillToolPicker;
