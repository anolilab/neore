import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import type { ReactNode } from "react";
import { useId } from "react";

import ProBadge from "./pro-badge";

export interface ModelSelectOption {
    isPremium?: boolean;
    label: string;
    value: string;
}

interface ModelSelectProps {
    /** Shown under the select while a Pro row is selected, and linked to the trigger for screen readers. */
    note?: ReactNode;
    onChange: (value: string) => void;
    options: ReadonlyArray<ModelSelectOption>;
    placeholder: string;
    /** The model the node runs: resolve it with `resolveWorkflowModel` first, so a saved id shows what runs. */
    value: string;
}

/** A node's model picker: the registry rows, a Pro marker on the paid ones, and the plan note. */
const ModelSelect = ({ note, onChange, options, placeholder, value }: ModelSelectProps) => {
    const noteId = useId();
    const selectedIsPremium = options.find((option) => option.value === value)?.isPremium === true;
    const showNote = selectedIsPremium && note !== undefined;

    return (
        <>
            <Select
                onValueChange={(next) => {
                    if (next) {
                        onChange(next);
                    }
                }}
                value={value}
            >
                <SelectTrigger aria-describedby={showNote ? noteId : undefined} className="nodrag h-8 text-sm">
                    <SelectValue placeholder={placeholder} />
                </SelectTrigger>
                <SelectContent>
                    {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                            <span className="block max-w-[180px] truncate">{option.label}</span>
                            {option.isPremium && <ProBadge />}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {showNote && (
                <p className="text-muted-foreground text-xs" id={noteId}>
                    {note}
                </p>
            )}
        </>
    );
};

export default ModelSelect;
