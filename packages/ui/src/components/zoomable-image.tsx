"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import cn from "@ui/utils/cn";
import type { Frame, Point, ZoomView } from "@ui/utils/zoom-pan";
import {
    BUTTON_ZOOM_FACTOR,
    CENTRE,
    clampPan,
    doubleClickZoom,
    INITIAL_ZOOM_VIEW,
    keyAction,
    MIN_ZOOM,
    panBy,
    wheelDeltaInPixels,
    wheelZoomFactor,
    zoomAround,
} from "@ui/utils/zoom-pan";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

interface ZoomableImageProps {
    alt: string;
    className?: string;
    onError?: () => void;
    src: string;
}

interface DragState {
    lastX: number;
    lastY: number;
    pointerId: number;
}

interface ZoomState {
    /** Set by the discrete steps (buttons, keys, double-click) and nothing else. */
    eased: boolean;
    view: ZoomView;
}

const INITIAL_STATE: ZoomState = { eased: false, view: INITIAL_ZOOM_VIEW };

// Retries for the image to get a size before a step is dropped: about 5 seconds at 16 ms. A timer, not an
// animation frame, because frames can stall for a long time when the page is busy or in a background tab.
const LAYOUT_RETRIES = 300;
const LAYOUT_RETRY_MS = 16;
// Steps queued before layout. Continuous input (wheel) can send many; the oldest are dropped past this bound.
const MAX_PENDING_STEPS = 16;

type ZoomStep = (current: ZoomView, frame: Frame) => ZoomView;

interface PendingStep {
    isEased: boolean | null;
    step: ZoomStep;
}

interface PendingZoom {
    queue: PendingStep[];
    retriesLeft: number;
    timer: ReturnType<typeof setTimeout> | null;
}

const cursorClass = (isDragging: boolean, isZoomed: boolean): string => {
    if (isDragging) {
        return "cursor-grabbing";
    }

    return isZoomed ? "cursor-grab" : "cursor-zoom-in";
};

// Pointer position from the viewport centre, the transform origin.
const pointerFromCentre = (event: { clientX: number; clientY: number }, surface: HTMLElement): Point => {
    const rect = surface.getBoundingClientRect();

    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
};

