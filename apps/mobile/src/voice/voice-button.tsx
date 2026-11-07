import { useEffect } from "react";
import { AccessibilityInfo, Platform, Pressable, Text } from "react-native";

import type { VoicePhase } from "./use-voice-input";

const STATUS: Record<VoicePhase, string | undefined> = {
    idle: undefined,
    recording: "Recording. Release to add the words to your message.",
    transcribing: "Turning your recording into text…",
};

/** Hold to record, release to transcribe. Recording stays possible while a reply streams; a clip being transcribed holds it. */
export const VoiceButton = ({
    disabledReason,
    isDisabled,
    voice,
}: {
    disabledReason: string | undefined;
    isDisabled: boolean;
    voice: { finish: () => Promise<void>; phase: VoicePhase; start: () => Promise<void> };
}) => {
    const isRecording = voice.phase === "recording";
    const isBlocked = isDisabled || voice.phase === "transcribing";

    return (
        <Pressable
            accessibilityHint={disabledReason ?? "Hold to record, release to add the words to your message"}
            accessibilityLabel={isRecording ? "Recording" : "Voice input"}
            accessibilityRole="button"
            accessibilityState={{ busy: voice.phase === "transcribing", disabled: isBlocked }}
            disabled={isBlocked}
            onPressIn={() => {
                voice.start();
            }}
            onPressOut={() => {
                voice.finish();
            }}
            style={{ alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 44, opacity: isBlocked ? 0.5 : 1 }}
        >
            <Text style={{ color: isRecording ? "#b00020" : undefined, fontWeight: "600" }}>{isRecording ? "● Rec" : "Mic"}</Text>
        </Pressable>
    );
};

/**
 * The line under the composer while a clip records or is transcribed, or voice input's failure. On iOS each change is
 * announced, since VoiceOver reads neither the live region nor a new alert; Android's TalkBack reads the live region.
 */
export const VoiceStatus = ({ error, phase }: { error: string | undefined; phase: VoicePhase }) => {
    const status = STATUS[phase];

    const spoken = error ?? status;

    useEffect(() => {
        if (spoken !== undefined && Platform.OS === "ios") {
            AccessibilityInfo.announceForAccessibility(spoken);
        }
    }, [spoken]);

    if (error !== undefined) {
        return (
            <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ color: "#b00020", fontSize: 12, paddingHorizontal: 12 }}>
                {error}
            </Text>
        );
    }

    if (status === undefined) {
        return undefined;
    }

    return (
        <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, paddingHorizontal: 12 }}>
            {status}
        </Text>
    );
};
