"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Doc } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Switch } from "@neore/ui/components/switch";
import cn from "@neore/ui/utils/cn";
import { Download, Edit, FileDown, GitFork, PackageMinus, Trash2, Zap } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { useCRPCClient } from "@/lib/lunora/crpc";

export type ListedSkill = {
    /** Owner, or an admin of the organization it is shared with. Decided by the backend. */
    canEdit?: boolean;
    enabled?: boolean;
    /** Another user's marketplace skill this user installed. Read-only here — fork to change it. */
    isInstalled?: boolean;
} & Doc<"skills">;

interface SkillItemProps {
    /** Owners may delete; organization admins may only edit (see `ListedSkill.canEdit`). */
    canDelete: boolean;
    /** Disables the fork/uninstall buttons while one of them is in flight. */
    isBusy?: boolean;
    onDelete: (skill: ListedSkill) => void;
    onEdit: (skill: ListedSkill) => void;
    /** Downloads the skill as SKILL.md (or a .zip with its files). */
    onExport: (skill: ListedSkill) => void;
    onFork: (skill: ListedSkill) => void;
    onUninstall: (skill: ListedSkill) => void;
    skill: ListedSkill;
}

const SkillItem = ({ canDelete, isBusy = false, onDelete, onEdit, onExport, onFork, onUninstall, skill }: SkillItemProps) => {
    const { t } = useLingui();
    const crpcClient = useCRPCClient();
    // Enabled state comes from the skill (joined from userSkills table). A local override holds
    // the optimistic value until the server value catches up, so no effect syncs prop -> state.
    // Off when unknown: a skill shared with the organization is opt-in per member.
    const serverEnabled = skill.enabled ?? false;
    const [enabledOverride, setEnabledOverride] = useState<boolean | null>(null);
    const [syncedEnabled, setSyncedEnabled] = useState(serverEnabled);

    if (syncedEnabled !== serverEnabled) {
        setSyncedEnabled(serverEnabled);
        setEnabledOverride(null);
    }

    const isEnabled = enabledOverride ?? serverEnabled;

    const handleToggleEnabled = useCallback(
        async (checked: boolean) => {
            try {
                setEnabledOverride(checked); // Optimistic update

                // Lunora flattens namespaces: `skills/functions` -> `api.skills.functions`.
                await crpcClient.mutation(api.skills.functions.setSkillEnabled, {
                    enabled: checked,
                    skillId: skill._id,
                });

                toast.success(checked ? t`Skill enabled` : t`Skill disabled`);
            } catch {
                setEnabledOverride(null); // Revert to the server value on error
                toast.error(t`Failed to update skill`);
            }
        },
        [crpcClient, skill._id, t],
    );

    const sourceType = skill.source.type;
    const sourceLabel =
        (
            {
                editor: t`Created`,
                github: t`GitHub`,
                official: t`Official`,
                upload: t`Uploaded`,
            } as Record<string, string>
        )[sourceType] || sourceType;

    return (
        <Card className={cn("group relative transition-all hover:shadow-md", isEnabled && "ring-primary/20 ring-1")}>
            <CardHeader className="space-y-3 pb-3">
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <div aria-hidden="true" className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-md">
                            {skill.icon || <Zap className="size-4" />}
                        </div>
                        <div>
                            <CardTitle className="text-base">{skill.name}</CardTitle>
                            <code className="text-muted-foreground text-xs">/{skill.slug}</code>
                        </div>
                    </div>
                    <Switch aria-label={t`Enable ${skill.name}`} checked={isEnabled} className="shrink-0" onCheckedChange={handleToggleEnabled} />
                </div>
                <CardDescription className="line-clamp-2 text-sm">{skill.description}</CardDescription>
            </CardHeader>

            <CardContent className="space-y-3 pt-0">
                {/* Metadata */}
                <div className="flex flex-wrap gap-2">
                    {skill.category && (
                        <Badge className="text-xs" variant="secondary">
                            {skill.category}
                        </Badge>
                    )}
                    <Badge className="text-xs" variant="outline">
                        {sourceLabel}
                    </Badge>
                    {skill.isInstalled && (
                        <Badge className="text-xs" variant="secondary">
                            <Download aria-hidden="true" className="mr-1 size-3" />
                            {t`Installed`}
                        </Badge>
                    )}
                    {skill.visibility === "public" && !skill.isInstalled && (
                        <Badge className="text-xs" variant="outline">
                            {t`Public`}
                        </Badge>
                    )}
                    {skill.visibility === "organization" && (
                        <Badge className="text-xs" variant="outline">
                            {t`Organization`}
                        </Badge>
                    )}
                    {skill.config?.searchMode && (
                        <Badge className="text-xs" variant="outline">
                            {skill.config.searchMode}
                        </Badge>
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between border-t pt-3">
                    <div className="text-muted-foreground flex items-center gap-2 text-xs">
                        <span>{skill.category || t`Uncategorized`}</span>
                    </div>
                    {skill.isInstalled ? (
                        <div className="flex items-center gap-1">
                            <Button
                                aria-label={t`Fork ${skill.name} to edit a copy`}
                                className="size-8 p-0"
                                disabled={isBusy}
                                onClick={() => onFork(skill)}
                                size="sm"
                                title={t`Fork to edit`}
                                variant="ghost"
                            >
                                <GitFork aria-hidden="true" className="size-4" />
                            </Button>
                            <Button
                                aria-label={t`Uninstall ${skill.name}`}
                                className="size-8 p-0"
                                disabled={isBusy}
                                onClick={() => onUninstall(skill)}
                                size="sm"
                                title={t`Uninstall`}
                                variant="ghost"
                            >
                                <PackageMinus aria-hidden="true" className="size-4" />
                            </Button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-1">
                            <Button
                                aria-label={t`Export ${skill.name}`}
                                className="size-8 p-0"
                                disabled={isBusy}
                                onClick={() => onExport(skill)}
                                size="sm"
                                title={t`Export as SKILL.md`}
                                variant="ghost"
                            >
                                <FileDown aria-hidden="true" className="size-4" />
                            </Button>
                            {skill.canEdit && (
                                <Button aria-label={t`Edit ${skill.name}`} className="size-8 p-0" onClick={() => onEdit(skill)} size="sm" variant="ghost">
                                    <Edit aria-hidden="true" className="size-4" />
                                </Button>
                            )}
                            {canDelete && (
                                <Button
                                    aria-label={t`Delete ${skill.name}`}
                                    className="text-destructive hover:text-destructive size-8 p-0"
                                    onClick={() => onDelete(skill)}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <Trash2 aria-hidden="true" className="size-4" />
                                </Button>
                            )}
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
};

export default SkillItem;
