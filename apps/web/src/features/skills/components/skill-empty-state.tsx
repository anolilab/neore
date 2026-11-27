"use client";

import { useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { Plus, Zap } from "lucide-react";

interface SkillEmptyStateProps {
    isLoggedIn?: boolean;
    onCreateSkill: () => void;
    skillCount?: {
        canCreate: boolean;
        count: number;
        isPremium: boolean;
        limit: number | null;
    } | null;
}

const SkillEmptyState = ({ isLoggedIn, onCreateSkill, skillCount }: SkillEmptyStateProps) => {
    const { t } = useLingui();

    return (
        <div className="surface-raised flex min-h-80 flex-col items-center justify-center gap-4 rounded-xl p-8 text-center">
            <div className="surface-well flex size-12 items-center justify-center rounded-xl">
                <Zap aria-hidden="true" className="text-muted-foreground size-6" />
            </div>
            <div className="space-y-2">
                <h2 className="text-[15px] font-semibold">{t`No skills yet`}</h2>
                <p className="text-muted-foreground max-w-sm text-sm">
                    {t`Create your first skill to automate workflows. Import from GitHub, upload SKILL.md files, or install from the official catalog.`}
                </p>
            </div>
            {!isLoggedIn && (
                <Alert className="max-w-sm">
                    <AlertDescription>{t`Please log in to create skills`}</AlertDescription>
                </Alert>
            )}
            {isLoggedIn && skillCount && !skillCount.isPremium && (
                <Alert className="max-w-sm">
                    <AlertDescription>
                        {skillCount.canCreate
                            ? t`Free accounts can create up to 5 skills. Upgrade to Pro for unlimited skills.`
                            : t`You've reached the free account limit of 5 skills. Upgrade to Pro to create more.`}
                    </AlertDescription>
                </Alert>
            )}
            <Button disabled={!isLoggedIn || (skillCount ? !skillCount.canCreate : false)} onClick={onCreateSkill}>
                <Plus className="mr-2 size-4" />
                {t`Create Skill`}
            </Button>
        </div>
    );
};

export default SkillEmptyState;
