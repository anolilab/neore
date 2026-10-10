/**
 * Minimal local declarations for the subset of `@silvia-odwyer/photon` (web build,
 * v0.3.2) we call from the editor. The wasm package ships its own .d.ts that's
 * far larger; we keep a typed surface here so callers don't pull `any`
 * everywhere and so the operation catalog is checkable without loading wasm.
 */

// ---------------------------------------------------------------------------
// Compile-time sanity check
// ---------------------------------------------------------------------------
//
// `loadPhoton()` casts the dynamically-imported module via `as unknown as Photon`,
// which would silently mask any drift between our narrowed interface and the
// real wasm-pack output. The check below imports the real `.d.ts` and pins the
// subset of names we depend on — a future Photon release that renames or
// removes any of them will fail type-check rather than fail at runtime.
//
// `PhotonImage`, `open_image`, `putImageData`, `base64_to_image`, and `default`
// are excluded because their typings on the real module use module-specific
// shapes (a class declaration and a wasm-bindgen init function) that don't
// line up 1:1 with our minimal interface signatures.

import type * as PhotonModule from "@silvia-odwyer/photon";

export interface PhotonImage {
    free: () => void;
    get_base64: () => string;
    get_image_data: () => ImageData;
    get_raw_pixels: () => Uint8Array;
    height: number;
    width: number;
}

export interface Photon {
    adjust_contrast: (img: PhotonImage, amount: number) => void;
    alter_blue_channel: (img: PhotonImage, amount: number) => void;
    alter_green_channel: (img: PhotonImage, amount: number) => void;
    // Channels
    alter_red_channel: (img: PhotonImage, amount: number) => void;

    base64_to_image: (base64: string) => PhotonImage;
    box_blur: (img: PhotonImage) => void;
    cali: (img: PhotonImage) => void;
    colorize: (img: PhotonImage) => void;
    crop: (img: PhotonImage, x1: number, y1: number, x2: number, y2: number) => PhotonImage;
    darken_hsl: (img: PhotonImage, level: number) => void;
    // Module init (wasm-bindgen ESM builds)
    default?: () => Promise<unknown>;
    desaturate_hsl: (img: PhotonImage, level: number) => void;
    dither: (img: PhotonImage, depth: number) => void;

    dramatic: (img: PhotonImage) => void;
    duotone_horizon: (img: PhotonImage) => void;
    duotone_lilac: (img: PhotonImage) => void;
    duotone_ochre: (img: PhotonImage) => void;
    duotone_violette: (img: PhotonImage) => void;
    edge_detection: (img: PhotonImage) => void;
    emboss: (img: PhotonImage) => void;
    // Filters (string preset)
    filter: (img: PhotonImage, preset: string) => void;

    firenze: (img: PhotonImage) => void;
    fliph: (img: PhotonImage) => void;
    flipv: (img: PhotonImage) => void;
    frosted_glass: (img: PhotonImage) => void;
    gamma_correction: (img: PhotonImage, r: number, g: number, b: number) => void;

    // Effects
    gaussian_blur: (img: PhotonImage, radius: number) => void;

    golden: (img: PhotonImage) => void;
    // Color / monochrome
    grayscale: (img: PhotonImage) => void;
    grayscale_human_corrected: (img: PhotonImage) => void;
    horizontal_strips: (img: PhotonImage, strips: number) => void;
    hue_rotate_hsl: (img: PhotonImage, degrees: number) => void;
    // Adjust
    inc_brightness: (img: PhotonImage, amount: number) => void;
    invert: (img: PhotonImage) => void;
    lighten_hsl: (img: PhotonImage, level: number) => void;
    lix: (img: PhotonImage) => void;
    // Standalone filter functions
    lofi: (img: PhotonImage) => void;
    neue: (img: PhotonImage) => void;
    noise_reduction: (img: PhotonImage) => void;
    normalize: (img: PhotonImage) => void;
    obsidian: (img: PhotonImage) => void;

    offset_blue: (img: PhotonImage, amount: number) => void;
    offset_green: (img: PhotonImage, amount: number) => void;
    offset_red: (img: PhotonImage, amount: number) => void;
    oil: (img: PhotonImage, radius: number, intensity: number) => void;
    open_image: (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => PhotonImage;
    pastel_pink: (img: PhotonImage) => void;
    PhotonImage: {
        new_from_base64: (base64: string) => PhotonImage;
        new_from_byteslice: (bytes: Uint8Array) => PhotonImage;
    };
    pixelize: (img: PhotonImage, size: number) => void;
    primary: (img: PhotonImage) => void;
    putImageData: (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, image: PhotonImage) => void;
    resize: (img: PhotonImage, width: number, height: number, sampling: number) => PhotonImage;
    // Transform (rotate/resize/crop return a NEW image)
    rotate: (img: PhotonImage, degrees: number) => PhotonImage;

    ryo: (img: PhotonImage) => void;
    saturate_hsl: (img: PhotonImage, level: number) => void;
    sepia: (img: PhotonImage) => void;
    sharpen: (img: PhotonImage) => void;
    solarize: (img: PhotonImage) => void;
    swap_channels: (img: PhotonImage, ch1: number, ch2: number) => void;
    threshold: (img: PhotonImage, level: number) => void;

    vertical_strips: (img: PhotonImage, strips: number) => void;
}

type ExcludedKeys = "PhotonImage" | "default" | "open_image" | "putImageData" | "base64_to_image";

/**
 * Exported so TS's `noUnusedLocals` doesn't trip on the type-only assertion.
 * The `Pick` will fail to resolve at compile time if any function our narrowed
 * `Photon` interface declares is missing from the real `@silvia-odwyer/photon`
 * module — e.g. a future rename of `inc_brightness` would surface here.
 */
export type PhotonSanityCheck = Pick<typeof PhotonModule, Exclude<keyof Photon, ExcludedKeys>>;
