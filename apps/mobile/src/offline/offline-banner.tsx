import { Text, View } from "react-native";

import { lastSyncedLabel } from "./labels";
import { useOffline } from "./offline-context";

/**
 * Tells the person the screen shows saved data and when it was saved. The container is always mounted and is a
 * polite live region, so Android announces the change when the text appears; the provider announces it on iOS.
 */
export const OfflineBanner = ({ syncedAt }: { syncedAt: number | undefined }) => {
    const { isOffline } = useOffline();

    return (
        <View accessibilityLiveRegion="polite" accessible={isOffline} style={{ backgroundColor: isOffline ? "#fff4d6" : undefined }}>
            {isOffline
                ? (
                <Text accessibilityRole="text" style={{ padding: 8 }}>
                    {`Offline. Showing saved data. ${lastSyncedLabel(syncedAt)}`}
                </Text>
                )
                : null}
        </View>
    );
};
