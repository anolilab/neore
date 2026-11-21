"use client";

/**
 * The images of the open chat in one dialog: a large preview (zoomable), arrow keys and buttons to step through them,
 * and a strip of thumbnails. The images are the ones the loaded messages hold (`collectThreadImages`): browser
 * screenshots, images a code run made, and image files.
 */

import { useLingui } from "@lingui/react/macro";
import type { ThreadImage } from "@neore/chat-ui/utils/thread-images";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogPopup, DialogTitle } from "@neore/ui/components/dialog";
import { ZoomableImage } from "@neore/ui/components/zoomable-image";
import cn from "@neore/ui/utils/cn";
import { ChevronLeftIcon, ChevronRightIcon, LocateFixedIcon } from "lucide-react";
import type { FC, KeyboardEvent } from "react";
import { useEffect, useRef } from "react";

import { scrollToMessage } from "@/features/chat/core/utils/scroll-to-message";

import { useImageGalleryStore } from "./image-gallery-store";

/** The index of `key`'s image, 0 for no key, or -1 when the gallery does not hold that key (it then stays closed). */
export const galleryIndexOf = (images: ReadonlyArray<ThreadImage>, key: string | null): number =>
    key === null ? 0 : images.findIndex((image) => image.key === key);

/** The index a key moves the gallery to, or `null` for a key it does not handle. Stops at either end. */
export const galleryStep = (key: string, index: number, count: number): number | null => {
    switch (key) {
        case "ArrowLeft": {
            return Math.max(index - 1, 0);
        }

        case "ArrowRight": {
            return Math.min(index + 1, count - 1);
        }

        case "End": {
            return count - 1;
        }

        case "Home": {
            return 0;
        }

        default: {
            return null;
        }
    }
};

