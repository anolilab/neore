export type CameraType =
    "red-v-raptor" | "sony-venice" | "imax" | "arriflex-16sr" | "panavision-dxl2" | "arri-alexa" | "blackmagic" | "red-epic" | "70mm-film" | "8k-digital";

export type LensType =
    | "cooke-s4"
    | "panavision-anamorphic"
    | "canon-k35"
    | "hawk-anamorphic"
    | "lensbaby"
    | "petzval"
    | "zeiss-ultra"
    | "anamorphic"
    | "prime"
    | "vintage-lens"
    | "zoom"
    | "macro"
    | "wide-angle"
    | "telephoto"
    | "fisheye"
    | "tilt-shift"
    | "cine-lens"
    | "bokeh-master";

export type FocalLength = 8 | 14 | 24 | 35 | 50 | 85 | 100 | 135 | 200;
export type Aperture = 1.4 | 2 | 2.8 | 4 | 5.6 | 8 | 11 | 16;

export interface CinemaSettings {
    aperture?: Aperture;
    camera?: CameraType;
    enabled: boolean;
    focalLength?: FocalLength;
    lens?: LensType;
}
