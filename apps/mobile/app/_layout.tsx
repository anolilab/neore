import "@/lib/crash-boot";
import "@/lib/splash-boot";

import { Link, Stack, useRouter, useSegments } from "expo-router";
import { hideAsync } from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useSyncExternalStore } from "react";
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
import { canHideSplash, listReady } from "@/lib/splash-gate";
import { routeAfterSignIn } from "@/notifications/pending-tap";
import { usePhonePush } from "@/notifications/use-phone-push";
import { OfflineProvider } from "@/offline/offline-provider";
import { settleQuietly } from "@/offline/quietly";

/** The splash stays up at most this long: a session that is still not known by then shows the app anyway. */
const SPLASH_MAX_MS = 2000;

/** Hiding twice, or after a failed prevent, is harmless. */
const hideSplash = (): void => settleQuietly(hideAsync());

/** Hides the splash once the first screen can paint (`canHideSplash`), or after {@link SPLASH_MAX_MS} whatever it is. */
const SplashGate = () => {
    const { status } = useAuth();
    const segments = useSegments();
    const first: string | undefined = segments[0];
    const isOnList = first === undefined || first === "index";
    const isListReady = useSyncExternalStore(listReady.subscribe, listReady.isReady);

    useEffect(() => {
        const timer = setTimeout(hideSplash, SPLASH_MAX_MS);

        return () => clearTimeout(timer);
    }, []);

    useEffect(() => {
        if (canHideSplash({ isListReady, isOnList, status })) {
            hideSplash();
        }
    }, [isListReady, isOnList, status]);

    return null;
};

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
        hideSplash();

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
            <SplashGate />
            <OfflineProvider>
                <SignInGate />
            </OfflineProvider>
        </AuthProvider>
    );
};

export default RootLayout;
