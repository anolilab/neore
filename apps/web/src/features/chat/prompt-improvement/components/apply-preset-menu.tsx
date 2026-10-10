"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@neore/ui/components/dropdown-menu";
import { skipToken, useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronDown } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

interface ApplyPresetMenuProps {
    /** Whether the trigger is disabled. */
    disabled?: boolean;
    /** Current model id (if any). Used to surface model-specific + any-model presets. */
    modelId?: string;
    /** Called when the user picks a preset. The full prompt string is passed. */
    onApply: (prompt: string) => void | Promise<void>;
}

/**
 * Small "Load preset" dropdown that lists the user's saved system-prompt
 * presets and inserts the chosen one. Presets tied to a specific model id
 * are listed first when the host knows the current model.
 */
const ApplyPresetMenu: FC<ApplyPresetMenuProps> = ({ disabled, modelId, onApply }) => {
    const { t } = useLingui();
    const crpc = useCRPC();

    // Loaded when the menu opens, not when its (often closed, offcanvas) sidebar
    // mounts — every query on first paint queues on the `__root__` shard.
    const [open, setOpen] = useState(false);
    const { data: presets } = useQuery(crpc.system_prompts.functions.listPresets.queryOptions(open ? {} : skipToken));

    const list = presets ?? [];
    const matchingPresets = modelId ? list.filter((p) => p.modelId === modelId) : [];
    const otherPresets = modelId ? list.filter((p) => p.modelId !== modelId) : list;

    const totalCount = matchingPresets.length + otherPresets.length;

    return (
        <DropdownMenu onOpenChange={setOpen} open={open}>
            <DropdownMenuTrigger
                disabled={disabled}
                render={
                    <Button size="sm" type="button" variant="outline">
                        <BookOpen aria-hidden="true" className="mr-1.5 size-3.5" />
                        {t`Load preset`}
                        <ChevronDown aria-hidden="true" className="ml-1 size-3" />
                    </Button>
                }
            />
            <DropdownMenuContent align="end" className="w-72">
                {presets === undefined && <DropdownMenuLabel className="text-muted-foreground font-normal">{t`Loading presets…`}</DropdownMenuLabel>}
                {presets !== undefined && totalCount === 0 ? (
                    <DropdownMenuLabel className="text-muted-foreground font-normal">{t`No presets yet. Create one from settings.`}</DropdownMenuLabel>
                ) : (
                    <>
                        {matchingPresets.length > 0 && (
                            <>
                                <DropdownMenuLabel>{t`For this model`}</DropdownMenuLabel>
                                {matchingPresets.map((preset) => (
                                    <DropdownMenuItem
                                        key={preset._id}
                                        onClick={() => {
                                            // The host's onApply returns a Promise we deliberately don't await
                                            // (DropdownMenuItem onClick is fire-and-forget). Wire a `.catch` so a
                                            // rejected save surfaces as a toast instead of an unhandled rejection.
                                            Promise.resolve(onApply(preset.prompt))
                                                .then(() => toast.success(t`Preset applied`))
                                                .catch((error: unknown) => {
                                                    const message = error instanceof Error ? error.message : t`Failed to apply preset`;

                                                    toast.error(message);
                                                });
                                        }}
                                    >
                                        <div className="flex min-w-0 flex-col">
                                            <span className="truncate">{preset.name}</span>
                                            {preset.description && <span className="text-muted-foreground truncate text-xs">{preset.description}</span>}
                                        </div>
                                    </DropdownMenuItem>
                                ))}
                                {otherPresets.length > 0 && <DropdownMenuSeparator />}
                            </>
                        )}
                        {otherPresets.length > 0 && (
                            <>
                                <DropdownMenuLabel>{matchingPresets.length > 0 ? t`Other presets` : t`Presets`}</DropdownMenuLabel>
                                {otherPresets.map((preset) => (
                                    <DropdownMenuItem
                                        key={preset._id}
                                        onClick={() => {
                                            // The host's onApply returns a Promise we deliberately don't await
                                            // (DropdownMenuItem onClick is fire-and-forget). Wire a `.catch` so a
                                            // rejected save surfaces as a toast instead of an unhandled rejection.
                                            Promise.resolve(onApply(preset.prompt))
                                                .then(() => toast.success(t`Preset applied`))
                                                .catch((error: unknown) => {
                                                    const message = error instanceof Error ? error.message : t`Failed to apply preset`;

                                                    toast.error(message);
                                                });
                                        }}
                                    >
                                        <div className="flex min-w-0 flex-col">
                                            <span className="truncate">{preset.name}</span>
                                            {preset.description && <span className="text-muted-foreground truncate text-xs">{preset.description}</span>}
                                        </div>
                                    </DropdownMenuItem>
                                ))}
                            </>
                        )}
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default ApplyPresetMenu;
