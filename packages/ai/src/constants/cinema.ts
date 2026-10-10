import type { Aperture, CameraType, FocalLength, LensType } from "../types/cinema";

export interface CameraOption {
    description: string;
    id: CameraType | undefined;
    label: string;
}

export interface LensOption {
    description: string;
    id: LensType | undefined;
    label: string;
}

export interface FocalLengthOption {
    description: string;
    id: FocalLength | undefined;
    label: string;
}

export interface ApertureOption {
    description: string;
    id: Aperture | undefined;
    label: string;
}

export const CAMERA_OPTIONS: CameraOption[] = [
    { description: "No camera selected", id: undefined, label: "None" },
    { description: "8K digital, punchy saturation", id: "red-v-raptor", label: "Red V-Raptor" },
    { description: "Neutral color, blockbuster look", id: "sony-venice", label: "Sony Venice 2" },
    { description: "Epic film grain, grand scale", id: "imax", label: "IMAX 70mm" },
    { description: "Vintage indie, chunky grain", id: "arriflex-16sr", label: "Arriflex 16SR" },
    { description: "Polished Hollywood look", id: "panavision-dxl2", label: "Panavision DXL2" },
    { description: "Perfect skin tones, prestige TV", id: "arri-alexa", label: "ARRI Alexa Mini LF" },
    { description: "Documentary realism, vivid", id: "blackmagic", label: "Blackmagic URSA 12K" },
];

export const LENS_OPTIONS: LensOption[] = [
    { description: "No lens selected", id: undefined, label: "None" },
    { description: "The Cooke Look, painterly", id: "cooke-s4", label: "Cooke S4i" },
    { description: "2x squeeze, blue flares", id: "panavision-anamorphic", label: "Panavision C-Series" },
    { description: "1970s glass, dreamlike", id: "canon-k35", label: "Canon K-35" },
    { description: "Modern anamorphic, sharp", id: "hawk-anamorphic", label: "Hawk V-Lite" },
    { description: "Clinical sharpness, 3D pop", id: "zeiss-ultra", label: "Zeiss Ultra Prime" },
    { description: "Sweet spot focus, dreamy", id: "lensbaby", label: "Lensbaby" },
    { description: "Swirly bokeh, vintage", id: "petzval", label: "Petzval Art" },
    { description: "Variable focal length", id: "zoom", label: "Zoom Lens" },
    { description: "Extreme close-up detail", id: "macro", label: "Macro" },
    { description: "Expansive field of view", id: "wide-angle", label: "Wide Angle" },
    { description: "Compressed perspective", id: "telephoto", label: "Telephoto" },
    { description: "Extreme distortion", id: "fisheye", label: "Fisheye" },
    { description: "Selective focus plane", id: "tilt-shift", label: "Tilt-Shift" },
];

export const FOCAL_LENGTH_OPTIONS: FocalLengthOption[] = [
    { description: "No focal length selected", id: undefined, label: "None" },
    { description: "Fisheye, extreme distortion", id: 8, label: "8mm" },
    { description: "Ultra-wide, architectural", id: 14, label: "14mm" },
    { description: "Wide angle, storytelling", id: 24, label: "24mm" },
    { description: "Intimate, street photography", id: 35, label: "35mm" },
    { description: "Natural human eye perspective", id: 50, label: "50mm" },
    { description: "Portrait, flattering proportions", id: 85, label: "85mm" },
    { description: "Macro telephoto, tight framing", id: 100, label: "100mm" },
    { description: "Telephoto, elegant distance", id: 135, label: "135mm" },
    { description: "Extreme compression, voyeuristic", id: 200, label: "200mm" },
];

export const APERTURE_OPTIONS: ApertureOption[] = [
    { description: "No aperture selected", id: undefined, label: "None" },
    { description: "Ultra-shallow, extreme bokeh", id: 1.4, label: "f/1.4" },
    { description: "Shallow, cinematic separation", id: 2, label: "f/2.0" },
    { description: "Moderate, professional balance", id: 2.8, label: "f/2.8" },
    { description: "Balanced, environmental context", id: 4, label: "f/4.0" },
    { description: "Deeper, more context", id: 5.6, label: "f/5.6" },
    { description: "Deep, documentary clarity", id: 8, label: "f/8.0" },
    { description: "Very deep, landscape depth", id: 11, label: "f/11" },
    { description: "Maximum depth, pin-sharp", id: 16, label: "f/16" },
];
