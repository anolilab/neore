import type { CameraType, CinemaSettings, FocalLength, LensType } from "../types/cinema";

interface CameraLogic {
    modifiers: string;
    sensor: string;
    shortName: string;
}

interface LensLogic {
    modifiers: string;
    type: string;
}

const RED_V_RAPTOR_MODIFIERS =
    "shot on Red V-Raptor, 8k digital cinema, clean image with zero grain, punchy saturation, high micro-contrast, clinical sharpness, modern commercial aesthetic, hard dynamic range, hyper-realistic texture";

const IMAX_MODIFIERS =
    "shot on IMAX 70mm film, immense resolution, fine organic film grain, unbeatable dynamic range, soft highlight roll-off, grand scale composition, rich texture, epic cinematic atmosphere";

const PANAVISION_ANAMORPHIC_MODIFIERS =
    "Panavision C-Series Anamorphic lens, 2x squeeze, distinctive oval bokeh, horizontal blue streak lens flares, barrel distortion at edges, vintage optical imperfections, widescreen cinematic aspect ratio";

const COOKE_S4_MODIFIERS = "Cooke S4i Prime lens, The Cooke Look, warm painterly skin tones, creamy bokeh, low micro-contrast, gentle focus fall-off";

const CANON_K35_MODIFIERS = "Canon K-35 Vintage Prime, 1970s glass, soft glowing highlights, low contrast, spherical aberration, dreamlike sharpness";

const CAMERA_LOGIC: Record<CameraType, CameraLogic> = {
    "8k-digital": { modifiers: RED_V_RAPTOR_MODIFIERS, sensor: "Vista Vision 8K", shortName: "Red V-Raptor" },
    "70mm-film": { modifiers: IMAX_MODIFIERS, sensor: "70mm Film", shortName: "IMAX 15/70mm" },
    "arri-alexa": {
        modifiers:
            "shot on ARRI Alexa Mini LF, Arri color science, creamy highlight roll-off, perfect skin tones, organic digital look, teal and orange nuance, soft natural contrast, cinematic prestige TV look",
        sensor: "Large Format",
        shortName: "ARRI Alexa Mini LF",
    },
    "arriflex-16sr": {
        modifiers:
            "shot on Arriflex 16SR, 16mm film stock, heavy chunky grain, soft contrast, vintage indie movie look, dancing grain structure, slightly fuzzy details, nostalgic warm color palette, organic imperfections",
        sensor: "Super 16mm Film",
        shortName: "Arriflex 16SR3",
    },
    blackmagic: {
        modifiers:
            "shot on Blackmagic URSA, raw digital footage, sharp digital edge, high saturation, distinct digital noise pattern in shadows, documentary style realism, vivid colors",
        sensor: "Super 35",
        shortName: "Blackmagic URSA 12K",
    },
    imax: {
        modifiers: IMAX_MODIFIERS,
        sensor: "70mm Film",
        shortName: "IMAX 15/70mm",
    },
    "panavision-dxl2": {
        modifiers:
            "shot on Panavision Millennium DXL2, large format sensor, impossible depth of field, 3D subject separation, smooth color science, polished hollywood look, high fidelity, rich blacks",
        sensor: "Large Format 8K",
        shortName: "Panavision DXL2",
    },
    "red-epic": { modifiers: RED_V_RAPTOR_MODIFIERS, sensor: "Vista Vision 8K", shortName: "Red V-Raptor" },
    "red-v-raptor": {
        modifiers: RED_V_RAPTOR_MODIFIERS,
        sensor: "Vista Vision 8K",
        shortName: "Red V-Raptor",
    },
    "sony-venice": {
        modifiers:
            "shot on Sony Venice 2, neutral color science, realistic skin tones, transparent image character, balanced contrast, dual base ISO look, blockbuster movie aesthetic, clean shadows",
        sensor: "Full Frame 8.6K",
        shortName: "Sony Venice 2",
    },
};

