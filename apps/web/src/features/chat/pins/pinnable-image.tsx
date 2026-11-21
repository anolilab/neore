"use client";

/**
 * An image in a reply, with a button that pins that one image (`threadPins.kind: "image"`). The image itself is
 * chat-ui's `DefaultImage`; this only adds the pin. Images a person uploaded, and images still being checked or
 * blocked, are shown without one.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { ImageRendererProps } from "@neore/chat-ui/chat/message-content";
import { DefaultImage } from "@neore/chat-ui/chat/message-content";
import { Button } from "@neore/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { PinIcon } from "lucide-react";
import type { FC } from "react";
import { memo } from "react";

import { useChatThreadIdentity } from "@/features/chat/core/context/chat-context-hooks";
import { isValidThreadId } from "@/features/chat/core/hooks/use-validated-thread";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

/** The text kept with an image pin: its generation prompt, else its file name. Shown in the pins tab. */
export const imagePinText = (part: ImageRendererProps["part"]): string | undefined => part.prompt?.trim() || part.filename?.trim() || undefined;

/** Whether this image gets a pin button: a shown image of a reply whose place in the message is known. */
export const canPinImage = ({ messageId, messageRole, part, partIndex }: ImageRendererProps): boolean =>
    messageRole === "assistant" &&
    messageId !== undefined &&
    partIndex !== undefined &&
    part.image.length > 0 &&
    part.nsfwStatus !== "blocked" &&
    part.nsfwStatus !== "checking";

const PinImageButton: FC<{ messageId: string; part: ImageRendererProps["part"]; partIndex: number }> = ({ messageId, part, partIndex }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { threadId } = useChatThreadIdentity();
    const { isPending, mutate: createPin } = useMutation(crpc.chat.pins.functions.createPin.mutationOptions());

    if (!isValidThreadId(threadId)) {
        return null;
    }

    const handlePin = () => {
        createPin(
            {
                kind: "image",
                messageId,
                messageRole: "assistant",
                partIndex,
                selectedText: imagePinText(part),
                threadId: threadId as Id<"threads">,
            },
            {
                onError: (error) => showError(error as Error),
                onSuccess: () => {
                    trackEvent("message_pinned", { has_note: false, kind: "image" });
                    useChatUIStore.getState().setActiveRightSidebarTab("pins");
                },
            },
        );
    };

    return (
        <Button
            aria-label={t`Pin image`}
            className="bg-background/80 absolute top-2 right-2 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
            disabled={isPending}
            onClick={handlePin}
            size="icon-sm"
            title={t`Pin image`}
            variant="outline"
        >
            <PinIcon aria-hidden="true" className="size-4" />
        </Button>
    );
};

const PinnableImage: FC<ImageRendererProps> = memo((props) => {
    const { messageId, part, partIndex } = props;

    if (!canPinImage(props) || messageId === undefined || partIndex === undefined) {
        return <DefaultImage {...props} />;
    }

    return (
        <div className="group relative w-fit max-w-full">
            <DefaultImage {...props} />
            <PinImageButton messageId={messageId} part={part} partIndex={partIndex} />
        </div>
    );
});

PinnableImage.displayName = "PinnableImage";

export default PinnableImage;
