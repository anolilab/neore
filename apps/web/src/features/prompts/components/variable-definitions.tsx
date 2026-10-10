"use client";

import { useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription } from "@neore/ui/components/alert";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Switch } from "@neore/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { Braces, HelpCircle, Trash2 } from "lucide-react";
import { useCallback } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import type { PromptVariable } from "../lib/prompt-variables";

/** Literal `{{…}}` must reach the message as a value: inside a lingui message it would parse as an ICU argument. */
const VARIABLE_PLACEHOLDER = "{{variableName}}";

interface VariableDefinitionsProps {
    onChange: (variables: PromptVariable[]) => void;
    variables: PromptVariable[];
}

const VariableDefinitions = ({ onChange, variables }: VariableDefinitionsProps) => {
    const { t } = useLingui();
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const isLoggedIn = !!sessionData?.user;

    const handleUpdateVariable = useCallback(
        (index: number, updates: Partial<PromptVariable>) => {
            const newVariables = [...variables];

            newVariables[index] = { ...newVariables[index], ...updates } as PromptVariable;
            onChange(newVariables);
        },
        [variables, onChange],
    );

    const handleRemoveVariable = useCallback(
        (index: number) => {
            const newVariables = variables.filter((_, i) => i !== index);

            onChange(newVariables);
        },
        [variables, onChange],
    );

    if (variables.length === 0) {
        return (
            <div className="text-muted-foreground flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm">
                <Braces className="size-4" />
                <span>{t`No variables detected. Use ${VARIABLE_PLACEHOLDER} syntax to add dynamic content.`}</span>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {!isLoggedIn && (
                <Alert>
                    <AlertDescription>{t`Please log in to configure variables`}</AlertDescription>
                </Alert>
            )}
            <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                    <Braces className="size-4" />
                    {t`Variables`}
                    <Badge variant="secondary">{variables.length}</Badge>
                </Label>
                <Tooltip>
                    <TooltipTrigger render={<HelpCircle className="text-muted-foreground size-4" />} />
                    <TooltipContent className="max-w-xs">
                        {t`Define default values and descriptions for variables used in your prompt. These help others understand what values to provide.`}
                    </TooltipContent>
                </Tooltip>
            </div>

            <div className="space-y-2">
                {variables.map((variable, index) => (
                    <div className="bg-muted/50 grid gap-3 rounded-lg border p-3" key={variable.name}>
                        <div className="flex items-center justify-between">
                            <code className="bg-primary/10 text-primary rounded px-2 py-1 font-mono text-sm">{`{{${variable.name}}}`}</code>
                            <div className="flex items-center gap-2">
                                <div className="flex items-center gap-1.5">
                                    <Switch
                                        checked={variable.required ?? false}
                                        id={`required-${index}`}
                                        onCheckedChange={(checked) => handleUpdateVariable(index, { required: checked })}
                                    />
                                    <Label className="text-xs" htmlFor={`required-${index}`}>
                                        {t`Required`}
                                    </Label>
                                </div>
                                <Button onClick={() => handleRemoveVariable(index)} size="icon-sm" type="button" variant="ghost">
                                    <Trash2 className="size-4" />
                                </Button>
                            </div>
                        </div>

                        <div className="grid gap-2 sm:grid-cols-2">
                            <div className="space-y-1">
                                <Label className="text-xs" htmlFor={`default-${index}`}>
                                    {t`Default Value`}
                                </Label>
                                <Input
                                    id={`default-${index}`}
                                    onChange={(e) => handleUpdateVariable(index, { defaultValue: e.target.value })}
                                    placeholder={t`Enter default value...`}
                                    value={variable.defaultValue ?? ""}
                                />
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs" htmlFor={`desc-${index}`}>
                                    {t`Description`}
                                </Label>
                                <Input
                                    id={`desc-${index}`}
                                    onChange={(e) => handleUpdateVariable(index, { description: e.target.value })}
                                    placeholder={t`What this variable represents...`}
                                    value={variable.description ?? ""}
                                />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default VariableDefinitions;
