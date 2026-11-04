import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";

import { loadConfig } from "@/lib/config";
import { crashReportStore } from "@/lib/crash-report-store";
import { changeCrashReports, crashReportsOn } from "@/lib/crash-reporting";

const SAVE_FAILED_MESSAGE = "Your choice could not be applied. Try again.";

const SettingsScreen = () => {
    const [isEnabled, setIsEnabled] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const isConfigured = loadConfig().posthog !== undefined;

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

        try {
            await changeCrashReports(crashReportStore, isOn);
        } catch (changeError) {
            console.warn("Could not change the crash-report setting.", changeError);
            setFailure(SAVE_FAILED_MESSAGE);
        }

        // The switch shows what reporting is doing now, which after a failure can differ from what was asked.
        setIsEnabled(await crashReportsOn());
    };

    return (
        <View style={{ gap: 12, padding: 16 }}>
            <View style={{ alignItems: "center", flexDirection: "row", justifyContent: "space-between" }}>
                <Text>Send crash reports</Text>
                <Switch
                    accessibilityLabel="Send crash reports"
                    disabled={!isConfigured || !isLoaded}
                    onValueChange={(isOn) => {
                        change(isOn);
                    }}
                    value={isEnabled}
                />
            </View>
            <Text style={{ fontSize: 13 }}>
                Off by default. Reports go to PostHog, a third-party service. A report has the name of the error and where in the app it happened. PostHog
                also adds an anonymous install ID and basic details of the device, operating system, app version and language. A report never includes the
                text of a chat or the message of the error.
            </Text>
            {isConfigured ? null : <Text style={{ fontSize: 13 }}>Crash reports are not set up in this build.</Text>}
            {failure ? <Text accessibilityRole="alert" style={{ color: "#b00020", fontSize: 13 }}>{failure}</Text> : null}
        </View>
    );
};

export default SettingsScreen;
