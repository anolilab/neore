import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import type { ShownRow } from "./chunk-batcher";
import { shareableMessageText, shareLabel } from "./share-message";

/**
 * One message of the chat. Memoised on the row's identity: a streamed chunk replaces only the row it lands in
 * (`appendTexts`), so every other row skips its render. `onShare` must be stable for that to hold.
 */
export const MessageRowView = memo(({ onShare, row }: { onShare: (text: string) => void; row: ShownRow }) => {
    // Only a finished message can be shared: one still streaming, or one that failed, is not the whole text.
    const isFinished = row.status === "success" || row.finished === true;
    const shareText = isFinished ? shareableMessageText({ text: row.shareText }) : undefined;

    return (
        <View style={{ alignSelf: row.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", padding: 12 }}>
            <Text selectable>{row.text || (row.role === "assistant" ? "..." : "")}</Text>
            {shareText !== undefined && (
                <Pressable
                    accessibilityLabel={shareLabel({ role: row.role, text: shareText })}
                    accessibilityRole="button"
                    onPress={() => onShare(shareText)}
                    style={{
                        alignItems: "center",
                        alignSelf: "flex-start",
                        justifyContent: "center",
                        minHeight: 44,
                        minWidth: 44,
                        paddingHorizontal: 12,
                    }}
                >
                    <Text style={{ fontSize: 12 }}>Share</Text>
                </Pressable>
            )}
        </View>
    );
});

MessageRowView.displayName = "MessageRowView";
