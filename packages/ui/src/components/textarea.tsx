"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import { mergeProps } from "@base-ui/react/merge-props";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Dialog, DialogContent } from "@ui/components/dialog";
import cn from "@ui/utils/cn";
import { Maximize2, Minimize2 } from "lucide-react";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";

type TextareaProps = React.ComponentProps<"textarea"> & {
    expandable?: boolean;
    expandableDialogTitle?: string;
    size?: "sm" | "default" | "lg" | number;
    unstyled?: boolean;
};

const Textarea = ({ className, expandable = false, expandableDialogTitle, onChange, size = "default", unstyled = false, value, ...props }: TextareaProps) => {
    const { t } = useLingui();
    const [isExpanded, setIsExpanded] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const expandedTextareaRef = useRef<HTMLTextAreaElement>(null);

    // Preserve cursor position when expanding
    useEffect(() => {
        if (!(isExpanded && expandedTextareaRef.current && textareaRef.current)) {
            return;
        }

        const cursorPosition = textareaRef.current.selectionStart;

        expandedTextareaRef.current.focus();
        expandedTextareaRef.current.setSelectionRange(cursorPosition, cursorPosition);
    }, [isExpanded]);

    const handleExpand = () => {
        setIsExpanded(true);
    };

    const handleCollapse = () => {
        setIsExpanded(false);
        // Restore focus to original textarea after collapse
        setTimeout(() => {
            textareaRef.current?.focus();
        }, 0);
    };

    const handleOpenChange = (open: boolean) => {
        setIsExpanded(open);

        if (!open) {
            // Restore focus when dialog closes
            setTimeout(() => {
                textareaRef.current?.focus();
            }, 0);
        }
    };

    const handleTextareaClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
        if (!expandable || isExpanded) {
            return;
        }

        e.preventDefault();
        handleExpand();
    };

    const textareaElement = (
        <FieldPrimitive.Control
            render={(defaultProps) => (
                <textarea
                    className={cn(
                        "field-sizing-content min-h-17.5 w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none max-sm:min-h-20.5",
                        size === "sm" && "min-h-16.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] max-sm:min-h-19.5",
                        size === "lg" && "min-h-18.5 py-[calc(--spacing(2)-1px)] max-sm:min-h-21.5",
                        expandable && "max-h-96 cursor-pointer resize-none overflow-y-auto",
                    )}
                    data-slot="textarea"
                    readOnly={expandable && !isExpanded}
                    ref={textareaRef}
                    // `value`/`onChange` go THROUGH mergeProps, not before it:
                    // Field.Control's own default props carry an `onChange`, and a
                    // spread after the explicit props replaced ours — every
                    // controlled Textarea then ignored typing entirely.
                    {...mergeProps(defaultProps, { ...props, ...(onChange && { onChange }), ...(value !== undefined && { value }) })}
                />
            )}
        />
    );

    return (
        <>
            <span
                className={
                    cn(
                        {
                            "cursor-pointer pr-8": expandable,
                            "text-foreground border-input bg-background ring-ring/24 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 relative inline-flex w-full rounded-lg border bg-clip-padding text-base shadow-xs transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:ring-[3px] has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none sm:text-sm dark:bg-clip-border dark:not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/8%)]":
                                !unstyled,
                        },
                        className,
                    ) || undefined
                }
                data-size={size}
                data-slot="textarea-control"
                onClick={expandable ? handleTextareaClick : undefined}
            >
                {textareaElement}
                {expandable && (
                    <Button
                        aria-label={t`Expand textarea`}
                        className="pointer-events-none absolute end-1 top-1 z-10 size-6 opacity-60"
                        size="icon-sm"
                        tabIndex={-1}
                        type="button"
                        variant="ghost"
                    >
                        <Maximize2 aria-hidden="true" className="size-3.5" />
                    </Button>
                )}
            </span>

            {expandable && (
                <Dialog onOpenChange={handleOpenChange} open={isExpanded}>
                    <DialogContent className="flex h-full max-h-[90vh] w-full max-w-[90vw] flex-col p-0" showCloseButton={false}>
                        <div className="flex items-center justify-between border-b px-4 py-3">
                            <span className="text-sm font-medium">{expandableDialogTitle ?? t`Expanded Editor`}</span>
                            <Button aria-label={t`Collapse textarea`} onClick={handleCollapse} size="icon" type="button" variant="ghost">
                                <Minimize2 aria-hidden="true" className="size-4" />
                            </Button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto p-4">
                            <span
                                className={cn(
                                    "text-foreground border-input bg-background ring-ring/24 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 relative inline-flex min-h-[200px] w-full rounded-lg border bg-clip-padding text-base shadow-xs transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:ring-[3px] has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none sm:text-sm dark:bg-clip-border dark:not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/8%)]",
                                )}
                                data-size={size}
                                data-slot="textarea-control"
                            >
                                <textarea
                                    className={cn(
                                        "field-sizing-content max-h-[calc(90vh-120px)] min-h-[200px] w-full resize-none overflow-y-auto rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none",
                                        size === "sm" && "px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)]",
                                        size === "lg" && "py-[calc(--spacing(2)-1px)]",
                                    )}
                                    data-slot="textarea"
                                    onChange={onChange}
                                    ref={expandedTextareaRef}
                                    value={value}
                                    {...props}
                                />
                            </span>
                        </div>
                    </DialogContent>
                </Dialog>
            )}
        </>
    );
};

export { Textarea, type TextareaProps };
