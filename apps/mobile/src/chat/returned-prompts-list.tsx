import { Pressable, Text, View } from "react-native";

import type { ReturnedPrompt } from "./returned-prompts";

interface ReturnedPromptListProps {
    /** Whether Discard is off: while a send runs, since it may be the item being sent. */
    isDiscardBlocked: boolean;
    /** Whether Resend is off: sending waits, or the phone is offline. */
    isResendBlocked: boolean;
    items: ReadonlyArray<ReturnedPrompt>;
    onDiscard: (id: string) => void;
    onResend: (item: ReturnedPrompt) => void;
}

/**
 * The prompts that did not go through, each its own item above the message box. Resend sends the prompt again under its own
 * id; Discard drops it. Nothing here is merged into the composer.
 */
export const ReturnedPromptList = ({ isDiscardBlocked, isResendBlocked, items, onDiscard, onResend }: ReturnedPromptListProps) => {
    if (items.length === 0) {
        return null;
    }

    return (
        <View accessibilityLabel="Not sent" style={{ borderTopColor: "#ddd", borderTopWidth: 1, gap: 8, padding: 12 }}>
            {items.map((item) => (
                <View key={item.id} style={{ borderColor: "#ccc", borderRadius: 8, borderWidth: 1, gap: 6, padding: 10 }}>
                    <Text numberOfLines={3} style={{ fontWeight: "600" }}>
                        {item.prompt}
                    </Text>
                    <Text style={{ color: "#555", fontSize: 12 }}>{item.reason}</Text>
                    <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
                        <Pressable
                            accessibilityHint="Removes this message from the list. It is not sent."
                            accessibilityRole="button"
                            accessibilityState={{ disabled: isDiscardBlocked }}
                            disabled={isDiscardBlocked}
                            onPress={() => onDiscard(item.id)}
                            style={{ alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 44, paddingHorizontal: 12 }}
                        >
                            <Text>Discard</Text>
                        </Pressable>
                        <Pressable
                            accessibilityHint="Sends this message again, unchanged."
                            accessibilityRole="button"
                            accessibilityState={{ disabled: isResendBlocked }}
                            disabled={isResendBlocked}
                            onPress={() => onResend(item)}
                            style={{ alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 44, paddingHorizontal: 12 }}
                        >
                            <Text style={{ fontWeight: "600" }}>Resend</Text>
                        </Pressable>
                    </View>
                </View>
            ))}
        </View>
    );
};
