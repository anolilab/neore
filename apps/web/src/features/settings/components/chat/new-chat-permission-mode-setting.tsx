"use client";

/**
 * The permission mode a new chat starts with (`userSettings.defaultPermissionMode`). A chat that already exists keeps its own
 * mode; the mode of one chat is still changed in its composer. An admin acting as the owner cannot change the default.
 */

import { useLingui } from "@lingui/react/macro";
import type { ThreadPermissionMode } from "@neore/backend/chat/permission-mode";
import { isThreadPermissionMode, THREAD_PERMISSION_MODES } from "@neore/backend/chat/permission-mode";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import type { FC } from "react";
import { useId } from "react";

import { useIsImpersonating } from "@/features/admin/hooks/use-admin";
import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { showError } from "@/lib/toast";

const NewChatPermissionModeSetting: FC = () => {
    const { t } = useLingui();
    const { data: userSettings } = useUserSettings();
    const { data: impersonation } = useIsImpersonating();
    const updateUserSettings = useUpdateUserSettings();
    const titleId = useId();
    const descriptionId = useId();

    // An absent value is the defaults, which is Auto.
    const saved = userSettings?.defaultPermissionMode;
    const current: ThreadPermissionMode = isThreadPermissionMode(saved) ? saved : "auto";
    const impersonating = impersonation?.isImpersonating === true;

    const labels: Record<ThreadPermissionMode, string> = {
        auto: t`Auto`,
        full: t`Full access`,
        supervised: t`Supervised`,
    };

    const descriptions: Record<ThreadPermissionMode, string> = {
        auto: t`Tools run on their own settings; a quick check can clear low-risk calls`,
        full: t`Every tool runs without asking, except those that need your answer`,
        supervised: t`Anything that is not a plain lookup asks first`,
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle id={titleId}>{t`Default for new chats`}</CardTitle>
                <CardDescription id={descriptionId}>
                    {t`New chats start in this permission mode. A chat that already exists keeps its own mode, and you can still change a chat's mode in its composer.`}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                <ToggleGroup
                    aria-describedby={descriptionId}
                    aria-labelledby={titleId}
                    disabled={updateUserSettings.isPending || impersonating}
                    onValueChange={(value) => {
                        const next = value?.[0];

                        if (isThreadPermissionMode(next) && next !== current) {
                            updateUserSettings.mutate(
                                { defaultPermissionMode: next },
                                {
                                    onError: (error) => {
                                        showError(error instanceof Error ? error : t`Could not save the default permission mode`);
                                    },
                                },
                            );
                        }
                    }}
                    size="sm"
                    value={[current]}
                    variant="outline"
                >
                    {THREAD_PERMISSION_MODES.map((mode) => (
                        <ToggleGroupItem key={mode} value={mode}>
                            {labels[mode]}
                        </ToggleGroupItem>
                    ))}
                </ToggleGroup>
                <p className="text-muted-foreground text-sm">{descriptions[current]}</p>
                {impersonating && <p className="text-muted-foreground text-sm">{t`An admin acting as you cannot change this default.`}</p>}
            </CardContent>
        </Card>
    );
};

export default NewChatPermissionModeSetting;