const ThreadImageGallery: FC<{ images: ReadonlyArray<ThreadImage>; threadId: string }> = ({ images, threadId }) => {
    const { t } = useLingui();
    const shown = useImageGalleryStore((state) => (state.shown?.threadId === threadId ? state.shown : null));
    const openAt = useImageGalleryStore((state) => state.openAt);
    const close = useImageGalleryStore((state) => state.close);
    const opener = useImageGalleryStore((state) => state.opener);
    const previewRef = useRef<HTMLDivElement>(null);
    // Set by Go to message: the jump focuses the message, so the close must not hand focus back to the opener.
    const keepFocusOnCloseRef = useRef(false);
    // Set by a key pressed in the zoomable preview: the next image replaces it, so the focus moves to that one.
    const refocusPreviewRef = useRef(false);

    /** An image's name: its own (a page title, a file name), else its kind, in the viewer's language. */
    const labelOf = (image: ThreadImage): string => {
        if (image.alt) {
            return image.alt;
        }

        switch (image.kind) {
            case "browser": {
                return t`Browser screenshot`;
            }

            case "code": {
                return t`Code output`;
            }

            default: {
                return t`Image`;
            }
        }
    };

    // Focus goes back to the control that opened the gallery while it is still on the page; else the dialog's default.
    const finalFocus = (): HTMLElement | boolean => {
        if (keepFocusOnCloseRef.current) {
            keepFocusOnCloseRef.current = false;

            return false;
        }

        return opener?.isConnected ? opener : true;
    };
    const index = galleryIndexOf(images, shown?.key ?? null);
    // Opens at a held image, or at the first for no key; never at another image for a key it does not hold.
    const isOpen = shown !== null && images.length > 0 && index >= 0;

    // The image it was opened at left the list (its message changed, or another tab removed it): the selection is let go,
    // so the dialog never opens again by itself if the image comes back. Only this chat's selection (`shown`) is read.
    useEffect(() => {
        if (shown !== null && !isOpen) {
            useImageGalleryStore.getState().closeIf(shown.threadId, shown.key);
        }
    }, [isOpen, shown]);
    const current = images[index];
    const currentKey = current?.key;

    useEffect(() => {
        if (!refocusPreviewRef.current) {
            return;
        }

        refocusPreviewRef.current = false;
        (previewRef.current?.firstElementChild as HTMLElement | null)?.focus();
    }, [currentKey]);

    // A gallery that goes away (its pane closed, the chat left) forgets its image, so it does not open again on return.
    useEffect(
        () => () => {
            if (useImageGalleryStore.getState().shown?.threadId === threadId) {
                useImageGalleryStore.getState().close();
            }
        },
        [threadId],
    );

    const show = (next: number) => {
        const image = images[next];

        if (image) {
            openAt(threadId, image.key);
        }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        // A zoomed image pans with the arrows and stops them before they get here.
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }

        const next = galleryStep(event.key, index, images.length);

        if (next !== null) {
            event.preventDefault();
            refocusPreviewRef.current = next !== index && previewRef.current?.firstElementChild?.contains(event.target as Node) === true;
            show(next);
        }
    };

    const goToMessage = () => {
        if (!current) {
            return;
        }

        keepFocusOnCloseRef.current = true;
        close();
        // The thread, so in the split view the pane of this chat scrolls, not the focused one.
        scrollToMessage(current.messageId, { threadId });
    };

    return (
        <Dialog
            onOpenChange={(open: boolean) => {
                if (!open) {
                    close();
                }
            }}
            open={isOpen}
        >
            <DialogPopup className="flex max-h-[90vh] w-full max-w-5xl flex-col gap-3 p-4" finalFocus={finalFocus} onKeyDown={handleKeyDown}>
                <DialogTitle className="text-sm font-medium">{t`Images in this chat`}</DialogTitle>
                {current && (
                    <>
                        <p aria-live="polite" className="text-muted-foreground text-xs">
                            {t`Image ${index + 1} of ${images.length}`}
                        </p>
                        <div className="relative flex h-[60vh] min-h-0 items-center justify-center" ref={previewRef}>
                            <ZoomableImage alt={labelOf(current)} className="h-full w-full" key={current.key} src={current.src} />
                            <Button
                                aria-label={t`Previous image`}
                                className="absolute top-1/2 left-2 -translate-y-1/2"
                                disabled={index === 0}
                                // Keeps the focus at the first image, so the arrow keys still reach the dialog.
                                focusableWhenDisabled
                                onClick={() => show(index - 1)}
                                size="icon"
                                variant="secondary"
                            >
                                <ChevronLeftIcon aria-hidden="true" className="size-5" />
                            </Button>
                            <Button
                                aria-label={t`Next image`}
                                className="absolute top-1/2 right-2 -translate-y-1/2"
                                disabled={index === images.length - 1}
                                focusableWhenDisabled
                                onClick={() => show(index + 1)}
                                size="icon"
                                variant="secondary"
                            >
                                <ChevronRightIcon aria-hidden="true" className="size-5" />
                            </Button>
                        </div>
                        <div className="flex items-center gap-2">
                            <ul aria-label={t`Thumbnails`} className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
                                {images.map((image, position) => (
                                    <li className="shrink-0" key={image.key}>
                                        <button
                                            aria-current={position === index ? "true" : undefined}
                                            aria-label={t`Image ${position + 1}: ${labelOf(image)}`}
                                            className={cn(
                                                "focus-visible:ring-ring block size-16 overflow-hidden rounded border-2 focus-visible:ring-2 focus-visible:outline-none",
                                                position === index ? "border-primary" : "border-transparent opacity-70 hover:opacity-100",
                                            )}
                                            onClick={() => show(position)}
                                            type="button"
                                        >
                                            <img alt="" className="size-full object-cover" decoding="async" loading="lazy" src={image.src} />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                            <Button className="shrink-0" onClick={goToMessage} size="sm" variant="outline">
                                <LocateFixedIcon aria-hidden="true" className="size-4" />
                                {t`Go to message`}
                            </Button>
                        </div>
                    </>
                )}
            </DialogPopup>
        </Dialog>
    );
};

export default ThreadImageGallery;
