import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";

import { loadConfig } from "@/lib/config";
import { readCrashReportsEnabled } from "@/lib/crash-report-preference";
import { crashReportStore } from "@/lib/crash-report-store";
import { changeCrashReports } from "@/lib/crash-reporting";

const SettingsScreen = () => {
    const [isEnabled, setIsEnabled] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const isConfigured = loadConfig().posthog !== undefined;

    useEffect(() => {
        let isActive = true;

        const load = async () => {
            try {
                const value = await readCrashReportsEnabled(crashReportStore);

                if (isActive) {
                    setIsEnabled(value);
                }
            } catch {
                // An unreadable choice stays off.
            }

            if (isActive) {
                setIsLoaded(true);
            }
        };

        load();

        return () => {
            isActive = false;
        };
    }, []);

    const change = async (isOn: boolean) => {
        setIsEnabled(isOn);
        await changeCrashReports(crashReportStore, isOn);
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
                Off by default. A report has the name of the error and where in the app it happened. It never includes the text of a chat or the message of the
                error.
            </Text>
            {isConfigured ? null : <Text style={{ fontSize: 13 }}>Crash reports are not set up in this build.</Text>}
        </View>
    );
};

export default SettingsScreen;
