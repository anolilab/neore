"use client";

import { useLingui } from "@lingui/react/macro";
import { MAX_THREAD_TITLE_INSTRUCTIONS_LENGTH } from "@neore/ai/constants";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@neore/ui/components/field";
import { Input } from "@neore/ui/components/input";
import { Textarea } from "@neore/ui/components/textarea";
import { RotateCcw, Sparkles } from "lucide-react";
import type { FC } from "react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import SystemPromptOptimizerDialog from "@/features/chat/prompt-improvement/components/system-prompt-optimizer-dialog";
import { useUserPreferences } from "@/features/layout/hooks/use-ui-state";
import { trackEvent } from "@/lib/analytics";

import MemorySettings from "./memory-settings";

const MAX_ABOUT_ME_LENGTH = 2000;
const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 3000;
const MAX_NICKNAME_LENGTH = 50;
const MAX_PROFESSION_LENGTH = 100;

const SYNCED_FIELDS = ["nickname", "profession", "aboutMe", "customInstructions"] as const;

type SyncedField = (typeof SYNCED_FIELDS)[number];

/** Text typed into the title field, with the account it was typed for. */
interface TitleInstructions {
    ownerId: string | null;
    text: string;
}

const PersonalizationSettings: FC = () => {
    const { t } = useLingui();
    const { authClient } = useAuth();
    const { data: sessionData } = useSession(authClient);
    // Whose settings the page is showing. Text and saves belong to one account: signing in over a guest keeps this page mounted.
    const ownerId = sessionData?.user?.id ?? null;
    const { data: userSettings, isLoading } = useUserSettings();
    const updateSettingsMutation = useUpdateUserSettings();
    const { onboardingCompleted, setOnboardingCompleted } = useUserPreferences();

    // Local state for form fields
    const [nickname, setNickname] = useState("");
    const [profession, setProfession] = useState("");
    const [aboutMe, setAboutMe] = useState("");
    const [customInstructions, setCustomInstructions] = useState("");
    // Not part of the render-time sync below: a draft (`null` = not editing) shadows the stored value, so a
    // cache update from an earlier save can never replace text typed since. It is dropped when the account changes.
    const [draftState, setDraftState] = useState<TitleInstructions | null>(null);
    // The value of the newest save that has not settled yet. The cached setting may not show it for a moment,
    // so a blur compares against this first: changing the text and changing it back must still send the reversal.
    const submittedTitleInstructions = useRef<TitleInstructions | null>(null);
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

    // Sync each local field only when its own server value changed, so saving one
    // setting does not wipe text typed into another. Adjusted during render rather
    // than in an effect, so the fields never paint once with the previous value.
    const [lastSynced, setLastSynced] = useState<Partial<Record<SyncedField, string>>>({});

    if (userSettings) {
        const server: Record<SyncedField, string> = {
            aboutMe: userSettings.aboutMe ?? "",
            customInstructions: userSettings.customInstructions ?? "",
            nickname: userSettings.nickname ?? "",
            profession: userSettings.profession ?? "",
        };
        const setters: Record<SyncedField, (value: string) => void> = {
            aboutMe: setAboutMe,
            customInstructions: setCustomInstructions,
            nickname: setNickname,
            profession: setProfession,
        };
        const changed = SYNCED_FIELDS.filter((field) => server[field] !== lastSynced[field]);

        if (changed.length > 0) {
            setLastSynced(server);

            for (const field of changed) {
                setters[field](server[field]);
            }
        }
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

    if (draftState && draftState.ownerId !== ownerId) {
        setDraftState(null);
    }

    const titleInstructionsDraft = draftState && draftState.ownerId === ownerId ? draftState.text : null;
    const threadTitleInstructions = titleInstructionsDraft ?? userSettings?.threadTitleInstructions ?? "";

    // Sent as "" to clear: `handleUpdateSetting` maps blank to `undefined`, which the wire drops, so the old text would stay.
    // `updateLatest` queues the write behind earlier ones and sends the newest value, so a slow save cannot land last.
    const handleThreadTitleInstructionsBlur = useCallback(async () => {
        if (titleInstructionsDraft === null) {
            return;
        }

        const trimmed = titleInstructionsDraft.trim();
        const submitted = submittedTitleInstructions.current?.ownerId === ownerId ? submittedTitleInstructions.current : null;
        const current = submitted?.text ?? userSettings?.threadTitleInstructions ?? "";

        if (trimmed === current) {
            if (submitted === null) {
                setDraftState(null);
            }

            return;
        }

        const own = { ownerId, text: trimmed };

        submittedTitleInstructions.current = own;

        try {
            await updateSettingsMutation.updateLatest(() => {
                return { threadTitleInstructions: trimmed };
            });
            trackEvent("settings_changed", { section: "personalization", setting_key: "threadTitleInstructions" });
            toast.success(t`Settings saved`);
            // Drop the draft only if nothing was typed while the save was pending.
            setDraftState((latest) => (latest !== null && latest.ownerId === ownerId && latest.text.trim() === trimmed ? null : latest));
        } catch {
            toast.error(t`Failed to save settings`);
        } finally {
            if (submittedTitleInstructions.current === own) {
                submittedTitleInstructions.current = null;
            }
        }
    }, [titleInstructionsDraft, ownerId, userSettings?.threadTitleInstructions, updateSettingsMutation, t]);

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

            <SettingsCard
                description={t`Tell the AI how to word the titles it gives new conversations. This adds to the default title style.`}
                title={t`Thread Titles`}
            >
                <CardContent className="space-y-4">
                    <Field>
                        <FieldLabel htmlFor="thread-title-instructions">{t`How should titles be written?`}</FieldLabel>
                        <FieldDescription>{t`For example: "Keep titles under four words", "Write titles in German", or "Start with a verb".`}</FieldDescription>
                        <Input
                            id="thread-title-instructions"
                            maxLength={MAX_THREAD_TITLE_INSTRUCTIONS_LENGTH}
                            onBlur={handleThreadTitleInstructionsBlur}
                            onChange={(e) => setDraftState({ ownerId, text: e.target.value })}
                            placeholder={t`Enter your title instructions...`}
                            value={threadTitleInstructions}
                        />
                        <div className="text-muted-foreground mt-1 text-right text-xs">
                            {threadTitleInstructions.length} /{MAX_THREAD_TITLE_INSTRUCTIONS_LENGTH}
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
