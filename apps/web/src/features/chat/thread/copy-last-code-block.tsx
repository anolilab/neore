"use client";

import { useLingui } from "@lingui/react/macro";
import { extractLastCodeBlock } from "@neore/chat-ui/utils/markdown-text";
import type { FC } from "react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useChatMessages } from "@/features/chat/core/context/chat-context";

/**
 * Copies the last code block of the newest assistant reply when the
 * `copyLastCodeBlock` keyboard shortcut fires (`use-keyboard-shortcut-handler.ts`).
 * Reads the loaded messages rather than the DOM: the list is windowed. Renders nothing.
 */
const CopyLastCodeBlockListener: FC = () => {
    const { t } = useLingui();
    const { messages } = useChatMessages();
    const messagesRef = useRef(messages);

    useEffect(() => {
        messagesRef.current = messages;
    });

    useEffect(() => {
        const handle = () => {
            const reply = messagesRef.current.findLast((message) => message.role === "assistant");
            // A reply's text parts are read together: a code block can sit in a later part than the first.
            const markdown = reply ? reply.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n") : "";
            const code = extractLastCodeBlock(markdown);

            if (!code) {
                toast.info(t`No code block in the latest reply`);

                return;
            }

            // The Clipboard API is absent outside a secure context, and its write can reject.
            const { clipboard }: { clipboard?: Clipboard } = navigator;
            const failed = () => {
                toast.error(t`Could not copy to the clipboard`);
            };

            if (!clipboard) {
                failed();

                return;
            }

            clipboard
                .writeText(code)
                .then(() => {
                    toast.success(t`Copied the last code block`);

                    return undefined;
                })
                .catch(failed);
        };

        globalThis.addEventListener("copyLastCodeBlock", handle);

        return () => {
            globalThis.removeEventListener("copyLastCodeBlock", handle);
        };
    }, [t]);

    return null;
};

export default CopyLastCodeBlockListener;
