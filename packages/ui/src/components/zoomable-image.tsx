"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import cn from "@ui/utils/cn";
import type { Point, Size, ZoomView } from "@ui/utils/zoom-pan";
import {
    arrowKeyPan,
    BUTTON_ZOOM_FACTOR,
    CENTRE,
    clampPan,
    doubleClickZoom,
    INITIAL_ZOOM_VIEW,
    MIN_ZOOM,
    panBy,
    wheelDeltaInPixels,
    wheelZoomFactor,
    zoomAround,
} from "@ui/utils/zoom-pan";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

interface ZoomableImageProps {
    alt: string;
    className?: string;
    onError?: () => void;
    src: string;
}

interface DragState {
    originX: number;
    originY: number;
    pointerId: number;
    startX: number;
    startY: number;
}

const cursorClass = (isDragging: boolean, isZoomed: boolean): string => {
    if (isDragging) {
        return "cursor-grabbing";
    }

    return isZoomed ? "cursor-grab" : "cursor-zoom-in";
};

/**
 * An image that zooms about the cursor (wheel, trackpad pinch, double-click),
 * pans by dragging while zoomed, and takes keyboard zoom and pan.
 *
 * Keys are read from the group. Tab reaches its zoom buttons, and a pointer
 * press on the image moves focus into the group, so keys work after a click too.
 * The group is not itself a tab stop: a focusable region with no interactive
 * role fails the jsx-a11y rules.
 *
 * Zoom state lives here, so a caller that changes the image should key this
 * component by it to reset the view.
 */
