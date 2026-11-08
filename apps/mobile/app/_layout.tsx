import "@/lib/crash-boot";

import { Link, Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";

import { AuthProvider } from "@/auth/auth-context";
import { useAuth } from "@/auth/auth-state";
import { canClaimLaunchReopen } from "@/chat/launch-reopen";
import { loadConfig } from "@/lib/config";
import { revocationFlag } from "@/lib/crash-report-revocation";
import { crashReportStore } from "@/lib/crash-report-store";
import { applyStoredCrashReportChoice, startCrashReporting } from "@/lib/crash-reporting";
import { installMarker } from "@/lib/install-marker";
import { createPostHogClient } from "@/lib/posthog-client";
import { routeAfterSignIn } from "@/notifications/pending-tap";
import { usePhonePush } from "@/notifications/use-phone-push";
import { OfflineProvider } from "@/offline/offline-provider";

/** Starts crash reporting when the build has a PostHog key, and applies the stored choice. */
const CrashReportingStartup = () => {
    useEffect(() => {
        const { posthog } = loadConfig();

        if (!posthog) {
            return;
        }

        startCrashReporting(() => createPostHogClient(posthog), revocationFlag);
        applyStoredCrashReportChoice(crashReportStore, installMarker);
    }, []);

    return null;
};

/** Sends a signed-out user to the sign-in screen and a signed-in one away from it. */
const SignInGate = () => {
    const { status } = useAuth();
    const router = useRouter();
    const segments = useSegments();
    const isOnSignIn = segments[0] === "sign-in";
    // Settings is open without a sign-in: a saved crash-report choice stays in force after sign-out, so it must stay reachable.
    const isOnSettings = segments[0] === "settings";

    usePhonePush();

    useEffect(() => {
        if (status === "signed-out" && !isOnSignIn && !isOnSettings) {
            router.replace("/sign-in");
        }

        if (status === "signed-in" && isOnSignIn) {
            // A notification tapped before or during sign-in goes to its chat, not the chat list.
            router.replace(routeAfterSignIn());
        }
    }, [isOnSettings, isOnSignIn, router, status]);

    // The launch's reopen goes to the first signed-in screen that is not the chat list (which takes it itself) and not the
    // sign-in screen (which leads to the list). Any other screen opened first, such as a chat from a link, takes it, so the
    // list cannot open the saved chat long after the launch.
    useEffect(() => {
        const first: string | undefined = segments[0];
        const isListOrSignIn = first === undefined || first === "index" || isOnSignIn;

        if (status === "signed-in" && !isListOrSignIn) {
            canClaimLaunchReopen();
        }
    }, [isOnSignIn, segments, status]);

    return (
        <Stack>
            <Stack.Screen
                name="index"
                options={{
                    headerRight: () => (
                        <Link asChild href="/settings">
                            <Pressable accessibilityRole="link" style={{ justifyContent: "center", minHeight: 44, minWidth: 44 }}>
                                <Text>Settings</Text>
                            </Pressable>
                        </Link>
                    ),
                    title: "Chats",
                }}
            />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
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
            <CrashReportingStartup />
            <OfflineProvider>
                <SignInGate />
            </OfflineProvider>
        </AuthProvider>
    );
};

export default RootLayout;
