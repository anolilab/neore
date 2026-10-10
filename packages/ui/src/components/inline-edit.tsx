"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import { Check, Pencil, X } from "lucide-react";
import * as React from "react";

import { Button } from "./button";
import { Input } from "./input";

interface InlineEditProps extends React.HTMLAttributes<HTMLDivElement> {
    defaultValue?: string;
    disabled?: boolean;
    onCancel?: () => void;
    onSave?: (value: string) => void;
    ref?: React.Ref<HTMLDivElement>;
    renderInput?: (props: any) => React.ReactNode;
    showControls?: boolean;
    submitOnEnter?: boolean;
    value?: string;
}

const InlineEdit = ({
    children: _children,
    className,
    defaultValue = "",
    disabled = false,
    onCancel,
    onSave,
    ref,
    renderInput,
    showControls = true,
    submitOnEnter = true,
    value: controlledValue,
    ...props
}: InlineEditProps) => {
    const { t } = useLingui();
    const [isEditing, setIsEditing] = React.useState(false);
    const [value, setValue] = React.useState(defaultValue);
    const [tempValue, setTempValue] = React.useState(defaultValue);
    const inputRef = React.useRef<HTMLInputElement>(null);

    const isControlled = controlledValue !== undefined;
    const currentValue = isControlled ? controlledValue : value;

    React.useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isEditing]);

    const handleEdit = () => {
        if (disabled) {
            return;
        }

        setTempValue(currentValue);
        setIsEditing(true);
    };

    const handleSave = () => {
        if (!isControlled) {
            setValue(tempValue);
        }

        onSave?.(tempValue);
        setIsEditing(false);
    };

    const handleCancel = () => {
        setTempValue(currentValue);
        setIsEditing(false);
        onCancel?.();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            handleSave();

            return;
        }

        if (e.key === "Enter" && submitOnEnter) {
            e.preventDefault();
            handleSave();
        } else if (e.key === "Escape") {
            handleCancel();
        }
    };

    if (isEditing) {
        return (
            <div className={cn("flex items-center gap-2", className)} ref={ref} {...props}>
                {renderInput ? (
                    renderInput({
                        autoFocus: true,
                        onChange: (e: any) => setTempValue(e.target.value),
                        onKeyDown: handleKeyDown,
                        value: tempValue,
                    })
                ) : (
                    <Input disabled={disabled} onChange={(e) => setTempValue(e.target.value)} onKeyDown={handleKeyDown} ref={inputRef} value={tempValue} />
                )}
                {showControls && (
                    <div className="flex items-center gap-1">
                        <Button className="h-8 w-8" onClick={handleSave} size="icon" variant="ghost">
                            <Check aria-hidden="true" className="h-4 w-4" />
                            <span className="sr-only">{t`Save`}</span>
                        </Button>
                        <Button className="h-8 w-8" onClick={handleCancel} size="icon" variant="ghost">
                            <X aria-hidden="true" className="h-4 w-4" />
                            <span className="sr-only">{t`Cancel`}</span>
                        </Button>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div
            className={cn("group hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-3 py-1", className)}
            onClick={handleEdit}
            onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                    return;
                }

                event.preventDefault();
                handleEdit();
            }}
            ref={ref}
            role="button"
            tabIndex={disabled ? -1 : 0}
            {...props}
        >
            <span className="flex-1 truncate">{currentValue || <span className="text-muted-foreground italic">{t`Click to edit...`}</span>}</span>
            {!disabled && <Pencil className="text-muted-foreground h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />}
        </div>
    );
};

InlineEdit.displayName = "InlineEdit";

export { InlineEdit };