const ZoomableImage = ({ alt, className, onError, src }: ZoomableImageProps) => {
    const { t } = useLingui();
    const [view, setView] = useState<ZoomView>(INITIAL_ZOOM_VIEW);
    // Mirrors `view` synchronously, so several wheel events in one frame
    // each build on the last instead of on a stale render.
    const viewRef = useRef<ZoomView>(INITIAL_ZOOM_VIEW);
    const rootRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const dragRef = useRef<DragState | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    // Eased only for the discrete steps (buttons, keys, double-click); continuous
    // input (wheel, pinch, drag) must track the pointer without lag.
    const [isEased, setIsEased] = useState(false);
    const hintId = useId();

    const commit = useCallback((next: ZoomView) => {
        viewRef.current = next;
        setView(next);
    }, []);

    const measure = useCallback((): { content: Size; viewport: Size } | null => {
        const surface = surfaceRef.current;
        const image = imageRef.current;

        if (!surface || !image) {
            return null;
        }

        // offsetWidth/offsetHeight ignore transforms: the fitted, unscaled size.
        return {
            content: { height: image.offsetHeight, width: image.offsetWidth },
            viewport: { height: surface.clientHeight, width: surface.clientWidth },
        };
    }, []);

    // Pointer position from the viewport centre, the transform origin.
    const pointerFromCentre = useCallback((clientX: number, clientY: number): Point | null => {
        const surface = surfaceRef.current;

        if (!surface) {
            return null;
        }

        const rect = surface.getBoundingClientRect();

        return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
    }, []);

    const zoomTo = useCallback(
        (nextScale: number, pointer: Point, eased: boolean) => {
            const measured = measure();

            if (!measured) {
                return;
            }

            setIsEased(eased);
            commit(zoomAround(viewRef.current, nextScale, pointer, measured.content, measured.viewport));
        },
        [commit, measure],
    );

    const reset = useCallback(() => {
        setIsEased(true);
        commit(INITIAL_ZOOM_VIEW);
    }, [commit]);

    // Native listeners, because React's wheel listener is passive and cannot
    // cancel the browser's own zoom on a pinch.
    useEffect(() => {
        const surface = surfaceRef.current;

        if (!surface) {
            return undefined;
        }

        const onWheel = (event: WheelEvent) => {
            event.preventDefault();

            const pointer = pointerFromCentre(event.clientX, event.clientY);

            if (!pointer) {
                return;
            }

            const factor = wheelZoomFactor(wheelDeltaInPixels(event.deltaY, event.deltaMode), event.ctrlKey);

            zoomTo(viewRef.current.scale * factor, pointer, false);
        };

        surface.addEventListener("wheel", onWheel, { passive: false });

        return () => {
            surface.removeEventListener("wheel", onWheel);
        };
    }, [pointerFromCentre, zoomTo]);

    useEffect(() => {
        const root = rootRef.current;

        if (!root) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            // Leave browser shortcuts (Cmd/Ctrl +, -, 0) to the browser.
            if (event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }

            const { scale } = viewRef.current;
            const pan = arrowKeyPan(event.key);

            if (pan) {
                // Arrows only pan a zoomed image; unzoomed, they keep their page-scroll meaning.
                const measured = measure();

                if (!measured || scale <= MIN_ZOOM) {
                    return;
                }

                setIsEased(false);
                commit(panBy(viewRef.current, pan.x, pan.y, measured.content, measured.viewport));
                event.preventDefault();

                return;
            }

            switch (event.key) {
                case "0": {
                    reset();

                    break;
                }
                case "+":
                case "=": {
                    zoomTo(scale * BUTTON_ZOOM_FACTOR, CENTRE, true);

                    break;
                }
                case "-":
                case "_": {
                    zoomTo(scale / BUTTON_ZOOM_FACTOR, CENTRE, true);

                    break;
                }
                default: {
                    // Escape and every other key stay with the dialog and the page.
                    return;
                }
            }

            event.preventDefault();
        };

        root.addEventListener("keydown", onKeyDown);

        return () => {
            root.removeEventListener("keydown", onKeyDown);
        };
    }, [commit, measure, reset, zoomTo]);

    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        // Focus the group so its keys work after a click; it is not in the tab order.
        rootRef.current?.focus({ preventScroll: true });

        if (event.button !== 0 || viewRef.current.scale <= MIN_ZOOM) {
            return;
        }

        dragRef.current = {
            originX: viewRef.current.x,
            originY: viewRef.current.y,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
        };
        setIsEased(false);
        setIsDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        const measured = measure();

        if (!measured || !drag || drag.pointerId !== event.pointerId) {
            return;
        }

        commit(
            clampPan(
                {
                    scale: viewRef.current.scale,
                    x: drag.originX + event.clientX - drag.startX,
                    y: drag.originY + event.clientY - drag.startY,
                },
                measured.content,
                measured.viewport,
            ),
        );
    };

    const endDrag = (event: PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId !== event.pointerId) {
            return;
        }

        dragRef.current = null;
        setIsDragging(false);
    };

    const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
        const pointer = pointerFromCentre(event.clientX, event.clientY);
        const measured = measure();

        if (!pointer || !measured) {
            return;
        }

        setIsEased(true);
        commit(doubleClickZoom(viewRef.current, pointer, measured.content, measured.viewport));
    };

    const isZoomed = view.scale > MIN_ZOOM;
    const percent = Math.round(view.scale * 100);
    const easeImage = isEased && !isDragging;

    return (
        <div
            aria-describedby={hintId}
            aria-label={alt}
            aria-roledescription={t`Zoomable image`}
            className={cn("relative h-full w-full outline-none", className)}
            ref={rootRef}
            role="group"
            tabIndex={-1}
        >
            <div
                className={cn("absolute inset-0 flex touch-none items-center justify-center overflow-hidden", cursorClass(isDragging, isZoomed))}
                onDoubleClick={handleDoubleClick}
                onPointerCancel={endDrag}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                ref={surfaceRef}
            >
                <img
                    alt={alt}
                    className={cn(
                        "max-h-full max-w-full origin-center object-contain select-none",
                        easeImage && "motion-safe:transition-transform motion-safe:duration-150",
                    )}
                    draggable={false}
                    onError={onError}
                    ref={imageRef}
                    src={src}
                    style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
                />
            </div>
            <span className="sr-only" id={hintId}>
                {t`Tab to the zoom buttons, then plus and minus zoom, zero resets, and arrow keys pan when zoomed. Double-click or scroll to zoom, drag to pan.`}
            </span>

            {/* Outside the pan surface, so its pointer capture cannot swallow these clicks. */}
            <div className="absolute top-3 left-3 flex items-center gap-1 rounded-md bg-black/60 p-1">
                <Button
                    aria-label={t`Zoom out`}
                    className="text-white hover:bg-white/20"
                    onClick={() => zoomTo(viewRef.current.scale / BUTTON_ZOOM_FACTOR, CENTRE, true)}
                    size="icon-sm"
                    variant="ghost"
                >
                    <ZoomOut aria-hidden="true" className="size-4" />
                </Button>
                <Button aria-label={t`Reset zoom`} className="text-white hover:bg-white/20" onClick={reset} size="icon-sm" variant="ghost">
                    <Maximize aria-hidden="true" className="size-4" />
                </Button>
                <Button
                    aria-label={t`Zoom in`}
                    className="text-white hover:bg-white/20"
                    onClick={() => zoomTo(viewRef.current.scale * BUTTON_ZOOM_FACTOR, CENTRE, true)}
                    size="icon-sm"
                    variant="ghost"
                >
                    <ZoomIn aria-hidden="true" className="size-4" />
                </Button>
                <span aria-live="polite" className="min-w-12 text-center text-xs text-white/80 tabular-nums" role="status">
                    {t`${percent}%`}
                </span>
            </div>
        </div>
    );
};

export { ZoomableImage };