const LENS_LOGIC: Record<LensType, LensLogic> = {
    anamorphic: { modifiers: PANAVISION_ANAMORPHIC_MODIFIERS, type: "Anamorphic" },
    "bokeh-master": {
        modifiers: "bokeh master lens, creamy background separation, circular aperture, smooth out-of-focus rendering",
        type: "Bokeh Specialty",
    },
    "canon-k35": {
        modifiers: `${CANON_K35_MODIFIERS}, vintage optical flares, warm organic character, slight blooming`,
        type: "Vintage Spherical",
    },
    "cine-lens": { modifiers: "professional cinema lens, smooth bokeh, controlled aberrations, cinematic rendering", type: "Cinema" },
    "cooke-s4": {
        modifiers:
            "Cooke S4i Prime lens, The Cooke Look, warm painterly skin tones, creamy bokeh, low micro-contrast, gentle focus fall-off, flattering portrait rendering, smooth optical characteristics",
        type: "Spherical",
    },
    fisheye: {
        modifiers:
            "fisheye lens, extreme barrel distortion, hemispherical 180° view, curved lines, experimental perspective, surreal spatial warping, action sports aesthetic",
        type: "Fisheye",
    },
    "hawk-anamorphic": {
        modifiers:
            "Hawk V-Lite Anamorphic lens, sharp vintage look, controlled distortion, unique flare characteristics, 1.3x squeeze factor, modern anamorphic aesthetic, high contrast compared to vintage glass",
        type: "Anamorphic",
    },
    lensbaby: {
        modifiers:
            "Lensbaby Composer Pro, sweet spot focus, heavy radial blur, dreamy tilt-shift effect, distorted edges, ethereal atmosphere, strong halation, experimental optical effects, soft focus",
        type: "Experimental",
    },
    macro: {
        modifiers:
            "macro lens, extreme close-up magnification, razor-thin depth of field, revealing microscopic detail, 1:1 reproduction ratio, shallow focus plane, textural emphasis",
        type: "Macro",
    },
    "panavision-anamorphic": {
        modifiers: `${PANAVISION_ANAMORPHIC_MODIFIERS}, soft corners, astigmatism`,
        type: "Anamorphic",
    },
    petzval: {
        modifiers:
            "Petzval Art Lens, distinctive swirly bokeh, center sharpness only, strong vignetting, 19th-century portrait aesthetic, radial background blur, chaotic out-of-focus areas, brass lens character",
        type: "Vintage Art",
    },
    prime: { modifiers: COOKE_S4_MODIFIERS, type: "Spherical" },
    telephoto: {
        modifiers:
            "telephoto lens, compressed perspective, background isolation, flattened depth, voyeuristic distance, shallow depth of field, abstract background blur, long throw aesthetic",
        type: "Telephoto",
    },
    "tilt-shift": {
        modifiers:
            "tilt-shift lens, selective focus plane, miniature diorama effect, architectural perspective correction, floating focus band, creative depth manipulation, unique bokeh gradient",
        type: "Tilt-Shift",
    },
    "vintage-lens": { modifiers: CANON_K35_MODIFIERS, type: "Vintage Spherical" },
    "wide-angle": {
        modifiers:
            "wide-angle lens, expansive field of view, slight barrel distortion at edges, environmental storytelling, deep depth of field, dynamic spatial relationships, immersive perspective",
        type: "Wide",
    },
    "zeiss-ultra": {
        modifiers:
            "Zeiss Ultra Prime lens, clinical sharpness, zero distortion, high micro-contrast, ruthlessly detailed, 3D pop, cool neutral tones, perfect optical correction, almost too sharp",
        type: "Spherical",
    },
    zoom: {
        modifiers:
            "cinema zoom lens, variable focal length, smooth optical transitions, versatile framing, slight breathing during focus, professional broadcast aesthetic",
        type: "Zoom",
    },
};

const FOCAL_LENGTH_LOGIC: Record<FocalLength, string> = {
    8: "fisheye perspective, extreme distortion, ultra-wide field of view, experimental framing, exaggerated scale",
    14: "14mm ultra-wide angle, expanded background, deep depth of field, architectural framing, dynamic perspective",
    24: "24mm wide angle, establishing shot, environmental context, slight distortion at edges, storytelling perspective",
    35: "35mm focal length, intimate perspective, street photography style, immersive feel, slight facial distortion, distinct subject-environment relationship",
    50: "50mm standard lens, natural human eye perspective, medium shot, balanced compression, unbiased observation",
    85: "85mm portrait lens, flattering facial proportions, telephoto compression, subject isolation, creamy bokeh background, shallow depth of field",
    100: "100mm macro telephoto, tight framing, intense focus on details, compressed space, elegant distance",
    135: "135mm telephoto, background compression, elegant distance, portrait isolation",
    200: "200mm telephoto, extreme background compression, voyeuristic distance, flat background, abstract bokeh layers",
};

const getApertureModifiers = (aperture: number): string => {
    if (aperture <= 1.4) {
        return "f/1.4 aperture, ultra-shallow depth of field, extreme background blur, razor-thin focus plane, dreamy bokeh";
    }

    if (aperture <= 2) {
        return "f/2.0 aperture, shallow depth of field, beautiful background separation, cinematic bokeh, subject isolation";
    }

    if (aperture <= 2.8) {
        return "f/2.8 aperture, moderate depth of field, balanced focus, professional look, smooth bokeh transition";
    }

    if (aperture <= 5.6) {
        return "f/5.6 aperture, balanced depth of field, more environmental context, sharper details throughout";
    }

    if (aperture <= 8) {
        return "f/8.0 aperture, deep depth of field, sharp foreground and background, documentary style clarity";
    }

    if (aperture <= 11) {
        return "f/11 aperture, very deep focus, landscape photography depth, everything sharp from near to far";
    }

    return "f/16 aperture, maximum depth of field, pin-sharp throughout, architectural precision, no bokeh";
};

const VISUAL_STANDARDS =
    "photorealistic imagery, professional color grading, cinematic lighting, physically accurate shadows, realistic material properties, proper exposure";

const NEGATIVE_MODIFIERS =
    "Avoid: digital artifacts, over-sharpening, HDR halos, unnatural saturation, fake bokeh effects, unrealistic lighting, cartoonish rendering, artificial noise";

const buildCinemaPrompt = (basePrompt: string, cinema?: CinemaSettings): string => {
    if (!cinema?.enabled) {
        return basePrompt;
    }

    const sections = [
        "You are the Visual Reasoning Engine. Your task is to output photorealistic imagery by simulating a physical camera.",
        `Scene: ${basePrompt}`,
        VISUAL_STANDARDS,
    ];

    if (cinema.camera) {
        sections.push(CAMERA_LOGIC[cinema.camera].modifiers);
    }

    if (cinema.lens) {
        sections.push(LENS_LOGIC[cinema.lens].modifiers);
    }

    if (cinema.focalLength) {
        sections.push(FOCAL_LENGTH_LOGIC[cinema.focalLength]);
    }

    if (cinema.aperture) {
        sections.push(getApertureModifiers(cinema.aperture));
    }

    sections.push(NEGATIVE_MODIFIERS);

    return sections.join(". ");
};

export { buildCinemaPrompt };
export default buildCinemaPrompt;
