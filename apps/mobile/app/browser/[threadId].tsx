import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { AccessibilityInfo, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/auth-state";
import type { ControlSession, ControlState } from "@/browser/control-session";
import type { ShownFrame } from "@/browser/use-browser-view";
import { useBrowserView } from "@/browser/use-browser-view";
import { withFinally } from "@/lib/guarded";
import { OfflineBanner } from "@/offline/offline-banner";
import { useWriteControl } from "@/offline/offline-context";
import { settleQuietly } from "@/offline/quietly";

const BUTTON = { alignItems: "center", backgroundColor: "#111", borderRadius: 8, justifyContent: "center", minHeight: 44, paddingHorizontal: 16 } as const;

/** Clicking and typing need a target the phone cannot name yet: the phone shows the page and opens addresses. */
const INPUT_NOTE = "To click or type on the page, use the web app. From the phone you can watch, open an address, and hold control so the agent waits.";

const controlText = (control: ControlState): string | undefined => {
    if (control.kind === "holding") {
        return "You have control. The agent waits until you hand it back.";
    }

    return control.kind === "idle" ? control.message : undefined;
};

/** The picture's shape: the page's own viewport when the renderer named it. */
const aspectOf = (frame: ShownFrame): number => {
    if (frame.viewport === undefined || !(frame.viewport.width > 0 && frame.viewport.height > 0)) {
        return 16 / 10;
    }

    return frame.viewport.width / frame.viewport.height;
};

/** While the phone holds control: open an address, or hand the browser back to the agent. */
const HeldControls = ({ isBlocked, onOpened, session }: { isBlocked: boolean; onOpened: () => void; session: ControlSession }) => {
    const [address, setAddress] = useState("");
    const [isOpening, setIsOpening] = useState(false);
    const [openError, setOpenError] = useState<string | undefined>(undefined);
    const isOff = isBlocked || isOpening;

    const open = async () => {
        if (isOff || address.trim() === "") {
            return;
        }

        setIsOpening(true);
        setOpenError(undefined);
        await withFinally(
            async () => {
                const refused = await session.navigate(address.trim());

                setOpenError(refused);
                onOpened();

                if (refused !== undefined) {
                    AccessibilityInfo.announceForAccessibility(refused);
                }
            },
            () => setIsOpening(false),
        );
    };

    return (
        <>
            <TextInput
                accessibilityLabel="Address to open"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isOff}
                inputMode="url"
                onChangeText={setAddress}
                onSubmitEditing={() => settleQuietly(open())}
                placeholder="https://"
                style={{ borderColor: "#767676", borderRadius: 8, borderWidth: 1, minHeight: 44, paddingHorizontal: 12 }}
                value={address}
            />
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: isOff }} disabled={isOff} onPress={() => settleQuietly(open())} style={BUTTON}>
                <Text style={{ color: "#fff" }}>{isOpening ? "Opening..." : "Open address"}</Text>
            </Pressable>
            {openError === undefined ? null : <Text accessibilityRole="alert">{openError}</Text>}
            <Pressable accessibilityRole="button" onPress={() => session.release("handed_back")} style={{ ...BUTTON, backgroundColor: "#555" }}>
                <Text style={{ color: "#fff" }}>Hand back to the agent</Text>
            </Pressable>
        </>
    );
};

/** Take control, or what the phone may do with it; the button is off offline and while the connection is checked. */
const ControlPanel = ({ control, onOpened, session }: { control: ControlState; onOpened: () => void; session: ControlSession }) => {
    const gate = useWriteControl("control");
    const isTaking = control.kind === "taking";

    return (
        <View style={{ gap: 12 }}>
            <Text accessibilityLiveRegion="polite">{controlText(control) ?? ""}</Text>
            {control.kind === "holding"
                ? <HeldControls isBlocked={gate.disabled} onOpened={onOpened} session={session} />
                : (
                    <Pressable
                        accessibilityHint={gate.reason}
                        accessibilityRole="button"
                        accessibilityState={{ busy: isTaking, disabled: gate.disabled || isTaking }}
                        disabled={gate.disabled || isTaking}
                        onPress={() => settleQuietly(session.take())}
                        style={BUTTON}
                    >
                        <Text style={{ color: "#fff" }}>{isTaking ? "Taking control..." : "Take control"}</Text>
                    </Pressable>
                )}
            {gate.reason === undefined ? null : <Text>{gate.reason}</Text>}
            <Text style={{ color: "#555" }}>{INPUT_NOTE}</Text>
        </View>
    );
};

const BrowserScreen = ({ threadId, userId }: { threadId: string; userId: string }) => {
    const { control, frame, frameNote, refresh, session, view } = useBrowserView(threadId, userId);
    const isReady = view.kind === "ready";
    const message = view.kind === "ended" || view.kind === "hidden" ? view.message : undefined;

    return (
        <View style={{ flex: 1 }}>
            <OfflineBanner syncedAt={frame?.takenAt} />
            <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
                {view.kind === "connecting" ? <Text accessibilityRole="progressbar">Connecting to the browser...</Text> : null}
                {message === undefined ? null : <Text accessibilityRole="text">{message}</Text>}
                {isReady && view.currentUrl !== undefined
                    ? (
                        <Text numberOfLines={1} selectable style={{ color: "#555" }}>
                            {view.currentUrl}
                        </Text>
                    )
                    : null}
                {frame === undefined || !isReady
                    ? null
                    : (
                        <Image
                            accessibilityLabel="The browser's page"
                            resizeMode="contain"
                            source={{ uri: `data:image/jpeg;base64,${frame.image}` }}
                            style={{ aspectRatio: aspectOf(frame), width: "100%" }}
                        />
                    )}
                {isReady && frame === undefined && frameNote === undefined ? <Text accessibilityRole="progressbar">Loading the page...</Text> : null}
                {frameNote === undefined ? null : <Text accessibilityLiveRegion="polite">{frameNote}</Text>}
                {isReady && !view.canControl ? <Text>You can watch this browser but not control it.</Text> : null}
                {isReady && view.canControl ? <ControlPanel control={control} onOpened={refresh} session={session} /> : null}
            </ScrollView>
        </View>
    );
};

/**
 * Keyed by the signed-in account and the thread, so one account's or chat's lease and page never stay on screen for
 * the next: a new key hands the old lease back and starts afresh.
 */
// eslint-disable-next-line react/function-component-definition -- the default export is declared inline (unicorn/default-export-style), which makes it a function declaration
export default function BrowserRoute() {
    const { user } = useAuth();
    const { threadId } = useLocalSearchParams<{ threadId: string }>();
    const userId = user?.id ?? "none";

    return <BrowserScreen key={`${userId}:${threadId}`} threadId={threadId} userId={userId} />;
}
