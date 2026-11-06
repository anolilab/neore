import { useEffect, useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";

import { readReopenLastChat, writeReopenLastChat } from "@/chat/last-thread-store";
import { loadConfig } from "@/lib/config";
import { crashReportStore } from "@/lib/crash-report-store";
import { changeCrashReports, crashReportsOn, UnsavedOptOutError } from "@/lib/crash-reporting";
import { installMarker } from "@/lib/install-marker";

const SAVE_FAILED_MESSAGE = "Your choice could not be applied. Try again.";
const UNSAVED_OPT_OUT_MESSAGE = "Reporting is off for now, but the choice could not be saved. It may turn back on after a restart. Try again.";
const REOPEN_SAVE_FAILED_MESSAGE = "Your choice could not be saved. Try again.";

const SettingsScreen = () => {
    const [isEnabled, setIsEnabled] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    // One change at a time: the switch is held until the change in progress has settled.
    const [isChanging, setIsChanging] = useState(false);
    // On by default: a launch reopens the last chat unless this was switched off.
    const [isReopenOn, setIsReopenOn] = useState(true);
    const [isReopenLoaded, setIsReopenLoaded] = useState(false);
    const [reopenFailure, setReopenFailure] = useState<string | null>(null);
    const isConfigured = loadConfig().posthog !== undefined;

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
                // An unreadable setting keeps its default: on.
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

        try {
            await writeReopenLastChat(isOn);
        } catch (writeError) {
            console.warn("Could not save the reopen setting.", writeError);
            setReopenFailure(REOPEN_SAVE_FAILED_MESSAGE);
            // The save did not happen, so the switch goes back to the value that is still stored.
            setIsReopenOn(!isOn);
        }
    };

    return (
        <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
            <View style={{ alignItems: "center", flexDirection: "row", gap: 12, justifyContent: "space-between" }}>
                <Text style={{ flex: 1 }}>Reopen the last chat on launch</Text>
                <Switch
                    accessibilityLabel="Reopen the last chat on launch"
                    disabled={!isReopenLoaded}
                    onValueChange={(isOn) => {
                        changeReopenLastChat(isOn);
                    }}
                    value={isReopenOn}
                />
            </View>
            {reopenFailure
                ? (
                <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ color: "#b00020", fontSize: 13 }}>
                    {reopenFailure}
                </Text>
                )
                : null}
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
            {failure
                ? (
                <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ color: "#b00020", fontSize: 13 }}>
                    {failure}
                </Text>
                )
                : null}
        </ScrollView>
    );
};

export default SettingsScreen;
