import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useAuth } from "@/auth/auth-state";

const SignInScreen = () => {
    const { signIn } = useAuth();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const onPress = async () => {
        setBusy(true);
        setError(null);

        try {
            await signIn();
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Sign-in failed.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={{ flex: 1, gap: 16, justifyContent: "center", padding: 24 }}>
            <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={onPress}
                style={{ alignItems: "center", backgroundColor: "#111", borderRadius: 10, padding: 14 }}
            >
                <Text style={{ color: "#fff", fontWeight: "600" }}>{busy ? "Opening sign-in..." : "Sign in with Neore"}</Text>
            </Pressable>
            {error
                ? (
                <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ color: "#b00020" }}>
                    {error}
                </Text>
                )
                : null}
        </View>
    );
};

export default SignInScreen;
