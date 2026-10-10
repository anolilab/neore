"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Switch } from "@neore/ui/components/switch";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { useCallback, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import { getLocalizedError } from "../../lib/utilities";

// Common AI models - should match the backend
const AVAILABLE_MODELS = [
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-2.0-flash",
    "claude-3-haiku-20240307",
    "claude-3-5-sonnet-20241022",
    "claude-3-opus-20240229",
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4-turbo",
];

export interface TeamSettingsDialogProps {
    onOpenChange: (open: boolean) => void;
    open: boolean;
    teamId: string;
    teamName?: string;
}

const TeamSettingsDialog = ({ onOpenChange, open, teamId, teamName }: TeamSettingsDialogProps) => {
    const { toast } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    const { data: teamSettings, isPending } = useQuery(crpc.auth.team.getTeamSettings.queryOptions(open ? { teamId } : skipToken));

    const updateTeamSettingsMutation = useMutation(crpc.auth.team.updateTeamSettings.mutationOptions());

    const [inheritFromOrg, setInheritFromOrg] = useState(true);
    const [selectedModels, setSelectedModels] = useState<string[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Update local state when team settings load. Adjusted during render rather
    // than in an effect, so the form never paints once with the stale value.
    const [syncedSettings, setSyncedSettings] = useState<typeof teamSettings | undefined>(undefined);

    if (teamSettings && teamSettings !== syncedSettings) {
        setSyncedSettings(teamSettings);
        setInheritFromOrg(teamSettings.isInheriting);
        setSelectedModels(teamSettings.allowedModels ?? teamSettings.inheritedModels ?? []);
    }

    const handleAddModel = useCallback((model: string | null) => {
        if (model === null) {
            return;
        }

        setSelectedModels((previous) => {
            if (previous.includes(model)) {
                return previous;
            }

            return [...previous, model];
        });
    }, []);

    const handleRemoveModel = useCallback((model: string) => {
        setSelectedModels((previous) => previous.filter((m) => m !== model));
    }, []);

    const handleSubmit = async () => {
        setIsSubmitting(true);

        try {
            await updateTeamSettingsMutation.mutateAsync({
                allowedModels: inheritFromOrg ? null : selectedModels,
                teamId,
            });

            await queryClient.invalidateQueries({ queryKey: ["auth", "team"] });

            toast({
                message: t`Team settings updated successfully`,
                variant: "success",
            });

            onOpenChange(false);
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    // Get available models to choose from (subset of org models when not inheriting)
    const selectedModelSet = new Set(selectedModels);
    const availableModelsToAdd: string[] = inheritFromOrg
        ? []
        : (teamSettings?.inheritedModels ?? AVAILABLE_MODELS).filter((m: string) => !selectedModelSet.has(m));

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent>
                <DialogPanel>
                    <DialogHeader>
                        <DialogTitle>{t`Team Settings`}</DialogTitle>
                        <DialogDescription>{teamName ? t`Configure settings for team "${teamName}"` : t`Configure team settings`}</DialogDescription>
                    </DialogHeader>

                    {isPending ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-6 w-6 animate-spin" />
                        </div>
                    ) : (
                        <div className="space-y-4 py-4">
                            {/* Inherit from Organization Toggle */}
                            <div className="flex items-center justify-between">
                                <div className="space-y-0.5">
                                    <Label>{t`Inherit from Organization`}</Label>
                                    <p className="text-muted-foreground text-sm">{t`Use the organization's allowed models`}</p>
                                </div>
                                <Switch
                                    checked={inheritFromOrg}
                                    disabled={isSubmitting}
                                    onCheckedChange={(checked) => {
                                        setInheritFromOrg(checked);

                                        if (checked) {
                                            // Reset to inherited models when switching back
                                            setSelectedModels(teamSettings?.inheritedModels ?? []);
                                        }
                                    }}
                                />
                            </div>

                            {/* Organization Models Info */}
                            {inheritFromOrg && teamSettings?.inheritedModels && (
                                <div className="bg-muted/50 rounded-lg p-4">
                                    <div className="text-muted-foreground mb-2 text-sm">{t`Models inherited from organization:`}</div>
                                    <div className="flex flex-wrap gap-2">
                                        {teamSettings.inheritedModels.length > 0 ? (
                                            teamSettings.inheritedModels.map((model: string) => (
                                                <Badge key={model} variant="outline">
                                                    {model}
                                                </Badge>
                                            ))
                                        ) : (
                                            <span className="text-muted-foreground text-sm">{t`All models allowed (Enterprise)`}</span>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Custom Model Selection */}
                            {!inheritFromOrg && (
                                <div className="space-y-2">
                                    <Label>{t`Allowed AI Models`}</Label>
                                    <p className="text-muted-foreground text-xs">{t`Select a subset of the organization's allowed models for this team.`}</p>
                                    <div className="flex flex-wrap gap-2">
                                        {selectedModels.map((model) => (
                                            <Badge className="gap-1" key={model} variant="secondary">
                                                {model}
                                                <button
                                                    aria-label={t`Remove ${model}`}
                                                    className="hover:bg-muted ml-1 rounded-full p-0.5"
                                                    disabled={isSubmitting}
                                                    onClick={() => handleRemoveModel(model)}
                                                    type="button"
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </Badge>
                                        ))}
                                    </div>
                                    {availableModelsToAdd.length > 0 && (
                                        <Select disabled={isSubmitting} onValueChange={handleAddModel} value="">
                                            <SelectTrigger>
                                                <SelectValue placeholder={t`Add a model...`} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {availableModelsToAdd.map((model) => (
                                                    <SelectItem key={model} value={model}>
                                                        {model}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    <DialogFooter>
                        <Button disabled={isSubmitting} onClick={() => onOpenChange(false)} variant="outline">
                            {t`Cancel`}
                        </Button>
                        <Button disabled={isSubmitting || isPending} onClick={handleSubmit}>
                            {isSubmitting ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    {t`Saving...`}
                                </>
                            ) : (
                                t`Save`
                            )}
                        </Button>
                    </DialogFooter>
                </DialogPanel>
            </DialogContent>
        </Dialog>
    );
};

export default TeamSettingsDialog;
