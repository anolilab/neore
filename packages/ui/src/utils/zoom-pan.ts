/**
 * Zoom and pan math for a transformed image.
 *
 * The transform is `translate(x, y) scale(scale)` with `transform-origin` at the
 * centre of the image, and the image is centred in its viewport. Every offset
 * and pointer below is measured from the viewport centre, in CSS pixels.
 */

export interface ZoomView {
    scale: number;
    x: number;
    y: number;
}

export interface Point {
    x: number;
    y: number;
}

export interface Size {
    height: number;
    width: number;
}

/** What a zoom or pan is measured against: the fitted, unscaled image and the viewport it sits in. */
export interface Frame {
    content: Size;
    viewport: Size;
}

export type KeyAction = { dx: number; dy: number; kind: "pan" } | { factor: number; kind: "zoom" } | { kind: "reset" };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;
export const BUTTON_ZOOM_FACTOR = 1.25;

const DOUBLE_CLICK_ZOOM = 2;
const KEY_PAN_STEP = 40;
const WHEEL_SENSITIVITY = 0.0025;
const PINCH_SENSITIVITY = 0.01;
// One event may change the scale by at most e^0.5 (about 1.65x). A Ctrl+mouse-wheel notch arrives
// as a pinch with a mouse-sized delta (100 or more), which would otherwise zoom by e^1 or beyond.
const MAX_STEP_EXPONENT = 0.5;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;

export const INITIAL_ZOOM_VIEW: ZoomView = { scale: MIN_ZOOM, x: 0, y: 0 };

export const CENTRE: Point = { x: 0, y: 0 };

/**
 * What a key does to the view, or null for a key the viewer ignores. Arrows move the
 * view as they do when a page scrolls: ArrowDown shows what is below, so the image
 * moves up.
 */
export const keyAction = (key: string): KeyAction | null => {
    switch (key) {
        case "0": {
            return { kind: "reset" };
        }
        case "+":
        case "=": {
            return { factor: BUTTON_ZOOM_FACTOR, kind: "zoom" };
        }
        case "-":
        case "_": {
            return { factor: 1 / BUTTON_ZOOM_FACTOR, kind: "zoom" };
        }
        case "ArrowDown": {
            return { dx: 0, dy: -KEY_PAN_STEP, kind: "pan" };
        }
        case "ArrowLeft": {
            return { dx: KEY_PAN_STEP, dy: 0, kind: "pan" };
        }
        case "ArrowRight": {
            return { dx: -KEY_PAN_STEP, dy: 0, kind: "pan" };
        }
        case "ArrowUp": {
            return { dx: 0, dy: KEY_PAN_STEP, kind: "pan" };
        }
        default: {
            return null;
        }
    }
};

export const clampZoom = (scale: number): number => {
    if (Number.isNaN(scale)) {
        return MIN_ZOOM;
    }

    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
};

/** A wheel event's vertical delta in pixels. Firefox reports line deltas, and some devices page deltas. */
export const wheelDeltaInPixels = (deltaY: number, deltaMode: number): number => {
    if (deltaMode === DOM_DELTA_LINE) {
        return deltaY * LINE_HEIGHT_PX;
    }

    return deltaMode === DOM_DELTA_PAGE ? deltaY * PAGE_HEIGHT_PX : deltaY;
};

/**
 * Multiplicative zoom for one wheel or pinch event: above 1 zooms in, below 1 zooms out.
 * Exponential, so an in-delta followed by an equal out-delta returns to the start.
 * A pinch arrives as a wheel event with `ctrlKey` and much smaller deltas than a mouse notch.
 */
export const wheelZoomFactor = (deltaPx: number, pinch: boolean): number => {
    const sensitivity = pinch ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY;

    return Math.exp(Math.min(MAX_STEP_EXPONENT, Math.max(-MAX_STEP_EXPONENT, -deltaPx * sensitivity)));
};

/** Keeps the translation inside the range where the scaled image still covers the viewport. */
export const clampPan = (view: ZoomView, { content, viewport }: Frame): ZoomView => {
    if (view.scale <= MIN_ZOOM) {
        return { scale: MIN_ZOOM, x: 0, y: 0 };
    }

    const maxX = Math.max(0, (content.width * view.scale - viewport.width) / 2);
    const maxY = Math.max(0, (content.height * view.scale - viewport.height) / 2);

    return {
        scale: view.scale,
        x: Math.min(maxX, Math.max(-maxX, view.x)),
        y: Math.min(maxY, Math.max(-maxY, view.y)),
    };
};

/**
 * Scales to `nextScale` and moves the offset so the image point under `pointer`
 * stays under it. The offset is not clamped here; `zoomAround` does that.
 */
export const zoomAt = (view: ZoomView, nextScale: number, pointer: Point): ZoomView => {
    const scale = clampZoom(nextScale);
    const ratio = scale / view.scale;

    return {
        scale,
        x: pointer.x - (pointer.x - view.x) * ratio,
        y: pointer.y - (pointer.y - view.y) * ratio,
    };
};

export const zoomAround = (view: ZoomView, nextScale: number, pointer: Point, frame: Frame): ZoomView => clampPan(zoomAt(view, nextScale, pointer), frame);

export const panBy = (view: ZoomView, dx: number, dy: number, frame: Frame): ZoomView => clampPan({ scale: view.scale, x: view.x + dx, y: view.y + dy }, frame);

/** Double-click zooms in on the pointer, or resets when already zoomed. */
export const doubleClickZoom = (view: ZoomView, pointer: Point, frame: Frame): ZoomView =>
    view.scale > MIN_ZOOM ? INITIAL_ZOOM_VIEW : zoomAround(view, DOUBLE_CLICK_ZOOM, pointer, frame);