const ToolbarButton = ({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) => (
    <Button aria-label={label} className="text-white hover:bg-white/20" onClick={onClick} size="icon-sm" variant="ghost">
        {children}
    </Button>
);

/**
 * An image that zooms about the cursor (wheel, trackpad pinch, double-click),
 * pans by dragging while zoomed, and takes keyboard zoom and pan.
 *
 * Keys are read from the group. Tab reaches its zoom buttons, and a pointer
 * press on the image moves focus into the group, so keys work after a click too.
 * The group is not itself a tab stop: a focusable region with no interactive
 * role fails the jsx-a11y rules.
 *
 * The view resets whenever `src` changes, so a new image always starts fitted.
 */
const ZoomableImage = ({ alt, className, onError, src }: ZoomableImageProps) => {
    const { i18n, t } = useLingui();
    const [{ eased, view }, setState] = useState<ZoomState>(INITIAL_STATE);
    const [shownSource, setShownSource] = useState(src);
    const [isDragging, setIsDragging] = useState(false);

    // A new image starts fitted. Adjusted during render, so the old view never paints for the new image.
    if (shownSource !== src) {
        setShownSource(src);
        setState(INITIAL_STATE);
    }

    const isZoomed = view.scale > MIN_ZOOM;
    const rootRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const dragRef = useRef<DragState | null>(null);
    const hintId = useId();

    // Steps taken before the image has layout wait in one queue, flushed in order once it has a size. One timer
    // serves the whole queue, so continuous input does not start a chain of timers per event.
    const pendingRef = useRef<PendingZoom>({ queue: [], retriesLeft: 0, timer: null });

    const flush = useCallback(function flushZoom(next: PendingStep | null, fromTimer = false) {
        const pending = pendingRef.current;
        const surface = surfaceRef.current;
        const image = imageRef.current;

        if (next) {
            if (pending.queue.length >= MAX_PENDING_STEPS) {
                pending.queue.shift();
            }

            pending.queue.push(next);
        }

        if (fromTimer) {
            pending.timer = null;
            pending.retriesLeft -= 1;
        }

        if (!surface || !image || pending.queue.length === 0) {
            return;
        }

        // Before the image has layout its size is zero, and a cursor-anchored zoom would clamp its pan to nothing.
        // Wait a bounded number of times, so a click before the first layout still counts and a picture that never
        // gets a size cannot hold the queue forever.
        if (image.offsetWidth === 0 || image.offsetHeight === 0) {
            // Each timer tick spends one try. Past the budget the queue is dropped, so the picture never gets a size.
            if (fromTimer) {
                if (pending.retriesLeft <= 0) {
                    pending.queue = [];

                    return;
                }

                pending.timer = setTimeout(flushZoom, LAYOUT_RETRY_MS, null, true);

                return;
            }

            // A step taken while no wait is running starts a fresh one, with its full budget.
            if (pending.timer === null) {
                pending.retriesLeft = LAYOUT_RETRIES;
                pending.timer = setTimeout(flushZoom, LAYOUT_RETRY_MS, null, true);
            }

            return;
        }

        if (pending.timer !== null) {
            clearTimeout(pending.timer);
            pending.timer = null;
        }

        const steps = pending.queue;

        pending.queue = [];

        // offsetWidth/offsetHeight ignore transforms: the fitted, unscaled size.
        const frame: Frame = {
            content: { height: image.offsetHeight, width: image.offsetWidth },
            viewport: { height: surface.clientHeight, width: surface.clientWidth },
        };

        setState((current) =>
            steps.reduce<ZoomState>((state, { isEased, step }) => {
                return { eased: isEased ?? state.eased, view: step(state.view, frame) };
            }, current),
        );
    }, []);

    // The one way the view changes: measure once, then apply `step` to the latest view. A functional update, so several
    // wheel events in one frame each build on the last. Eased only for the discrete steps; continuous input (wheel,
    // pinch, drag) must track the pointer without lag. `isEased` null keeps the announcement, for a resize.
    const apply = useCallback((step: ZoomStep, isEased: boolean | null = false) => flush({ isEased, step }), [flush]);

    // A new image drops the steps that were waiting for the old one.
    useEffect(
        () => () => {
            const pending = pendingRef.current;

            if (pending.timer !== null) {
                clearTimeout(pending.timer);
            }

            pendingRef.current = { queue: [], retriesLeft: 0, timer: null };
        },
        [src],
    );

    const zoomBy = useCallback((factor: number) => apply((current, frame) => zoomAround(current, current.scale * factor, CENTRE, frame), true), [apply]);
    const reset = useCallback(() => apply(() => INITIAL_ZOOM_VIEW, true), [apply]);

    // Native listener, because React's wheel listener is passive and cannot
    // cancel the browser's own zoom on a pinch.
    useEffect(() => {
        const surface = surfaceRef.current;

        if (!surface) {
            return undefined;
        }

        const onWheel = (event: WheelEvent) => {
            event.preventDefault();

            const pointer = pointerFromCentre(event, surface);
            const factor = wheelZoomFactor(wheelDeltaInPixels(event.deltaY, event.deltaMode), event.ctrlKey);

            apply((current, frame) => zoomAround(current, current.scale * factor, pointer, frame));
        };

        surface.addEventListener("wheel", onWheel, { passive: false });

        return () => {
            surface.removeEventListener("wheel", onWheel);
        };
    }, [apply]);

    // A resize changes the pan limits, so a view that was in range may no longer be.
    useEffect(() => {
        const surface = surfaceRef.current;

        if (!surface) {
            return undefined;
        }

        const observer = new ResizeObserver(() => apply(clampPan, null));

        observer.observe(surface);

        return () => {
            observer.disconnect();
        };
    }, [apply]);

    // A native listener rather than `onKeyDown`: the group has no interactive role, so jsx-a11y
    // rejects a React key handler on it. It also runs before React's root listener, so
    // `stopPropagation` keeps the key from the page's document-level shortcuts.
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

            const action = keyAction(event.key);

            // Escape and every other key stay with the dialog and the page.
            if (!action) {
                return;
            }

            // Arrows only pan a zoomed image; unzoomed, they keep their page-scroll meaning.
            if (!isZoomed && action.kind === "pan") {
                return;
            }

            // The page's arrow-key shortcuts listen on the document and ignore defaultPrevented.
            event.preventDefault();
            event.stopPropagation();

            if (action.kind === "pan") {
                apply((current, frame) => panBy(current, action.dx, action.dy, frame));
            } else if (action.kind === "reset") {
                reset();
            } else {
                zoomBy(action.factor);
            }
        };

        root.addEventListener("keydown", onKeyDown);

        return () => {
            root.removeEventListener("keydown", onKeyDown);
        };
    }, [apply, isZoomed, reset, zoomBy]);

    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        // Focus the group so its keys work after a click; it is not in the tab order.
        rootRef.current?.focus({ preventScroll: true });

        if (event.button !== 0 || view.scale <= MIN_ZOOM) {
            return;
        }

        // Each move pans by its distance from the last, so a zoom in mid-drag cannot leave a stale start.
        dragRef.current = { lastX: event.clientX, lastY: event.clientY, pointerId: event.pointerId };
        setState((current) => {
            return { ...current, eased: false };
        });
        setIsDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;

        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }

        const dx = event.clientX - drag.lastX;
        const dy = event.clientY - drag.lastY;

        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        apply((current, frame) => panBy(current, dx, dy, frame));
    };

    const endDrag = (event: PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId !== event.pointerId) {
            return;
        }

        dragRef.current = null;
        setIsDragging(false);
    };

    const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
        const pointer = pointerFromCentre(event, event.currentTarget);

        apply((current, frame) => doubleClickZoom(current, pointer, frame), true);
    };

    const percent = i18n.number(view.scale, { style: "percent" });

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
                className={cn(
                    "absolute inset-0 flex items-center justify-center overflow-hidden",
                    // Pinch is the browser's at scale 1; pan needs the touches once zoomed.
                    isZoomed && "touch-none",
                    cursorClass(isDragging, isZoomed),
                )}
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
                        eased && "motion-safe:transition-transform motion-safe:duration-150",
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
                <ToolbarButton label={t`Zoom out`} onClick={() => zoomBy(1 / BUTTON_ZOOM_FACTOR)}>
                    <ZoomOut aria-hidden="true" className="size-4" />
                </ToolbarButton>
                <ToolbarButton label={t`Reset zoom`} onClick={reset}>
                    <Maximize aria-hidden="true" className="size-4" />
                </ToolbarButton>
                <ToolbarButton label={t`Zoom in`} onClick={() => zoomBy(BUTTON_ZOOM_FACTOR)}>
                    <ZoomIn aria-hidden="true" className="size-4" />
                </ToolbarButton>
                <span aria-hidden="true" className="min-w-12 text-center text-xs text-white/80 tabular-nums">
                    {percent}
                </span>
                {/* Announced on the discrete steps only; a wheel or pinch step clears it, so it never floods a screen reader. */}
                <span aria-live="polite" className="sr-only" role="status">
                    {eased ? percent : ""}
                </span>
            </div>
        </div>
    );
};

export { ZoomableImage };
