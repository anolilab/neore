import { Pressable, Text, TextInput, View } from "react-native";

import { useDictation } from "../voice/use-dictation";
import { VoiceButton, VoiceStatus } from "../voice/voice-button";
import { appendTranscript } from "../voice/voice-input";
import type { DraftStore } from "./draft-store";
import { useDraft } from "./draft-store";

interface ChatComposerProps {
    /** The composer's write control: off while offline or while a connection is checked. */
    control: { disabled: boolean; reason: string | undefined };
    draft: DraftStore;
    isSendBlocked: boolean;
    onSend: () => void;
    /** The home indicator's inset, which the open keyboard already covers. */
    safeBottom: number;
    /** Why sending waits, if it does; shown under the composer and given as the send control's hint. */
    sendReason: string | undefined;
}

/**
 * The message box, voice input and send. It owns the draft's subscription, so typing and dictation re-render this and
 * nothing above it: the chat screen and its message list stay as they are on every keystroke.
 */
export const ChatComposer = ({ control, draft, isSendBlocked, onSend, safeBottom, sendReason }: ChatComposerProps) => {
    const text = useDraft(draft);
    // The words land in the draft, after anything typed meanwhile; they are never sent on their own.
    const voice = useDictation({ onText: (heard) => draft.set((current) => appendTranscript(current, heard)) });

    return (
        <>
            <View style={{ flexDirection: "row", gap: 8, padding: 12, paddingBottom: sendReason ? 12 : 12 + safeBottom }}>
                <TextInput
                    accessibilityHint={control.reason}
                    accessibilityLabel="Message"
                    accessibilityState={{ disabled: control.disabled }}
                    editable={!control.disabled}
                    multiline
                    onChangeText={draft.set}
                    placeholder="Message"
                    style={{ borderColor: "#ccc", borderRadius: 10, borderWidth: 1, flex: 1, padding: 10 }}
                    value={text}
                />
                <VoiceButton disabledReason={control.reason} isDisabled={control.disabled} voice={voice} />
                <Pressable
                    accessibilityHint={sendReason}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: isSendBlocked }}
                    disabled={isSendBlocked}
                    onPress={onSend}
                    style={{ justifyContent: "center", opacity: isSendBlocked ? 0.5 : 1, padding: 12 }}
                >
                    <Text style={{ fontWeight: "600" }}>Send</Text>
                </Pressable>
            </View>
            <VoiceStatus error={voice.error} phase={voice.phase} />
            {sendReason ? <Text style={{ fontSize: 12, paddingBottom: 8 + safeBottom, paddingHorizontal: 12 }}>{sendReason}</Text> : null}
        </>
    );
};
