"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Braces, HelpCircle, Loader2, Plus, Save, X } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import type { PromptVariable } from "../lib/prompt-variables";
import { getCommonVariableCategories, isSystemManagedVariable } from "../lib/prompt-variables";

/** Literal `{{…}}` must reach the message as a value: inside a lingui message it would parse as an ICU argument. */
const VARIABLE_PLACEHOLDER = "{{variableName}}";

const NON_IDENTIFIER_START_RE = /^[^a-z_]/i;

interface ThreadVariablesConfigProps {
    threadId: string;
}

interface VariableInput {
    name: string;
    value: string;
}

const ThreadVariablesConfig = ({ threadId }: ThreadVariablesConfigProps) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const [localVariables, setLocalVariables] = useState<VariableInput[]>([]);
    const [newVariableName, setNewVariableName] = useState("");
    const [hasChanges, setHasChanges] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    // Query thread variables.
    // `threadId` is the `/chat/$threadId` route param, passed down as a plain string.
    const { data: threadVariables } = useQuery(crpc.prompts.functions.getThreadVariables.queryOptions({ threadId: threadId as Id<"threads"> }));

    // Mutations
    const { mutateAsync: setThreadVariables } = useMutation(crpc.prompts.functions.setThreadVariables.mutationOptions());

    // Sync local state with query results (filter out system-managed variables).
    // Adjusted during render rather than in an effect, so the list never paints
    // once with the previous thread's variables.
    const [syncedVariables, setSyncedVariables] = useState<typeof threadVariables | undefined>(undefined);

    if (threadVariables?.variables && threadVariables !== syncedVariables) {
        setSyncedVariables(threadVariables);

        const { variables } = threadVariables;

        setLocalVariables(
            (Array.isArray(variables) ? variables : []).flatMap((entry): VariableInput[] => {
                const variableName: string = String(entry.name ?? "");
                const variableValue: string = String(entry.value ?? "");

                if (variableName && !isSystemManagedVariable(variableName)) {
                    const item: VariableInput = { name: variableName, value: variableValue };

                    return [item];
                }

                return [];
            }),
        );
        setHasChanges(false);
    }

    const handleVariableChange = useCallback((index: number, value: string) => {
        setLocalVariables((previous) => {
            const updated = [...previous];

            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            updated[index] = { ...updated[index]!, value };

            return updated;
        });
        setHasChanges(true);
    }, []);

    const handleAddVariable = useCallback(() => {
        if (!newVariableName.trim()) {
            return;
        }

        // Sanitize variable name
        const sanitized = newVariableName
            .trim()
            .replaceAll(/[^\w.]/g, "_")
            .replace(NON_IDENTIFIER_START_RE, "_");

        // Check if it's a system-managed variable
        if (isSystemManagedVariable(sanitized)) {
            toast.error(t`Variables starting with "context." or "user." are system-managed and cannot be edited`);

            return;
        }

        // Check if already exists
        if (localVariables.some((v) => v.name === sanitized)) {
            toast.error(t`Variable "${sanitized}" already exists`);

            return;
        }

        setLocalVariables((previous) => [...previous, { name: sanitized, value: "" }]);
        setNewVariableName("");
        setHasChanges(true);
    }, [newVariableName, localVariables, t]);

    const handleAddCommonVariable = useCallback(
        (variable: PromptVariable) => {
            // Check if already exists
            if (localVariables.some((v) => v.name === variable.name)) {
                toast.error(t`Variable "${variable.name}" already exists`);

                return;
            }

            setLocalVariables((previous) => [...previous, { name: variable.name, value: variable.defaultValue || "" }]);
            setHasChanges(true);
        },
        [localVariables, t],
    );

    const handleRemoveVariable = useCallback((index: number) => {
        setLocalVariables((previous) => previous.filter((_, i) => i !== index));
        setHasChanges(true);
    }, []);

    const handleSave = useCallback(async () => {
        setIsSaving(true);

        try {
            // Filter out empty values
            const variablesToSave = localVariables.filter((v) => v.value.trim());

            await setThreadVariables({
                // `threadId` is the `/chat/$threadId` route param, passed down as a plain string.
                threadId: threadId as Id<"threads">,
                variables: variablesToSave,
            });
            toast.success(t`Variables saved`);
            setHasChanges(false);
        } catch {
            toast.error(t`Failed to save variables`);
        }

        setIsSaving(false);
    }, [localVariables, threadId, setThreadVariables, t]);

    // Loading state
    if (threadVariables === undefined) {
        return (
            <div className="flex items-center justify-center py-8">
                <Loader2 className="text-muted-foreground size-6 animate-spin" />
            </div>
        );
    }

    return (
        <div className="space-y-4 pr-2 pl-1">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Braces className="text-foreground size-4" />
                    <h3 className="text-foreground text-sm font-medium">{t`Thread Variables`}</h3>
                    {localVariables.length > 0 && <Badge variant="secondary">{localVariables.length}</Badge>}
                </div>
                <Tooltip>
                    <TooltipTrigger render={<HelpCircle className="text-muted-foreground size-4" />} />
                    <TooltipContent className="max-w-xs">
                        {t`Configure variable values for this thread. These values will replace ${VARIABLE_PLACEHOLDER} placeholders when you use prompts.`}
                    </TooltipContent>
                </Tooltip>
            </div>

            {/* Add new variable */}
            <div className="flex gap-2">
                <Input
                    className="flex-1"
                    onChange={(e) => setNewVariableName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddVariable()}
                    placeholder={t`Variable name...`}
                    value={newVariableName}
                />
                <Button disabled={!newVariableName.trim()} onClick={handleAddVariable} size="icon" variant="outline">
                    <Plus className="size-4" />
                </Button>
            </div>

            {/* Common variables quick add */}
            <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">{t`Quick Add`}</Label>
                <div className="flex flex-wrap gap-1">
                    {Object.values(getCommonVariableCategories(i18n))
                        .slice(0, 2)
                        .flatMap((category) =>
                            category.variables.slice(0, 3).map((variable) => (
                                <Button
                                    className="h-6 px-2 text-xs"
                                    disabled={localVariables.some((v) => v.name === variable.name)}
                                    key={variable.name}
                                    onClick={() => handleAddCommonVariable(variable)}
                                    variant="outline"
                                >
                                    {variable.name.split(".").pop()}
                                </Button>
                            )),
                        )}
                </div>
            </div>

            {/* Variable list */}
            {localVariables.length > 0 ? (
                <ScrollArea className="h-64">
                    <div className="space-y-3 pr-4">
                        {localVariables.map((variable, index) => (
                            <div className="space-y-1" key={variable.name}>
                                <div className="flex items-center justify-between">
                                    <Label className="text-xs" htmlFor={`var-${index}`}>
                                        <code className="bg-primary/10 text-primary rounded px-1">{`{{${variable.name}}}`}</code>
                                    </Label>
                                    <Button onClick={() => handleRemoveVariable(index)} size="icon-sm" variant="ghost">
                                        <X className="size-3" />
                                    </Button>
                                </div>
                                <Input
                                    id={`var-${index}`}
                                    onChange={(e) => handleVariableChange(index, e.target.value)}
                                    placeholder={t`Enter value...`}
                                    value={variable.value}
                                />
                            </div>
                        ))}
                    </div>
                </ScrollArea>
            ) : (
                <div className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
                    {t`No variables configured. Add variables to customize prompt content for this thread.`}
                </div>
            )}

            {/* Save button */}
            {hasChanges && (
                <Button className="w-full" disabled={isSaving} onClick={handleSave}>
                    {isSaving ? (
                        <>
                            <Loader2 className="mr-2 size-4 animate-spin" />
                            {t`Saving...`}
                        </>
                    ) : (
                        <>
                            <Save className="mr-2 size-4" />
                            {t`Save Variables`}
                        </>
                    )}
                </Button>
            )}
        </div>
    );
};

export default ThreadVariablesConfig;
