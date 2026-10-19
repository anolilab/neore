import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Text, View } from "react-native";

import { AuthProvider, useAuth } from "@/auth/auth-context";
import { loadConfig } from "@/lib/config";

export default function RootLayout() {
    let configError: string | null = null;

    try {
        loadConfig();
    } catch (error) {
        configError = error instanceof Error ? error.message : "Configuration is missing.";
    }

    if (configError) {
        return (
            <View style={{ alignItems: "center", flex: 1, justifyContent: "center", padding: 24 }}>
                <Text accessibilityRole="alert">{configError}</Text>
            </View>
        );
    }

    return (
        <AuthProvider>
            <StatusBar style="auto" />
            <SignInGate />
        </AuthProvider>
    );
}

/** Sends a signed-out user to the sign-in screen and a signed-in one away from it. */
const SignInGate = () => {
    const { status } = useAuth();
    const router = useRouter();
    const segments = useSegments();
    const isOnSignIn = segments[0] === "sign-in";

    useEffect(() => {
        if (status === "signed-out" && !isOnSignIn) {
            router.replace("/sign-in");
        }

        if (status === "signed-in" && isOnSignIn) {
            router.replace("/");
        }
    }, [isOnSignIn, router, status]);

    return (
        <Stack>
            <Stack.Screen name="index" options={{ title: "Chats" }} />
            <Stack.Screen name="sign-in" options={{ title: "Sign in" }} />
            <Stack.Screen name="chat/[threadId]" options={{ title: "Chat" }} />
        </Stack>
    );
};
