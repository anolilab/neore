"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Slider } from "@neore/ui/components/slider";
import { Switch } from "@neore/ui/components/switch";
import type { FC } from "react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import AppearanceControls from "@/features/appearance/components/appearance-controls";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { createLanguageList } from "@/features/chat/core/utils/language-utilities";
import { DEFAULT_SPEECH_VOICE, SPEECH_VOICES, speechVoiceLabel } from "@/features/chat/voice-mode/tts-availability";
import { useFontSettings, useLayoutState, useUserPreferences } from "@/features/layout/hooks/use-ui-state";
import NotificationSettings from "@/features/notifications/components/notification-settings";

// BCP 47 defaults for each supported UI locale. Hoisted to avoid recreation on every render.
const LOCALE_DEFAULTS: Record<string, string> = { de: "de-DE", en: "en-US" };

/** Browser timezone, or a fixed fallback where `Intl` is unavailable (SSR). */
const getBrowserTimezone = (): string => {
    if (typeof Intl !== "undefined" && Intl.DateTimeFormat) {
        return new Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    return "America/New_York";
};

const AccountSettings: FC = () => {
    const { i18n, t } = useLingui();
    const {
        animations,
        autoSave,
        disableExternalLinkWarning,
        hidePersonalInfo,
        isAdvancedUser,
        sendBehavior,
        setAnimations,
        setAutoSave,
        setDisableExternalLinkWarning,
        setHidePersonalInfo,
        setIsAdvancedUser,
        setSendBehavior,
        setShowTimestamps,
        setSoundEffects,
        setTemporaryChatRetentionHours,
        showTimestamps,
        soundEffects,
    } = useUserPreferences();
    const userSettingsQuery = useUserSettings();
    const userSettings = userSettingsQuery.data;
    const retentionHours = userSettings?.temporaryChatRetentionHours ?? 24;
    const [retentionInput, setRetentionInput] = useState(retentionHours.toString());
    const { codeFont, mainFont, setCodeFont, setMainFont } = useFontSettings();
    const { direction, setDirection } = useLayoutState();
    const updateUserSettings = useUpdateUserSettings();
    const { isAnonymous } = useIsAnonymous();

    // Language options
    const languages = useMemo(() => createLanguageList(i18n, t), [i18n, t]);
    // O(1) label lookup used by the SelectValue render functions below
    const languageMap = useMemo(() => new Map(languages.map((l) => [l.value, l.label])), [languages]);

    // Simple primitive derivation — no useMemo needed (rule: don't memo simple expressions)
    const locale = i18n.locale ?? "en";
    const localeLanguageDefault = LOCALE_DEFAULTS[locale] ?? `${locale}-${locale.toUpperCase()}`;

    // Get current values from userSettings, falling back to the UI locale default
    const currentLanguage = userSettings?.language || localeLanguageDefault;
    const currentDictationLanguage = userSettings?.dictationLanguage || localeLanguageDefault;
    const currentLocation = userSettings?.location;
    const currentTimezone = userSettings?.timezone;
    const isEnableFollowupSuggestions = userSettings?.enableFollowupSuggestions !== false;
    // Opt-in: absent means off.
    const isAutoReadReplies = userSettings?.autoReadReplies === true;
    const currentSpeechVoice = userSettings?.voiceModeVoice ?? DEFAULT_SPEECH_VOICE ?? null;
    // OPT-IN: absent is off — every suggestion sends the draft to a model.
    const isComposerAutocompleteEnabled = userSettings?.composerAutocompleteEnabled === true;

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
        async (key: string, value: unknown) => {
            await updateUserSettings.mutateAsync({ [key]: value });
        },
        [updateUserSettings],
    );

    return (
        <div className="space-y-6">
            <SettingsCard description={t`Control how your personal information is displayed in the UI.`} title={t`Privacy`}>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base font-medium" htmlFor="hide-personal-info">
                                {t`Hide Personal Information`}
                            </Label>
                            <p className="text-muted-foreground text-sm">{t`Hides your name and email from the UI.`}</p>
                        </div>
                        <Switch
                            checked={hidePersonalInfo}
                            id="hide-personal-info"
                            onCheckedChange={(checked) => {
                                setHidePersonalInfo(checked);
                                toast.success(checked ? t`Personal information is now hidden` : t`Personal information is now visible`);
                            }}
                        />
                    </div>
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base font-medium" htmlFor="disable-external-link-warning">
                                {t`Disable External Link Warning`}
                            </Label>
                            <p className="text-muted-foreground text-sm">{t`Skip the warning dialog when clicking external links.`}</p>
                        </div>
                        <Switch
                            checked={disableExternalLinkWarning}
                            id="disable-external-link-warning"
                            onCheckedChange={(checked) => {
                                setDisableExternalLinkWarning(checked);
                                toast.success(checked ? t`External link warnings disabled` : t`External link warnings enabled`);
                            }}
                        />
                    </div>
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Customize the appearance of the application.`} title={t`Appearance`}>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label className="text-base font-medium" htmlFor="main-font">
                            {t`Main Font`}
                        </Label>
                        <Select
                            onValueChange={(value) => {
                                setMainFont(value as typeof mainFont);
                                toast.success(t`Main font updated`);
                            }}
                            value={mainFont}
                        >
                            <SelectTrigger id="main-font">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="inter">{t`Inter`}</SelectItem>
                                <SelectItem value="system">{t`System`}</SelectItem>
                                <SelectItem value="serif">{t`Serif`}</SelectItem>
                                <SelectItem value="mono">{t`Mono`}</SelectItem>
                                <SelectItem value="roboto-slab">{t`Roboto Slab`}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label className="text-base font-medium" htmlFor="code-font">
                            {t`Code Font`}
                        </Label>
                        <Select
                            onValueChange={(value) => {
                                setCodeFont(value as typeof codeFont);
                                toast.success(t`Code font updated`);
                            }}
                            value={codeFont}
                        >
                            <SelectTrigger id="code-font">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="fira-code">{t`Fira Code`}</SelectItem>
                                <SelectItem value="mono">{t`Mono`}</SelectItem>
                                <SelectItem value="consolas">{t`Consolas`}</SelectItem>
                                <SelectItem value="jetbrains">{t`JetBrains Mono`}</SelectItem>
                                <SelectItem value="source-code-pro">{t`Source Code Pro`}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <AppearanceControls />
                    <div className="space-y-2">
                        <Label className="text-base font-medium" htmlFor="direction">
                            {t`Text Direction`}
                        </Label>
                        <p className="text-muted-foreground text-sm">{t`Set the text direction for the application. RTL is used for languages like Arabic, Hebrew, and Persian.`}</p>
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
                    </div>
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Configure how the application behaves.`} title={t`Behavior`}>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label className="text-base font-medium" htmlFor="send-behavior">
                            {t`Send Message Behavior`}
                        </Label>
                        <p className="text-muted-foreground text-sm">{t`Choose how to send messages in the chat.`}</p>
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
                                <SelectItem value="button">{t`Click button to send`}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Configure language preferences and location settings.`} title={t`Language & Localization`}>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label className="text-base font-medium" htmlFor="language">
                            {t`Default AI Response Language`}
                        </Label>
                        <p className="text-muted-foreground text-sm">{t`Default language for AI responses in new threads (BCP 47 code).`}</p>
                        <Select
                            onValueChange={(value) => {
                                handleUpdateSetting("language", value);
                                toast.success(t`Default language updated`);
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
                    </div>
                    <div className="space-y-2">
                        <Label className="text-base font-medium" htmlFor="dictation-language">
                            {t`Default Dictation Language`}
                        </Label>
                        <p className="text-muted-foreground text-sm">{t`Default dictation language for new threads (BCP 47 code).`}</p>
                        <Select
                            onValueChange={(value) => {
                                handleUpdateSetting("dictationLanguage", value);
                                toast.success(t`Dictation language updated`);
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
                    </div>
                    <div className="space-y-2">
                        <Label className="text-base font-medium" htmlFor="location">
                            {t`Location`}
                        </Label>
                        <p className="text-muted-foreground text-sm">{t`Your location (e.g., "New York, USA", "Berlin, Germany").`}</p>
                        <Input
                            defaultValue={currentLocation || ""}
                            id="location"
                            onBlur={(e) => {
                                const value = e.target.value.trim();

                                if (value !== currentLocation) {
                                    handleUpdateSetting("location", value || undefined);
                                    toast.success(t`Location updated`);
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
                    </div>
                    <div className="space-y-2">
                        <Label className="text-base font-medium" htmlFor="timezone">
                            {t`Timezone`}
                        </Label>
                        <p className="text-muted-foreground text-sm">{t`Your timezone (IANA timezone identifier).`}</p>
                        <Select
                            onValueChange={(value) => {
                                handleUpdateSetting("timezone", value);
                                toast.success(t`Timezone updated`);
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
                    </div>
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Configure chat behavior and preferences.`} title={t`Chat`}>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base font-medium" htmlFor="enable-followup-suggestions">
                                {t`Enable Follow-up Suggestions`}
                            </Label>
                            <p className="text-muted-foreground text-sm">{t`Show follow-up suggestions after assistant messages.`}</p>
                        </div>
                        <Switch
                            checked={isEnableFollowupSuggestions}
                            id="enable-followup-suggestions"
                            onCheckedChange={(checked) => {
                                handleUpdateSetting("enableFollowupSuggestions", checked);
                                toast.success(checked ? t`Follow-up suggestions enabled` : t`Follow-up suggestions disabled`);
                            }}
                        />
                    </div>
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base font-medium" htmlFor="auto-read-replies">
                                {t`Auto-read replies`}
                            </Label>
                            <p className="text-muted-foreground text-sm">{t`Read every assistant reply aloud when it finishes, using your browser's voice.`}</p>
                        </div>
                        <Switch
                            checked={isAutoReadReplies}
                            id="auto-read-replies"
                            onCheckedChange={(checked) => {
                                handleUpdateSetting("autoReadReplies", checked);
                                toast.success(checked ? t`Replies will be read aloud` : t`Replies will no longer be read aloud`);
                            }}
                        />
                    </div>
                    {!isAnonymous && SPEECH_VOICES.length > 0 && (
                        <div className="space-y-2">
                            <Label className="text-base font-medium" htmlFor="voice-mode-voice">
                                {t`Hands-free voice`}
                            </Label>
                            <p className="text-muted-foreground text-sm" id="voice-mode-voice-description">
                                {t`The voice hands-free mode reads replies in. A skill with its own voice uses that instead. Spoken replies count against a daily allowance; after it, your browser's voice takes over.`}
                            </p>
                            <Select
                                onValueChange={(value) => {
                                    if (typeof value !== "string") {
                                        return;
                                    }

                                    handleUpdateSetting("voiceModeVoice", value);
                                    toast.success(t`Hands-free voice updated`);
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
                        </div>
                    )}
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base font-medium" htmlFor="composer-autocomplete">
                                {t`Autocomplete while typing`}
                            </Label>
                            <p className="text-muted-foreground text-sm" id="composer-autocomplete-description">
                                {t`Suggests how to finish your message as grey text; press Right Arrow at the end of the line to accept or Esc to dismiss. Your draft is sent to an AI model to make the suggestion.`}
                            </p>
                        </div>
                        <Switch
                            aria-describedby="composer-autocomplete-description"
                            checked={isComposerAutocompleteEnabled}
                            id="composer-autocomplete"
                            onCheckedChange={(checked) => {
                                handleUpdateSetting("composerAutocompleteEnabled", checked);
                                toast.success(checked ? t`Autocomplete enabled` : t`Autocomplete disabled`);
                            }}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label className="text-base font-medium" htmlFor="temporary-chat-retention">
                            {t`Temporary Chat Retention (hours)`}
                        </Label>
                        <p className="text-muted-foreground text-sm">
                            {t`How long temporary chats are kept before being automatically deleted. Default: 24 hours.`}
                        </p>
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
                    </div>
                </CardContent>
            </SettingsCard>

            <SettingsCard description={t`Configure UI preferences and display options.`} title={t`UI Preferences`}>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base font-medium" htmlFor="animations">
                                {t`Animations`}
                            </Label>
                            <p className="text-muted-foreground text-sm">{t`Enable animations and transitions in the UI.`}</p>
                        </div>
                        <Switch
                            checked={animations}
                            id="animations"
                            onCheckedChange={(checked) => {
                                setAnimations(checked);
                                toast.success(checked ? t`Animations enabled` : t`Animations disabled`);
                            }}
                        />
                    </div>
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base font-medium" htmlFor="auto-save">
                                {t`Auto Save`}
                            </Label>
                            <p className="text-muted-foreground text-sm">{t`Automatically save your work.`}</p>
                        </div>
                        <Switch
                            checked={autoSave}
                            id="auto-save"
                            onCheckedChange={(checked) => {
                                setAutoSave(checked);
                                toast.success(checked ? t`Auto save enabled` : t`Auto save disabled`);
                            }}
                        />
                    </div>
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base font-medium" htmlFor="show-timestamps">
                                {t`Show Timestamps`}
                            </Label>
                            <p className="text-muted-foreground text-sm">{t`Display timestamps on messages.`}</p>
                        </div>
                        <Switch
                            checked={showTimestamps}
                            id="show-timestamps"
                            onCheckedChange={(checked) => {
                                setShowTimestamps(checked);
                                toast.success(checked ? t`Timestamps enabled` : t`Timestamps disabled`);
                            }}
                        />
                    </div>
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base font-medium" htmlFor="sound-effects">
                                {t`Sound Effects`}
                            </Label>
                            <p className="text-muted-foreground text-sm">{t`Play sound effects for UI interactions.`}</p>
                        </div>
                        <Switch
                            checked={soundEffects}
                            id="sound-effects"
                            onCheckedChange={(checked) => {
                                setSoundEffects(checked);
                                toast.success(checked ? t`Sound effects enabled` : t`Sound effects disabled`);
                            }}
                        />
                    </div>
                </CardContent>
            </SettingsCard>

            {!isAnonymous && <NotificationSettings />}

            <SettingsCard description={t`Advanced options for power users.`} title={t`Advanced`}>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base font-medium" htmlFor="advanced-user">
                                {t`Advanced User Mode`}
                            </Label>
                            <p className="text-muted-foreground text-sm">{t`Enable advanced features and options.`}</p>
                        </div>
                        <Switch
                            checked={isAdvancedUser}
                            id="advanced-user"
                            onCheckedChange={(checked) => {
                                setIsAdvancedUser(checked);
                                toast.success(checked ? t`Advanced user mode enabled` : t`Advanced user mode disabled`);
                            }}
                        />
                    </div>
                </CardContent>
            </SettingsCard>
        </div>
    );
};

export default AccountSettings;
