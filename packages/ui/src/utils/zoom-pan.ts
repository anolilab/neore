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

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;
export const BUTTON_ZOOM_FACTOR = 1.25;
export const DOUBLE_CLICK_ZOOM = 2;
export const KEY_PAN_STEP = 40;

const WHEEL_SENSITIVITY = 0.0025;
const PINCH_SENSITIVITY = 0.01;
const MAX_WHEEL_DELTA = 250;
const DOM_DELTA_LINE = 1;
const LINE_HEIGHT_PX = 16;

export const INITIAL_ZOOM_VIEW: ZoomView = { scale: MIN_ZOOM, x: 0, y: 0 };

export const CENTRE: Point = { x: 0, y: 0 };

/**
 * The offset an arrow key applies, or null for any other key. Arrows move the
 * view as they do when a page scrolls: ArrowDown shows what is below, so the
 * image moves up.
 */
export const arrowKeyPan = (key: string): Point | null => {
    switch (key) {
        case "ArrowDown": {
            return { x: 0, y: -KEY_PAN_STEP };
        }
        case "ArrowLeft": {
            return { x: KEY_PAN_STEP, y: 0 };
        }
        case "ArrowRight": {
            return { x: -KEY_PAN_STEP, y: 0 };
        }
        case "ArrowUp": {
            return { x: 0, y: KEY_PAN_STEP };
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

/** A wheel event's delta in pixels. Firefox reports line deltas unless the page asks otherwise. */
export const wheelDeltaInPixels = (deltaY: number, deltaMode: number): number => (deltaMode === DOM_DELTA_LINE ? deltaY * LINE_HEIGHT_PX : deltaY);

/**
 * Multiplicative zoom for one wheel or pinch event: above 1 zooms in, below 1 zooms out.
 * Exponential, so an in-delta followed by an equal out-delta returns to the start.
 * A pinch arrives as a wheel event with `ctrlKey` and much smaller deltas than a mouse notch.
 */
export const wheelZoomFactor = (deltaPx: number, pinch: boolean): number => {
    const sensitivity = pinch ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY;
    const bounded = Math.min(MAX_WHEEL_DELTA, Math.max(-MAX_WHEEL_DELTA, deltaPx));

    return Math.exp(-bounded * sensitivity);
};

/** Keeps the translation inside the range where the scaled image still covers the viewport. */
export const clampPan = (view: ZoomView, content: Size, viewport: Size): ZoomView => {
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

export const zoomAround = (view: ZoomView, nextScale: number, pointer: Point, content: Size, viewport: Size): ZoomView =>
    clampPan(zoomAt(view, nextScale, pointer), content, viewport);

export const panBy = (view: ZoomView, dx: number, dy: number, content: Size, viewport: Size): ZoomView =>
    clampPan({ scale: view.scale, x: view.x + dx, y: view.y + dy }, content, viewport);

/** Double-click zooms in on the pointer, or resets when already zoomed. */
export const doubleClickZoom = (view: ZoomView, pointer: Point, content: Size, viewport: Size): ZoomView =>
    view.scale > MIN_ZOOM ? INITIAL_ZOOM_VIEW : zoomAround(view, DOUBLE_CLICK_ZOOM, pointer, content, viewport);
