import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, ScrollView, Switch, Text, View } from "react-native";

import { readReopenLastChat, writeReopenLastChat } from "@/chat/last-thread-store";
import { loadConfig } from "@/lib/config";
import { crashReportStore } from "@/lib/crash-report-store";
import { changeCrashReports, crashReportsOn, UnsavedOptOutError } from "@/lib/crash-reporting";
import { installMarker } from "@/lib/install-marker";
import { readOnDeviceDictation, writeOnDeviceDictation } from "@/voice/dictation-setting";

const SAVE_FAILED_MESSAGE = "Your choice could not be applied. Try again.";
const UNSAVED_OPT_OUT_MESSAGE = "Reporting is off for now, but the choice could not be saved. It may turn back on after a restart. Try again.";
const SETTING_SAVE_FAILED_MESSAGE = "Your choice could not be saved. Try again.";
const SETTING_READ_FAILED_MESSAGE = "This setting could not be read. Switch it to save your choice.";

const SettingsScreen = () => {
    const [isEnabled, setIsEnabled] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    // One change at a time: the switch is held until the change in progress has settled.
    const [isChanging, setIsChanging] = useState(false);
    // On by default: a launch reopens the last chat unless this was switched off.
    const [isReopenOn, setIsReopenOn] = useState(true);
    const [isReopenLoaded, setIsReopenLoaded] = useState(false);
    // One change at a time: the switch is held until the save in progress settles.
    const [isReopenChanging, setIsReopenChanging] = useState(false);
    const [reopenFailure, setReopenFailure] = useState<string | null>(null);
    // Off by default: voice input goes to the cloud unless this was switched on.
    const [isOnDeviceOn, setIsOnDeviceOn] = useState(false);
    const [isOnDeviceLoaded, setIsOnDeviceLoaded] = useState(false);
    const [isOnDeviceChanging, setIsOnDeviceChanging] = useState(false);
    const [onDeviceFailure, setOnDeviceFailure] = useState<string | null>(null);
    const isConfigured = loadConfig().posthog !== undefined;

    useEffect(() => {
        let isActive = true;

        const loadOnDevice = async () => {
            try {
                const value = await readOnDeviceDictation();

                if (isActive) {
                    setIsOnDeviceOn(value);
                    setIsOnDeviceLoaded(true);
                }
            } catch {
                // Voice input records nothing until a choice is saved, so the switch stays usable to save one.
                if (isActive) {
                    setIsOnDeviceLoaded(true);
                    setOnDeviceFailure(SETTING_READ_FAILED_MESSAGE);
                }
            }
        };

        loadOnDevice();

        return () => {
            isActive = false;
        };
    }, []);

    useEffect(() => {
        let isActive = true;

        const loadReopen = async () => {
            try {
                const value = await readReopenLastChat();

                if (isActive) {
                    setIsReopenOn(value);
                    setIsReopenLoaded(true);
                }
            } catch {
                // The stored choice is unknown, so the switch shows the default and can still be changed, which saves a choice.
                if (isActive) {
                    setIsReopenLoaded(true);
                    setReopenFailure(SETTING_READ_FAILED_MESSAGE);
                }
            }
        };

        loadReopen();

        return () => {
            isActive = false;
        };
    }, []);

    useEffect(() => {
        let isActive = true;

        const load = async () => {
            const value = await crashReportsOn();

            if (isActive) {
                setIsEnabled(value);
                setIsLoaded(true);
            }
        };

        load();

        return () => {
            isActive = false;
        };
    }, []);

    const change = async (isOn: boolean) => {
        setFailure(null);
        setIsChanging(true);

        try {
            await changeCrashReports(crashReportStore, isOn, installMarker);
        } catch (changeError) {
            console.warn("Could not change the crash-report setting.", changeError);
            setFailure(changeError instanceof UnsavedOptOutError ? UNSAVED_OPT_OUT_MESSAGE : SAVE_FAILED_MESSAGE);
        }

        // The switch shows what reporting is doing now, which after a failure can differ from what was asked.
        setIsEnabled(await crashReportsOn());
        setIsChanging(false);
    };

    const changeReopenLastChat = async (isOn: boolean) => {
        setReopenFailure(null);
        setIsReopenOn(isOn);
        setIsReopenChanging(true);

        try {
            await writeReopenLastChat(isOn);
        } catch (writeError) {
            console.warn("Could not save the reopen setting.", writeError);
            setReopenFailure(SETTING_SAVE_FAILED_MESSAGE);
            // The switch is held while a save runs, so the value before this change is still the one stored.
            setIsReopenOn(!isOn);
        } finally {
            setIsReopenChanging(false);
        }
    };

    // VoiceOver reads neither the live region nor a new alert, so a failure here is announced on iOS.
    useEffect(() => {
        if (onDeviceFailure !== null && Platform.OS === "ios") {
            AccessibilityInfo.announceForAccessibility(onDeviceFailure);
        }
    }, [onDeviceFailure]);

    const changeOnDevice = async (isOn: boolean) => {
        setOnDeviceFailure(null);
        setIsOnDeviceOn(isOn);
        setIsOnDeviceChanging(true);

        try {
            await writeOnDeviceDictation(isOn);
        } catch (writeError) {
            console.warn("Could not save the on-device transcription setting.", writeError);
            setOnDeviceFailure(SETTING_SAVE_FAILED_MESSAGE);
            // The switch is held while a save runs, so the value before this change is still the one stored.
            setIsOnDeviceOn(!isOn);
        } finally {
            setIsOnDeviceChanging(false);
        }
    };

    return (
        <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
            <Text accessibilityRole="header" style={{ fontWeight: "600" }}>
                Voice input
            </Text>
            <Text style={{ fontSize: 13 }}>
                Hold the microphone button in a chat to speak your message. The text only goes into your draft. You decide whether to send it.
            </Text>
            <View style={{ alignItems: "center", flexDirection: "row", gap: 12, justifyContent: "space-between" }}>
                <Text style={{ flex: 1 }}>Transcribe on this device</Text>
                <Switch
                    accessibilityLabel="Transcribe on this device"
                    disabled={!isOnDeviceLoaded || isOnDeviceChanging}
                    onValueChange={(isOn) => {
                        changeOnDevice(isOn);
                    }}
                    value={isOnDeviceOn}
                />
            </View>
            <Text style={{ fontSize: 13 }}>
                Off (the default): the recording leaves your phone. It is sent to the Neore servers and from there to a speech-to-text provider, which turn it
                into text. The recording is not stored.
            </Text>
            <Text style={{ fontSize: 13 }}>
                On: the speech recognizer built into your phone turns your voice into text, and the recording does not leave your phone. If this phone cannot do
                that, voice input says so and sends nothing anywhere.
            </Text>
            {Boolean(onDeviceFailure) && (
                <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ color: "#b00020", fontSize: 13 }}>
                    {onDeviceFailure}
                </Text>
            )}
            <View style={{ alignItems: "center", flexDirection: "row", gap: 12, justifyContent: "space-between" }}>
                <Text style={{ flex: 1 }}>Reopen the last chat on launch</Text>
                <Switch
                    accessibilityLabel="Reopen the last chat on launch"
                    disabled={!isReopenLoaded || isReopenChanging}
                    onValueChange={(isOn) => {
                        changeReopenLastChat(isOn);
                    }}
                    value={isReopenOn}
                />
            </View>
            {Boolean(reopenFailure) && (
                <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ color: "#b00020", fontSize: 13 }}>
                    {reopenFailure}
                </Text>
            )}
            <View style={{ alignItems: "center", flexDirection: "row", gap: 12, justifyContent: "space-between" }}>
                <Text style={{ flex: 1 }}>Send crash reports</Text>
                <Switch
                    accessibilityLabel="Send crash reports"
                    disabled={!isConfigured || !isLoaded || isChanging}
                    onValueChange={(isOn) => {
                        change(isOn);
                    }}
                    value={isEnabled}
                />
            </View>
            <Text style={{ fontSize: 13 }}>
                Off by default. Reports go to PostHog, a third-party service. A report has the name of the error and where in the app it happened. PostHog also
                adds an anonymous install ID and basic details of the device, operating system, app version and language. A report never includes the text of a
                chat or the message of the error.
            </Text>
            {isConfigured ? null : <Text style={{ fontSize: 13 }}>Crash reports are not set up in this build.</Text>}
            {Boolean(failure) && (
                <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ color: "#b00020", fontSize: 13 }}>
                    {failure}
                </Text>
            )}
        </ScrollView>
    );
};

export default SettingsScreen;
