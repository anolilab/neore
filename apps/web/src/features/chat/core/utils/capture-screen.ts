/**
 * One-frame screen capture for the composer's "Capture screen" attachment.
 *
 * `getDisplayMedia` asks the user which screen, window or tab to share; one
 * frame is drawn into a canvas and the stream is stopped at once, so the
 * browser's "sharing" indicator disappears as soon as the PNG exists. A user
 * who cancels the picker gets `null`, not an error.
 *
 * The Tauri shell uses the same web API: WebView2 and WKWebView implement it,
 * and where the webview does not (WebKitGTK builds without it) the button is
 * simply not offered.
 */

export const isScreenCaptureSupported = (): boolean =>
    typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function" && typeof document !== "undefined";

/** `screenshot-2026-09-25-14-03-07.png` — sortable, and never a name the attachment list already shows. */
export const screenshotFileName = (date: Date = new Date()): string => {
    const pad = (value: number): string => String(value).padStart(2, "0");

    return `screenshot-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.png`;
};

/** The picker was dismissed or permission refused: not worth an error toast. */
const CANCELLATION_ERRORS = new Set(["AbortError", "NotAllowedError", "SecurityError"]);

const isCancellation = (error: unknown): boolean => error instanceof DOMException && CANCELLATION_ERRORS.has(error.name);

const FRAME_TIMEOUT_MS = 5000;

/** Resolves once the video has a frame to draw. */
const waitForFrame = async (video: HTMLVideoElement): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for the captured frame")), FRAME_TIMEOUT_MS);
        const done = () => {
            clearTimeout(timer);
            resolve();
        };

        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
            done();

            return;
        }

        video.addEventListener("loadeddata", done, { once: true });
    });
};

const canvasToPng = async (canvas: HTMLCanvasElement): Promise<Blob> =>
    await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the screenshot"))), "image/png");
    });

/**
 * Ask for a screen, grab one frame, stop sharing, and return it as a PNG file —
 * or `null` if the user cancelled.
 */
export const captureScreenFrame = async (): Promise<File | null> => {
    if (!isScreenCaptureSupported()) {
        return null;
    }

    let stream: MediaStream;

    try {
        stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: true });
    } catch (error) {
        if (isCancellation(error)) {
            return null;
        }

        throw error;
    }

    const video = document.createElement("video");

    try {
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        await waitForFrame(video);

        const canvas = document.createElement("canvas");

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const context = canvas.getContext("2d");

        if (!context) {
            throw new Error("Canvas 2D is not available");
        }

        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const blob = await canvasToPng(canvas);

        return new File([blob], screenshotFileName(), { type: "image/png" });
    } finally {
        for (const track of stream.getTracks()) {
            track.stop();
        }

        video.pause();
        video.srcObject = null;
    }
};
