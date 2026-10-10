"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Command, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandSeparator } from "@neore/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@neore/ui/components/responsive-popover";
import { Braces, Plus } from "lucide-react";
import { useState } from "react";

import type { PromptVariable } from "../lib/prompt-variables";
import { formatVariable, getCommonVariableCategories } from "../lib/prompt-variables";

const NON_IDENTIFIER_START_RE = /^[^a-z_]/i;

const EMPTY_CUSTOM_VARIABLES: PromptVariable[] = [];

interface VariableInsertionProps {
    customVariables?: PromptVariable[];
    onInsert: (variable: string) => void;
}

const VariableInsertion = ({ customVariables = EMPTY_CUSTOM_VARIABLES, onInsert }: VariableInsertionProps) => {
    const { i18n, t } = useLingui();
    const [open, setOpen] = useState(false);
    const commonVariableCategories = getCommonVariableCategories(i18n);
    const [customName, setCustomName] = useState("");

    const handleSelect = (variableName: string) => {
        onInsert(formatVariable(variableName));
        setOpen(false);
    };

    const handleCreateCustom = () => {
        if (!customName.trim()) {
            return;
        }

        // Sanitize the variable name
        const sanitized = customName
            .trim()
            .replaceAll(/[^\w.]/g, "_")
            .replace(NON_IDENTIFIER_START_RE, "_");

        onInsert(formatVariable(sanitized));
        setCustomName("");
        setOpen(false);
    };

    return (
        <Popover onOpenChange={setOpen} open={open}>
            <PopoverTrigger
                render={
                    <Button size="sm" type="button" variant="outline">
                        <Braces className="mr-2 size-4" />
                        {t`Insert Variable`}
                    </Button>
                }
            />
            <PopoverContent align="start" className="w-80 p-0">
                <Command>
                    <CommandInput onChange={(e) => setCustomName(e.target.value)} placeholder={t`Search or create variable...`} value={customName} />
                    <CommandList>
                        <CommandEmpty>
                            <div className="p-2">
                                <p className="text-muted-foreground mb-2 text-sm">{t`No matching variable found.`}</p>
                                {customName.trim() && (
                                    <Button className="w-full" onClick={handleCreateCustom} size="sm" variant="secondary">
                                        <Plus className="mr-2 size-4" />
                                        {t`Create`} <code className="mx-1">{`{{${customName.trim()}}}`}</code>
                                    </Button>
                                )}
                            </div>
                        </CommandEmpty>

                        {/* Custom variables from the current prompt */}
                        {customVariables.length > 0 && (
                            <>
                                <CommandGroup>
                                    <CommandGroupLabel>{t`Current Prompt Variables`}</CommandGroupLabel>
                                    {customVariables.map((variable) => (
                                        <CommandItem key={variable.name} onSelect={() => handleSelect(variable.name)} value={variable.name}>
                                            <code className="text-primary mr-2 font-mono text-sm">{`{{${variable.name}}}`}</code>
                                            {variable.description && <span className="text-muted-foreground text-xs">{variable.description}</span>}
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                                <CommandSeparator />
                            </>
                        )}

                        {/* Common variable categories */}
                        {Object.entries(commonVariableCategories).map(([categoryKey, category]) => (
                            <CommandGroup key={categoryKey}>
                                <CommandGroupLabel>{category.description}</CommandGroupLabel>
                                {category.variables.map((variable) => (
                                    <CommandItem key={variable.name} onSelect={() => handleSelect(variable.name)} value={variable.name}>
                                        <code className="text-primary mr-2 font-mono text-sm">{`{{${variable.name}}}`}</code>
                                        <span className="text-muted-foreground text-xs">{variable.description}</span>
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        ))}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};

export default VariableInsertion;
