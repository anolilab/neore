import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Text, View } from "react-native";

import { AuthProvider } from "@/auth/auth-context";
import { useAuth } from "@/auth/auth-state";
import { loadConfig } from "@/lib/config";

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
            <Stack.Screen name="projects/index" options={{ title: "Projects" }} />
            <Stack.Screen name="projects/[projectId]" options={{ title: "Project" }} />
        </Stack>
    );
};

const RootLayout = () => {
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
            {/* eslint-disable-next-line react/style-prop-object -- expo-status-bar takes "auto" as a string, not a style object */}
            <StatusBar style="auto" />
            <SignInGate />
        </AuthProvider>
    );
};

export default RootLayout;
