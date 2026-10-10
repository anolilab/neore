"use client";

import { useLingui } from "@lingui/react/macro";
import type { Doc } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { AlertTriangle, Braces } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { PromptVariable } from "../lib/prompt-variables";
import { extractVariables, replaceVariables } from "../lib/prompt-variables";

interface VariableFillDialogProps {
    existingValues: Record<string, string>;
    onCancel: () => void;
    onUse: (content: string, newValues: Record<string, string>) => void;
    onUseAnyway: (content: string) => void;
    open: boolean;
    prompt: Doc<"prompts">;
}

const VariableFillDialog = ({ existingValues, onCancel, onUse, onUseAnyway, open, prompt }: VariableFillDialogProps) => {
    const { t } = useLingui();
    const [values, setValues] = useState<Record<string, string>>({});

    // Memoize computed values to prevent unnecessary recalculations
    const { definitionMap, missingVariables, variableDefinitions } = useMemo(() => {
        const variableNames = extractVariables(prompt.content);
        const definitions = (prompt.variables || []) as PromptVariable[];
        const defMap = new Map<string, PromptVariable>(definitions.map((v) => [v.name, v]));

        const missing = variableNames.filter((name) => {
            const hasExisting = existingValues[name]?.trim();
            const hasDefault = defMap.get(name)?.defaultValue?.trim();

            return !hasExisting && !hasDefault;
        });

        return {
            definitionMap: defMap,
            missingVariables: missing,
            variableDefinitions: definitions,
        };
    }, [prompt.content, prompt.variables, existingValues]);

    // Reset values when the dialog opens or the missing variables change. Adjusted
    // during render rather than in an effect so the reset lands in the same commit.
    const [previousInputs, setPreviousInputs] = useState<{ missingVariables: string[]; open: boolean } | undefined>(undefined);

    if (open !== previousInputs?.open || missingVariables !== previousInputs.missingVariables) {
        setPreviousInputs({ missingVariables, open });

        if (open) {
            const initial: Record<string, string> = {};

            for (const name of missingVariables) {
                initial[name] = "";
            }

            setValues(initial);
        }
    }

    const handleValueChange = useCallback((name: string, value: string) => {
        setValues((previous) => {
            return { ...previous, [name]: value };
        });
    }, []);

    const handleUse = useCallback(() => {
        // Merge all values: existing + defaults + newly filled
        const allValues: Record<string, string> = { ...existingValues };

        // Add defaults from definitions
        for (const def of variableDefinitions) {
            if (!Object.hasOwn(allValues, def.name) && def.defaultValue) {
                allValues[def.name] = def.defaultValue;
            }
        }

        // Add newly filled values
        for (const [name, value] of Object.entries(values)) {
            if (value.trim()) {
                allValues[name] = value;
            }
        }

        const content = replaceVariables(prompt.content, allValues, { keepUnmatched: true });

        onUse(content, values);
    }, [existingValues, variableDefinitions, values, prompt.content, onUse]);

    const handleUseAnyway = useCallback(() => {
        // Use with existing values only, keep unfilled as placeholders
        const allValues: Record<string, string> = { ...existingValues };

        for (const def of variableDefinitions) {
            if (!Object.hasOwn(allValues, def.name) && def.defaultValue) {
                allValues[def.name] = def.defaultValue;
            }
        }

        const content = replaceVariables(prompt.content, allValues, { keepUnmatched: true });

        onUseAnyway(content);
    }, [existingValues, variableDefinitions, prompt.content, onUseAnyway]);

    // Check if all required variables are filled
    const requiredVariables = variableDefinitions.filter((v: PromptVariable) => v.required);
    const missingRequired = requiredVariables.filter(
        (v: PromptVariable) => !existingValues[v.name]?.trim() && !values[v.name]?.trim() && !v.defaultValue?.trim(),
    );

    const allFilled = missingVariables.every((name) => values[name]?.trim());

    return (
        <Dialog onOpenChange={(nextOpen) => !nextOpen && onCancel()} open={open}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Braces className="size-5" />
                        {t`Fill Variables`}
                    </DialogTitle>
                    <DialogDescription>{t`"${prompt.name}" has variables that need values.`}</DialogDescription>
                </DialogHeader>

                <DialogPanel>
                    {missingRequired.length > 0 && (
                        <div className="mb-4 flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 p-3 dark:border-orange-900/50 dark:bg-orange-900/20">
                            <AlertTriangle className="mt-0.5 size-4 flex-shrink-0 text-orange-600" />
                            <div>
                                <p className="text-sm font-medium text-orange-800 dark:text-orange-200">{t`Required variables missing`}</p>
                                <p className="text-xs text-orange-700 dark:text-orange-300">{missingRequired.map((v) => v.name).join(", ")}</p>
                            </div>
                        </div>
                    )}

                    <ScrollArea className="max-h-64">
                        <div className="space-y-4 pr-4">
                            {missingVariables.map((name) => {
                                const definition = definitionMap.get(name);
                                const isRequired = definition?.required;

                                return (
                                    <div className="space-y-1.5" key={name}>
                                        <Label className="flex items-center gap-2" htmlFor={`var-${name}`}>
                                            <code className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-xs">{`{{${name}}}`}</code>
                                            {isRequired && (
                                                <Badge className="text-[10px]" variant="destructive">
                                                    {t`Required`}
                                                </Badge>
                                            )}
                                        </Label>
                                        {definition?.description && <p className="text-muted-foreground text-xs">{definition.description}</p>}
                                        <Input
                                            id={`var-${name}`}
                                            onChange={(e) => handleValueChange(name, e.target.value)}
                                            placeholder={definition?.defaultValue || t`Enter value...`}
                                            value={values[name] || ""}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </ScrollArea>

                    {/* Preview */}
                    {allFilled && (
                        <div className="bg-muted/50 mt-4 rounded-lg border p-3">
                            <p className="mb-1 text-xs font-medium">{t`Preview`}</p>
                            <p className="text-muted-foreground line-clamp-3 text-sm">
                                {replaceVariables(prompt.content, { ...existingValues, ...values }, { keepUnmatched: true }).slice(0, 200)}
                                {prompt.content.length > 200 ? "..." : ""}
                            </p>
                        </div>
                    )}
                </DialogPanel>

                <DialogFooter className="flex-col gap-2 sm:flex-row">
                    <Button className="sm:mr-auto" onClick={onCancel} variant="ghost">
                        {t`Cancel`}
                    </Button>
                    <Button onClick={handleUseAnyway} variant="outline">
                        {t`Use with Placeholders`}
                    </Button>
                    <Button disabled={missingRequired.length > 0 && !allFilled} onClick={handleUse}>
                        {allFilled ? t`Use Prompt` : t`Fill & Use`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default VariableFillDialog;
