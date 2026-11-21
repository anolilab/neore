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

/** The index the gallery shows for `key`: that image, or the first when the key is absent or no longer loaded. */
export const galleryIndexOf = (images: ReadonlyArray<ThreadImage>, key: string | null): number => {
    const index = key === null ? -1 : images.findIndex((image) => image.key === key);

    return Math.max(index, 0);
};

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
    const previewRef = useRef<HTMLDivElement>(null);
    // Set by a key pressed in the zoomable preview: the next image replaces it, so the focus moves to that one.
    const refocusPreviewRef = useRef(false);

    const isOpen = shown !== null && images.length > 0;
    const index = galleryIndexOf(images, shown?.key ?? null);
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
            <DialogPopup className="flex max-h-[90vh] w-full max-w-5xl flex-col gap-3 p-4" onKeyDown={handleKeyDown}>
                <DialogTitle className="text-sm font-medium">{t`Images in this chat`}</DialogTitle>
                {current && (
                    <>
                        <p aria-live="polite" className="text-muted-foreground text-xs">
                            {t`Image ${index + 1} of ${images.length}`}
                        </p>
                        <div className="relative flex h-[60vh] min-h-0 items-center justify-center" ref={previewRef}>
                            <ZoomableImage alt={current.alt} className="h-full w-full" key={current.key} src={current.src} />
                            <Button
                                aria-label={t`Previous image`}
                                className="absolute top-1/2 left-2 -translate-y-1/2"
                                disabled={index === 0}
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
                                            aria-label={t`Image ${position + 1}: ${image.alt}`}
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
