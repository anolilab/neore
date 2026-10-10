"use client";

import { useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { FileText, Plus } from "lucide-react";

interface PromptEmptyStateProps {
    isLoggedIn?: boolean;
    onCreatePrompt: () => void;
    promptCount?: {
        canCreate: boolean;
        count: number;
        isPremium: boolean;
        limit: number | null;
    } | null;
}

const PromptEmptyState = ({ isLoggedIn, onCreatePrompt, promptCount }: PromptEmptyStateProps) => {
    const { t } = useLingui();

    return (
        <div className="flex h-96 flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8 text-center">
            <div className="bg-muted flex size-16 items-center justify-center rounded-full">
                <FileText className="text-muted-foreground size-8" />
            </div>
            <div className="space-y-2">
                <h3 className="text-lg font-semibold">{t`No prompts yet`}</h3>
                <p className="text-muted-foreground max-w-sm text-sm">
                    {t`Create your first prompt to use as a system prompt for your threads. You can also use them via slash commands.`}
                </p>
            </div>
            {!isLoggedIn && (
                <Alert className="max-w-sm">
                    <AlertDescription>{t`Please log in to create prompts`}</AlertDescription>
                </Alert>
            )}
            {isLoggedIn && promptCount && !promptCount.isPremium && (
                <Alert className="max-w-sm">
                    <AlertDescription>
                        {promptCount.canCreate
                            ? t`Free accounts can create up to 3 prompts. Upgrade to Pro for unlimited prompts.`
                            : t`You've reached the free account limit of 3 prompts. Upgrade to Pro to create more.`}
                    </AlertDescription>
                </Alert>
            )}
            <Button disabled={!isLoggedIn || (promptCount ? !promptCount.canCreate : false)} onClick={onCreatePrompt}>
                <Plus className="mr-2 size-4" />
                {t`Create Prompt`}
            </Button>
        </div>
    );
};

export default PromptEmptyState;
