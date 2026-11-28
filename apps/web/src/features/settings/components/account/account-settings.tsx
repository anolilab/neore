"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { Input } from "@neore/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Slider } from "@neore/ui/components/slider";
import { Switch } from "@neore/ui/components/switch";
import type { FC } from "react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
import AppearanceControls from "@/features/appearance/components/appearance-controls";
import ColorModePicker from "@/features/appearance/components/color-mode-picker";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { createLanguageList } from "@/features/chat/core/utils/language-utilities";
import { DEFAULT_SPEECH_VOICE, SPEECH_VOICES, speechVoiceLabel } from "@/features/chat/voice-mode/tts-availability";
import { useLayoutState, useUserPreferences } from "@/features/layout/hooks/use-ui-state";
import NotificationSettings from "@/features/notifications/components/notification-settings";
import ChatActionConfirmControls from "@/features/settings/components/chat/chat-action-confirm-settings";
import ChatLifecycleControls from "@/features/settings/components/chat/chat-lifecycle-settings";

// BCP 47 defaults for each supported UI locale. Hoisted to avoid recreation on every render.
const LOCALE_DEFAULTS: Record<string, string> = { de: "de-DE", en: "en-US" };

/** Browser timezone, or a fixed fallback where `Intl` is unavailable (SSR). */
const getBrowserTimezone = (): string => {
    if (typeof Intl !== "undefined" && Intl.DateTimeFormat) {
        return new Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    return "America/New_York";
};

/** Off, then the presets; the server accepts any whole number from 50 to 95. */
const AUTO_COMPACT_PERCENTS = [0, 60, 70, 80, 90] as const;

const AccountSettings: FC = () => {
    const { i18n, t } = useLingui();
    const {
        hidePersonalInfo,
        sendBehavior,
        setHidePersonalInfo,
        setSendBehavior,
        setShowTimestamps,
        setSoundEffects,
        setSplitViewEnabled,
        setTemporaryChatRetentionHours,
        showTimestamps,
        soundEffects,
        splitViewEnabled,
    } = useUserPreferences();
    const userSettingsQuery = useUserSettings();
    const userSettings = userSettingsQuery.data;
    const retentionHours = userSettings?.temporaryChatRetentionHours ?? 24;
    const [retentionInput, setRetentionInput] = useState(retentionHours.toString());
    const { direction, setDirection } = useLayoutState();
    const updateUserSettings = useUpdateUserSettings();
    const { isAnonymous } = useIsAnonymous();

    // Language options
    const languages = useMemo(() => createLanguageList(i18n, t), [i18n, t]);
    // O(1) label lookup used by the SelectValue render functions below
    const languageMap = useMemo(() => new Map(languages.map((l) => [l.value, l.label])), [languages]);

    // Simple primitive derivation — no useMemo needed (rule: don't memo simple expressions)
    const locale = i18n.locale ?? "en";
    const percentFormat = new Intl.NumberFormat(locale, { style: "percent" });
    const localeLanguageDefault = LOCALE_DEFAULTS[locale] ?? `${locale}-${locale.toUpperCase()}`;

    // Get current values from userSettings, falling back to the UI locale default
    const currentLanguage = userSettings?.language || localeLanguageDefault;
    const currentDictationLanguage = userSettings?.dictationLanguage || localeLanguageDefault;
    const currentLocation = userSettings?.location;
    const currentTimezone = userSettings?.timezone;
    const isEnableFollowupSuggestions = userSettings?.enableFollowupSuggestions !== false;
    // OPT-IN: absent means off, matching the backend gate (`agent/thread-summaries.ts`).
    const isThreadSummariesEnabled = userSettings?.threadSummariesEnabled === true;
    // Off (0) or a percentage of the model's context window; absent means off.
    const autoCompactThreshold = userSettings?.autoCompactThreshold ?? 0;
    // Opt-in: absent means off.
    const isAutoReadReplies = userSettings?.autoReadReplies === true;
    const currentSpeechVoice = userSettings?.voiceModeVoice ?? DEFAULT_SPEECH_VOICE ?? null;
    // OPT-IN: absent is off — every suggestion sends the draft to a model.
    const isComposerAutocompleteEnabled = userSettings?.composerAutocompleteEnabled === true;
    const isResumeLastChat = userSettings?.resumeLastChat === true;
    // Absent means on: a reply interrupted by a deploy or crash continues by itself.
    const isResumeInterruptedRuns = userSettings?.resumeInterruptedRuns !== false;
    // Absent means on: a reply paused by a usage limit resumes by itself once the limit resets.
    const isResumeAfterUsageLimit = userSettings?.resumeAfterUsageLimit !== false;
    // Opt-in: absent means off.
    const isSnoozeUntilUsageLimitReset = userSettings?.snoozeUntilUsageLimitReset === true;
    // Opt-in: absent means a message sent during a coding agent's turn waits in the queue behind it.
    const isHostFollowUpSteer = userSettings?.hostFollowUpSteer === true;
    const isFollowUpSteer = userSettings?.followUpSteer === true;
    // Opt-in: absent means off.
    const isComposerVimMode = userSettings?.composerVimMode === true;

    // Common timezones
    const commonTimezones = useMemo(
        () => [
            { label: t`Eastern Time (US & Canada)`, value: "America/New_York" },
            { label: t`Central Time (US & Canada)`, value: "America/Chicago" },
            { label: t`Mountain Time (US & Canada)`, value: "America/Denver" },
            { label: t`Pacific Time (US & Canada)`, value: "America/Los_Angeles" },
            { label: t`Toronto`, value: "America/Toronto" },
            { label: t`Vancouver`, value: "America/Vancouver" },
            { label: t`London`, value: "Europe/London" },
            { label: t`Paris`, value: "Europe/Paris" },
            { label: t`Berlin`, value: "Europe/Berlin" },
            { label: t`Rome`, value: "Europe/Rome" },
            { label: t`Madrid`, value: "Europe/Madrid" },
            { label: t`Amsterdam`, value: "Europe/Amsterdam" },
            { label: t`Stockholm`, value: "Europe/Stockholm" },
            { label: t`Zurich`, value: "Europe/Zurich" },
            { label: t`Tokyo`, value: "Asia/Tokyo" },
            { label: t`Shanghai`, value: "Asia/Shanghai" },
            { label: t`Hong Kong`, value: "Asia/Hong_Kong" },
            { label: t`Singapore`, value: "Asia/Singapore" },
            { label: t`Dubai`, value: "Asia/Dubai" },
            { label: t`Mumbai, Kolkata`, value: "Asia/Kolkata" },
            { label: t`Sydney`, value: "Australia/Sydney" },
            { label: t`Melbourne`, value: "Australia/Melbourne" },
            { label: t`Auckland`, value: "Pacific/Auckland" },
        ],
        [t],
    );

    // Get browser timezone as default
    const browserTimezone = getBrowserTimezone();

    const handleUpdateSetting = useCallback(
        (key: string, value: unknown, successMessage: string, failFast = false) => {
            // A fail-fast write goes through the same queue as every settings write, so edits land in order. It is sent at once
            // and reports the failure while offline, instead of waiting for the connection.
            if (failFast) {
                void updateUserSettings
                    .updateLatest(
                        () => {
                            return { [key]: value };
                        },
                        { failFast: true },
                    )
                    .then(() => toast.success(successMessage))
                    .catch(() => toast.error(t`Failed to save settings`));

                return;
            }

            updateUserSettings.mutate(
                { [key]: value },
                {
                    onError: () => toast.error(t`Failed to save settings`),
                    onSuccess: () => toast.success(successMessage),
                },
            );
        },
        [updateUserSettings, t],
    );

    return (
        <div className="space-y-6">
            <SettingsCard description={t`Customize the appearance of the application.`} title={t`Appearance`}>
                <CardContent className="space-y-4">
                    <ColorModePicker />
                    <AppearanceControls />
                    <SettingsRow
                        control={
                            <Select
                                onValueChange={(value) => {
                                    setDirection(value as typeof direction);
                                    toast.success(value === "rtl" ? t`Text direction set to RTL` : t`Text direction set to LTR`);
                                }}
                                value={direction}
                            >
                                <SelectTrigger id="direction">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="ltr">{t`Left to Right (LTR)`}</SelectItem>
                                    <SelectItem value="rtl">{t`Right to Left (RTL)`}</SelectItem>
                                </SelectContent>
                            </Select>
                        }
                        description={t`Set the text direction for the application. RTL is used for languages like Arabic, Hebrew, and Persian.`}
                        htmlFor="direction"
                        title={t`Text Direction`}
                    />
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Control how your personal information is displayed in the UI.`} title={t`Privacy`}>
                <CardContent className="space-y-4">
                    <SettingsRow
                        control={
                            <Switch
                                checked={hidePersonalInfo}
                                id="hide-personal-info"
                                onCheckedChange={(checked) => {
                                    setHidePersonalInfo(checked);
                                    toast.success(checked ? t`Personal information is now hidden` : t`Personal information is now visible`);
                                }}
                            />
                        }
                        description={t`Hides your name and email from the UI.`}
                        htmlFor="hide-personal-info"
                        title={t`Hide Personal Information`}
                    />
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Configure how the application behaves.`} title={t`Behavior`}>
                <CardContent className="space-y-4">
                    <SettingsRow
                        control={
                            <Select
                                onValueChange={(value) => {
                                    setSendBehavior(value as typeof sendBehavior);
                                    toast.success(t`Send behavior updated`);
                                }}
                                value={sendBehavior}
                            >
                                <SelectTrigger id="send-behavior">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="enter">{t`Press Enter to send`}</SelectItem>
                                    <SelectItem value="shiftEnter">{t`Press Shift+Enter to send`}</SelectItem>
                                    <SelectItem value="modEnter">{t`Press Ctrl/Cmd+Enter to send`}</SelectItem>
                                    <SelectItem value="button">{t`Click button to send`}</SelectItem>
                                </SelectContent>
                            </Select>
                        }
                        description={t`Choose how to send messages in the chat. Cmd/Ctrl+Enter always sends.`}
                        htmlFor="send-behavior"
                        title={t`Send Message Behavior`}
                    />
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Configure language preferences and location settings.`} title={t`Language & Localization`}>
                <CardContent className="space-y-4">
                    <SettingsRow
                        control={
                            <Select
                                onValueChange={(value) => {
                                    handleUpdateSetting("language", value, t`Default language updated`);
                                }}
                                value={currentLanguage}
                            >
                                <SelectTrigger id="language">
                                    <SelectValue placeholder={t`Select language`}>
                                        {(value: string | null) => (value ? (languageMap.get(value) ?? value) : null)}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    {languages.map((lang) => (
                                        <SelectItem key={lang.value} value={lang.value}>
                                            {lang.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        }
                        description={t`Default language for AI responses in new threads (BCP 47 code).`}
                        htmlFor="language"
                        title={t`Default AI Response Language`}
                    />
                    <SettingsRow
                        control={
                            <Select
                                onValueChange={(value) => {
                                    handleUpdateSetting("dictationLanguage", value, t`Dictation language updated`);
                                }}
                                value={currentDictationLanguage}
                            >
                                <SelectTrigger id="dictation-language">
                                    <SelectValue placeholder={t`Select dictation language`}>
                                        {(value: string | null) => (value ? (languageMap.get(value) ?? value) : null)}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    {languages.map((lang) => (
                                        <SelectItem key={lang.value} value={lang.value}>
                                            {lang.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        }
                        description={t`Default dictation language for new threads (BCP 47 code).`}
                        htmlFor="dictation-language"
                        title={t`Default Dictation Language`}
                    />
                    <SettingsRow description={t`Your location (e.g., "New York, USA", "Berlin, Germany").`} htmlFor="location" title={t`Location`}>
                        <Input
                            defaultValue={currentLocation || ""}
                            id="location"
                            onBlur={(e) => {
                                const value = e.target.value.trim();

                                if (value !== currentLocation) {
                                    handleUpdateSetting("location", value || undefined, t`Location updated`);
                                }
                            }}
                            onKeyDown={(e) => {
                                if (e.nativeEvent.isComposing) {
                                    return;
                                }

                                if (e.key === "Enter") {
                                    e.currentTarget.blur();
                                }
                            }}
                            placeholder={t`Enter your location`}
                            type="text"
                        />
                    </SettingsRow>
                    <SettingsRow
                        control={
                            <Select
                                onValueChange={(value) => {
                                    handleUpdateSetting("timezone", value, t`Timezone updated`);
                                }}
                                value={currentTimezone || browserTimezone}
                            >
                                <SelectTrigger id="timezone">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {commonTimezones.map((tz) => (
                                        <SelectItem key={tz.value} value={tz.value}>
                                            {tz.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        }
                        description={t`Your timezone (IANA timezone identifier).`}
                        htmlFor="timezone"
                        title={t`Timezone`}
                    />
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Configure chat behavior and preferences.`} title={t`Chat`}>
                <CardContent className="space-y-4">
                    <SettingsRow
                        control={
                            <Switch
                                checked={isEnableFollowupSuggestions}
                                id="enable-followup-suggestions"
                                onCheckedChange={(checked) => {
                                    handleUpdateSetting(
                                        "enableFollowupSuggestions",
                                        checked,
                                        checked ? t`Follow-up suggestions enabled` : t`Follow-up suggestions disabled`,
                                    );
                                }}
                            />
                        }
                        description={t`Show follow-up suggestions after assistant messages.`}
                        htmlFor="enable-followup-suggestions"
                        title={t`Enable Follow-up Suggestions`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                aria-describedby="thread-summaries-description"
                                checked={isThreadSummariesEnabled}
                                id="thread-summaries"
                                onCheckedChange={(checked) => {
                                    handleUpdateSetting(
                                        "threadSummariesEnabled",
                                        checked,
                                        checked ? t`Long chats will be summarised` : t`Long chats will no longer be summarised`,
                                    );
                                }}
                            />
                        }
                        description={t`Off by default. While a long chat sits idle, condense its older messages into notes so the assistant keeps them in mind. Uses a small amount of credits. Turning it off deletes the summaries already made.`}
                        descriptionId="thread-summaries-description"
                        htmlFor="thread-summaries"
                        title={t`Summarise long chats`}
                    />
                    <SettingsRow
                        control={
                            <Select
                                onValueChange={(value) => {
                                    const percent = Number(value);

                                    handleUpdateSetting(
                                        "autoCompactThreshold",
                                        percent,
                                        percent === 0
                                            ? t`Chats will not be compacted automatically`
                                            : t`Chats will be compacted at ${percentFormat.format(percent / 100)} of the context window`,
                                        true,
                                    );
                                }}
                                value={String(autoCompactThreshold)}
                            >
                                <SelectTrigger aria-describedby="auto-compact-description" className="w-28 shrink-0" id="auto-compact-threshold">
                                    <SelectValue>
                                        {(value: string | null) => {
                                            const percent = Number(value);

                                            return percent === 0 ? t`Off` : percentFormat.format(percent / 100);
                                        }}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    {AUTO_COMPACT_PERCENTS.map((percent) => (
                                        <SelectItem key={percent} value={String(percent)}>
                                            {percent === 0 ? t`Off` : percentFormat.format(percent / 100)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        }
                        description={t`Off by default. When a chat's context fills this much of the model's window, older messages are condensed for the model before it replies. Your chat itself is never changed. You can also type /compact at any time.`}
                        descriptionId="auto-compact-description"
                        htmlFor="auto-compact-threshold"
                        title={t`Compact full chats automatically`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                checked={isAutoReadReplies}
                                id="auto-read-replies"
                                onCheckedChange={(checked) => {
                                    handleUpdateSetting(
                                        "autoReadReplies",
                                        checked,
                                        checked ? t`Replies will be read aloud` : t`Replies will no longer be read aloud`,
                                    );
                                }}
                            />
                        }
                        description={t`Read every assistant reply aloud when it finishes, using your browser's voice.`}
                        htmlFor="auto-read-replies"
                        title={t`Auto-read replies`}
                    />
                    {!isAnonymous && SPEECH_VOICES.length > 0 && (
                        <SettingsRow
                            control={
                                <Select
                                    onValueChange={(value) => {
                                        if (typeof value !== "string") {
                                            return;
                                        }

                                        handleUpdateSetting("voiceModeVoice", value, t`Hands-free voice updated`);
                                    }}
                                    value={currentSpeechVoice}
                                >
                                    <SelectTrigger aria-describedby="voice-mode-voice-description" id="voice-mode-voice">
                                        <SelectValue placeholder={t`Select a voice`}>
                                            {(value: string | null) => (value ? speechVoiceLabel(value) : null)}
                                        </SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                        {SPEECH_VOICES.map((voice) => (
                                            <SelectItem key={voice} value={voice}>
                                                {speechVoiceLabel(voice)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            }
                            description={t`The voice hands-free mode reads replies in. A skill with its own voice uses that instead. Spoken replies count against a daily allowance; after it, your browser's voice takes over.`}
                            descriptionId="voice-mode-voice-description"
                            htmlFor="voice-mode-voice"
                            title={t`Hands-free voice`}
                        />
                    )}
                    <SettingsRow
                        control={
                            <Switch
                                aria-describedby="composer-autocomplete-description"
                                checked={isComposerAutocompleteEnabled}
                                id="composer-autocomplete"
                                onCheckedChange={(checked) => {
                                    handleUpdateSetting("composerAutocompleteEnabled", checked, checked ? t`Autocomplete enabled` : t`Autocomplete disabled`);
                                }}
                            />
                        }
                        description={t`Suggests how to finish your message as grey text; press Right Arrow at the end of the line to accept or Esc to dismiss. Your draft is sent to an AI model to make the suggestion.`}
                        descriptionId="composer-autocomplete-description"
                        htmlFor="composer-autocomplete"
                        title={t`Autocomplete while typing`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                aria-describedby="composer-vim-mode-description"
                                checked={isComposerVimMode}
                                id="composer-vim-mode"
                                onCheckedChange={(checked) => {
                                    handleUpdateSetting("composerVimMode", checked, checked ? t`Vim keys enabled` : t`Vim keys disabled`);
                                }}
                            />
                        }
                        description={t`Press Escape to leave typing mode, then edit with h j k l, w b, 0 $, i a I A, o O, x, dd, D and u. Enter still sends. Off by default.`}
                        descriptionId="composer-vim-mode-description"
                        htmlFor="composer-vim-mode"
                        title={t`Vim keys in the composer`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                aria-describedby="resume-last-chat-description"
                                checked={isResumeLastChat}
                                id="resume-last-chat"
                                onCheckedChange={(checked) => {
                                    // The confirmation waits for the save: a failed save must not read as saved.
                                    handleUpdateSetting("resumeLastChat", checked, checked ? t`Resuming your latest chat` : t`Opening a blank chat`);
                                }}
                            />
                        }
                        description={t`Opening the assistant without a conversation takes you to your most recent one instead of a blank chat.`}
                        descriptionId="resume-last-chat-description"
                        htmlFor="resume-last-chat"
                        title={t`Resume your latest chat`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                aria-describedby="resume-interrupted-runs-description"
                                checked={isResumeInterruptedRuns}
                                id="resume-interrupted-runs"
                                onCheckedChange={(checked) => {
                                    handleUpdateSetting(
                                        "resumeInterruptedRuns",
                                        checked,
                                        checked ? t`Interrupted replies will continue` : t`Interrupted replies will stop`,
                                    );
                                }}
                            />
                        }
                        description={t`When a reply is cut off by an update or an outage, it continues from its last finished step, up to 3 times. A reply interrupted while a tool was running is never continued.`}
                        descriptionId="resume-interrupted-runs-description"
                        htmlFor="resume-interrupted-runs"
                        title={t`Continue interrupted replies`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                aria-describedby="resume-after-usage-limit-description"
                                checked={isResumeAfterUsageLimit}
                                id="resume-after-usage-limit"
                                onCheckedChange={(checked) => {
                                    handleUpdateSetting(
                                        "resumeAfterUsageLimit",
                                        checked,
                                        checked ? t`Paused replies will resume when the limit resets` : t`Paused replies will wait for you to resume them`,
                                        // Ordered with the settings queue: a quick second toggle cannot be overwritten by the first write landing last.
                                        true,
                                    );
                                }}
                            />
                        }
                        description={t`When a reply pauses because a usage limit was reached, it resumes by itself once the limit resets. Off: it waits until you resume it.`}
                        descriptionId="resume-after-usage-limit-description"
                        htmlFor="resume-after-usage-limit"
                        title={t`Resume after a usage limit`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                aria-describedby="snooze-until-usage-limit-reset-description"
                                checked={isSnoozeUntilUsageLimitReset}
                                id="snooze-until-usage-limit-reset"
                                onCheckedChange={(checked) => {
                                    handleUpdateSetting(
                                        "snoozeUntilUsageLimitReset",
                                        checked,
                                        checked ? t`Chats paused by a usage limit will be snoozed` : t`Chats paused by a usage limit will not be snoozed`,
                                        // Ordered with the settings queue, as the resume switch above.
                                        true,
                                    );
                                }}
                            />
                        }
                        description={t`When a reply pauses because a usage limit was reached and the provider says when it resets, its chat leaves your active list until then.`}
                        descriptionId="snooze-until-usage-limit-reset-description"
                        htmlFor="snooze-until-usage-limit-reset"
                        title={t`Snooze chats until the limit resets`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                aria-describedby="host-follow-up-steer-description"
                                checked={isHostFollowUpSteer}
                                id="host-follow-up-steer"
                                onCheckedChange={(checked) => {
                                    handleUpdateSetting(
                                        "hostFollowUpSteer",
                                        checked,
                                        checked ? t`Messages will interrupt the agent's turn` : t`Messages will wait for the agent's turn to end`,
                                    );
                                }}
                            />
                        }
                        description={t`Off: a message you send while a coding agent is working waits in the queue and goes after the turn. On: it interrupts the turn and goes next.`}
                        descriptionId="host-follow-up-steer-description"
                        htmlFor="host-follow-up-steer"
                        title={t`Send during a coding agent's turn`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                aria-describedby="follow-up-steer-description"
                                checked={isFollowUpSteer}
                                id="follow-up-steer"
                                onCheckedChange={(checked) => {
                                    handleUpdateSetting(
                                        "followUpSteer",
                                        checked,
                                        checked ? t`Messages will join the reply as it writes` : t`Messages will wait for the reply to finish`,
                                    );
                                }}
                            />
                        }
                        description={t`Off: a message you send while a reply is streaming waits in the queue and goes after it. On: it joins the reply at its next step.`}
                        descriptionId="follow-up-steer-description"
                        htmlFor="follow-up-steer"
                        title={t`Send while a reply is writing`}
                    />
                    <SettingsRow
                        description={t`How long temporary chats are kept before being automatically deleted. Default: 24 hours.`}
                        htmlFor="temporary-chat-retention"
                        title={t`Temporary Chat Retention (hours)`}
                    >
                        <div className="flex items-center gap-4">
                            <Slider
                                className="flex-1"
                                max={168}
                                min={1}
                                onValueChange={(value) => {
                                    const hours = Array.isArray(value) ? value[0] : value;

                                    setRetentionInput(hours.toString());
                                    setTemporaryChatRetentionHours(hours);
                                    toast.success(t`Retention period updated to ${hours} hours`);
                                }}
                                step={1}
                                // The row's title labels the number field; the slider beside it needs its own name.
                                thumbLabel={t`Temporary Chat Retention (hours)`}
                                value={[retentionHours]}
                            />
                            <Input
                                className="w-20"
                                id="temporary-chat-retention"
                                max={168}
                                min={1}
                                onBlur={() => {
                                    const hours = Math.trunc(Number(retentionInput));

                                    if (Number.isNaN(hours) || hours < 1 || hours > 168) {
                                        setRetentionInput(retentionHours.toString());
                                    }
                                }}
                                onChange={(e) => {
                                    const { value } = e.target;

                                    setRetentionInput(value);
                                    const hours = Math.trunc(Number(value));

                                    if (!Number.isNaN(hours) && hours >= 1 && hours <= 168) {
                                        setTemporaryChatRetentionHours(hours);
                                        toast.success(t`Retention period updated to ${hours} hours`);
                                    }
                                }}
                                type="number"
                                value={retentionInput}
                            />
                        </div>
                        <p className="text-muted-foreground text-xs">{t`Range: 1 hour to 7 days (168 hours)`}</p>
                    </SettingsRow>
                    <ChatLifecycleControls />
                    <ChatActionConfirmControls />
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Configure UI preferences and display options.`} title={t`UI Preferences`}>
                <CardContent className="space-y-4">
                    <SettingsRow
                        control={
                            <Switch
                                checked={showTimestamps}
                                id="show-timestamps"
                                onCheckedChange={(checked) => {
                                    setShowTimestamps(checked);
                                    toast.success(checked ? t`Timestamps enabled` : t`Timestamps disabled`);
                                }}
                            />
                        }
                        description={t`Display timestamps on messages.`}
                        htmlFor="show-timestamps"
                        title={t`Show Timestamps`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                checked={soundEffects}
                                id="sound-effects"
                                onCheckedChange={(checked) => {
                                    setSoundEffects(checked);
                                    toast.success(checked ? t`Sound effects enabled` : t`Sound effects disabled`);
                                }}
                            />
                        }
                        description={t`Play a short sound when a reply finishes. Applies to this browser only.`}
                        htmlFor="sound-effects"
                        title={t`Sound Effects`}
                    />
                    <SettingsRow
                        control={
                            <Switch
                                aria-describedby="split-view-description"
                                checked={splitViewEnabled}
                                id="split-view"
                                onCheckedChange={(checked) => {
                                    setSplitViewEnabled(checked);
                                    toast.success(checked ? t`Split view enabled` : t`Split view disabled`);
                                }}
                            />
                        }
                        description={t`Open up to three chats side by side. Applies to this browser only.`}
                        descriptionId="split-view-description"
                        htmlFor="split-view"
                        title={t`Split View`}
                    />
                </CardContent>
            </SettingsCard>

            {!isAnonymous && <NotificationSettings />}
        </div>
    );
};

export default AccountSettings;
