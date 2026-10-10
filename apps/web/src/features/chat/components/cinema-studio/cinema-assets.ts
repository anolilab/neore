/**
 * Cinema Studio Asset Mappings
 * Maps cinema option IDs to their corresponding generic .webp image assets
 * Using consistent generic imagery for unified visual style
 */
import type { CameraType, LensType } from "@neore/ai/types/cinema";

export const CINEMA_ASSET_URLS: Record<string, string> = {
    // Aperture assets - f-stop visualization
    1.4: "/images/cinema/f_1_4.webp",
    2: "/images/cinema/f_1_4.webp",
    2.8: "/images/cinema/f_1_4.webp",
    4: "/images/cinema/f_4.webp",
    5.6: "/images/cinema/f_4.webp",
    8: "/images/cinema/f_11.webp",
    11: "/images/cinema/f_11.webp",

    16: "/images/cinema/f_11.webp",
    "arri-alexa": "/images/cinema/premium_large_format_digital.webp",
    "arriflex-16sr": "/images/cinema/classic_16mm_film.webp",
    blackmagic: "/images/cinema/studio_digital_s35.webp",
    "canon-k35": "/images/cinema/70s_cinema_prime.webp",
    // Lens assets - generic cinema lens types
    "cooke-s4": "/images/cinema/warm_cinema_prime.webp",
    fisheye: "/images/cinema/halation_diffusion.webp",
    "hawk-anamorphic": "/images/cinema/compact_anamorphic.webp",
    imax: "/images/cinema/grand_format_70mm_film.webp",
    lensbaby: "/images/cinema/halation_diffusion.webp",
    macro: "/images/cinema/extreme_macro.webp",
    "panavision-anamorphic": "/images/cinema/classic_anamorphic.webp",
    "panavision-dxl2": "/images/cinema/premium_large_format_digital.webp",

    petzval: "/images/cinema/swirl_bokeh_portrait.webp",
    // Camera assets - generic cinema camera types
    "red-v-raptor": "/images/cinema/modular_8k_digital.webp",
    "sony-venice": "/images/cinema/full_frame_cine_digital.webp",
    telephoto: "/images/cinema/clinical_sharp_prime.webp",
    "tilt-shift": "/images/cinema/creative_tilt_lens.webp",
    "wide-angle": "/images/cinema/vintage_prime.webp",
    "zeiss-ultra": "/images/cinema/clinical_sharp_prime.webp",
    zoom: "/images/cinema/premium_modern_prime.webp",
};

export const getCinemaAssetUrl = (id: CameraType | LensType | string): string | undefined => CINEMA_ASSET_URLS[id];
