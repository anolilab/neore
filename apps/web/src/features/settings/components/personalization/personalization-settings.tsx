"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@neore/ui/components/field";
import { Input } from "@neore/ui/components/input";
import { Textarea } from "@neore/ui/components/textarea";
import { RotateCcw, Sparkles } from "lucide-react";
import type { FC } from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import SystemPromptOptimizerDialog from "@/features/chat/prompt-improvement/components/system-prompt-optimizer-dialog";
import { useUserPreferences } from "@/features/layout/hooks/use-ui-state";
import { trackEvent } from "@/lib/analytics";

import MemorySettings from "./memory-settings";

const MAX_ABOUT_ME_LENGTH = 2000;
const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 3000;
const MAX_NICKNAME_LENGTH = 50;
const MAX_PROFESSION_LENGTH = 100;

const PersonalizationSettings: FC = () => {
    const { t } = useLingui();
    const { data: userSettings, isLoading } = useUserSettings();
    const updateSettingsMutation = useUpdateUserSettings();
    const { onboardingCompleted, setOnboardingCompleted } = useUserPreferences();

    // Local state for form fields
    const [nickname, setNickname] = useState("");
    const [profession, setProfession] = useState("");
    const [aboutMe, setAboutMe] = useState("");
    const [customInstructions, setCustomInstructions] = useState("");
    const [isOptimizerOpen, setIsOptimizerOpen] = useState(false);

    const handleOptimizedSystemPrompt = useCallback(
        async (optimized: string) => {
            const trimmed = optimized.trim();

            setCustomInstructions(trimmed);

            // Let the mutation throw on failure — `SystemPromptOptimizerDialog` shows the
            // error toast. Re-throwing here would surface two toasts.
            await updateSettingsMutation.mutateAsync({ customInstructions: trimmed || undefined });
            trackEvent("settings_changed", { section: "personalization", setting_key: "customInstructions" });
        },
        [updateSettingsMutation],
    );

    // Sync local state with server data. Adjusted during render rather than in an
    // effect, so the fields never paint once with the previous value.
    const [syncedSettings, setSyncedSettings] = useState<typeof userSettings | undefined>(undefined);

    if (userSettings && userSettings !== syncedSettings) {
        setSyncedSettings(userSettings);
        setNickname(userSettings.nickname ?? "");
        setProfession(userSettings.profession ?? "");
        setAboutMe(userSettings.aboutMe ?? "");
        setCustomInstructions(userSettings.customInstructions ?? "");
    }

    const handleUpdateSetting = useCallback(
        async (key: string, value: string | undefined) => {
            try {
                await updateSettingsMutation.mutateAsync({ [key]: value || undefined });
                trackEvent("settings_changed", { section: "personalization", setting_key: key });
                toast.success(t`Settings saved`);
            } catch {
                toast.error(t`Failed to save settings`);
            }
        },
        [updateSettingsMutation, t],
    );

    const handleNicknameBlur = useCallback(() => {
        const trimmed = nickname.trim();

        if (trimmed !== (userSettings?.nickname ?? "")) {
            handleUpdateSetting("nickname", trimmed);
        }
    }, [nickname, userSettings?.nickname, handleUpdateSetting]);

    const handleProfessionBlur = useCallback(() => {
        const trimmed = profession.trim();

        if (trimmed !== (userSettings?.profession ?? "")) {
            handleUpdateSetting("profession", trimmed);
        }
    }, [profession, userSettings?.profession, handleUpdateSetting]);

    const handleAboutMeBlur = useCallback(() => {
        const trimmed = aboutMe.trim();

        if (trimmed !== (userSettings?.aboutMe ?? "")) {
            handleUpdateSetting("aboutMe", trimmed);
        }
    }, [aboutMe, userSettings?.aboutMe, handleUpdateSetting]);

    const handleCustomInstructionsBlur = useCallback(() => {
        const trimmed = customInstructions.trim();

        if (trimmed !== (userSettings?.customInstructions ?? "")) {
            handleUpdateSetting("customInstructions", trimmed);
        }
    }, [customInstructions, userSettings?.customInstructions, handleUpdateSetting]);

    if (isLoading) {
        return (
            <div className="space-y-6">
                <div className="animate-pulse">
                    <div className="bg-muted h-8 w-48 rounded" />
                    <div className="bg-muted mt-2 h-4 w-96 rounded" />
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <SettingsCard
                description={t`Help the AI understand you better by sharing some information about yourself. This information is used to personalize responses across all tasks.`}
                title={t`About You`}
            >
                <CardContent className="space-y-6">
                    <Field>
                        <FieldLabel htmlFor="nickname">{t`Nickname`}</FieldLabel>
                        <FieldDescription>{t`What should the AI call you?`}</FieldDescription>
                        <Input
                            id="nickname"
                            maxLength={MAX_NICKNAME_LENGTH}
                            onBlur={handleNicknameBlur}
                            onChange={(e) => setNickname(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                    e.currentTarget.blur();
                                }
                            }}
                            placeholder={t`Enter your nickname`}
                            type="text"
                            value={nickname}
                        />
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="profession">{t`Profession`}</FieldLabel>
                        <FieldDescription>{t`e.g., Product Designer, Software Developer`}</FieldDescription>
                        <Input
                            id="profession"
                            maxLength={MAX_PROFESSION_LENGTH}
                            onBlur={handleProfessionBlur}
                            onChange={(e) => setProfession(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                    e.currentTarget.blur();
                                }
                            }}
                            placeholder={t`Enter your profession`}
                            type="text"
                            value={profession}
                        />
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="about-me">{t`More About You`}</FieldLabel>
                        <FieldDescription>{t`Your background, preferences, or location to help the AI understand you better`}</FieldDescription>
                        <Textarea
                            expandable
                            expandableDialogTitle={t`More About You`}
                            id="about-me"
                            maxLength={MAX_ABOUT_ME_LENGTH}
                            onBlur={handleAboutMeBlur}
                            onChange={(e) => setAboutMe(e.target.value)}
                            placeholder={t`Tell us about yourself...`}
                            value={aboutMe}
                        />
                        <div className="text-muted-foreground mt-1 text-right text-xs">
                            {aboutMe.length} /{MAX_ABOUT_ME_LENGTH}
                        </div>
                    </Field>
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Define how you want the AI to respond. These instructions apply to all conversations.`} title={t`Custom Instructions`}>
                <CardContent className="space-y-4">
                    <Field>
                        <div className="flex items-center justify-between">
                            <FieldLabel htmlFor="custom-instructions">{t`How would you like the AI to respond?`}</FieldLabel>
                            <Button onClick={() => setIsOptimizerOpen(true)} size="sm" type="button" variant="outline">
                                <Sparkles aria-hidden="true" className="mr-1.5 size-3.5" />
                                {t`Optimize`}
                            </Button>
                        </div>
                        <FieldDescription>
                            {t`For example: "Focus on Python best practices", "Maintain a professional tone", or "Always cite sources for key conclusions".`}
                        </FieldDescription>
                        <Textarea
                            expandable
                            expandableDialogTitle={t`Custom Instructions`}
                            id="custom-instructions"
                            maxLength={MAX_CUSTOM_INSTRUCTIONS_LENGTH}
                            onBlur={handleCustomInstructionsBlur}
                            onChange={(e) => setCustomInstructions(e.target.value)}
                            placeholder={t`Enter your custom instructions...`}
                            value={customInstructions}
                        />
                        <div className="text-muted-foreground mt-1 text-right text-xs">
                            {customInstructions.length} /{MAX_CUSTOM_INSTRUCTIONS_LENGTH}
                        </div>
                    </Field>
                </CardContent>
            </SettingsCard>

            <SystemPromptOptimizerDialog
                initialPrompt={customInstructions}
                onApply={handleOptimizedSystemPrompt}
                onOpenChange={setIsOptimizerOpen}
                open={isOptimizerOpen}
                title={t`Optimize custom instructions`}
            />

            <MemorySettings />

            {onboardingCompleted && (
                <SettingsCard description={t`Replay the welcome tour to review the core features of Neore.`} title={t`Onboarding`}>
                    <CardContent>
                        <Button
                            onClick={() => {
                                setOnboardingCompleted(false);
                                toast.success(t`Onboarding will restart on your next visit to chat.`);
                            }}
                            size="sm"
                            variant="outline"
                        >
                            <RotateCcw aria-hidden="true" className="mr-2 size-4" />
                            {t`Replay Onboarding`}
                        </Button>
                    </CardContent>
                </SettingsCard>
            )}
        </div>
    );
};

export default PersonalizationSettings;
