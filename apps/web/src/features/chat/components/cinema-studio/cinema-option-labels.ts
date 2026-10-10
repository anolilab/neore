import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * `@neore/ai/constants/cinema` keeps English labels because the backend reads
 * them too, and `@neore/ai` has no Lingui. The UI words them through these
 * tables, keyed by option id (`"none"` for the unset option). Camera and lens
 * product names, focal lengths and f-stops are not translated, so only the
 * generic lens names have a label here. An id missing from a table keeps its
 * English text.
 */
export type CinemaOptionGroup = "aperture" | "camera" | "focalLength" | "lens";

interface CinemaOptionText {
    description?: MessageDescriptor;
    label?: MessageDescriptor;
}

const NONE: MessageDescriptor = msg`None`;

const CINEMA_OPTION_TEXT: Record<CinemaOptionGroup, Record<string, CinemaOptionText>> = {
    aperture: {
        "1.4": { description: msg`Ultra-shallow, extreme bokeh` },
        "2": { description: msg`Shallow, cinematic separation` },
        "2.8": { description: msg`Moderate, professional balance` },
        "4": { description: msg`Balanced, environmental context` },
        "5.6": { description: msg`Deeper, more context` },
        "8": { description: msg`Deep, documentary clarity` },
        "11": { description: msg`Very deep, landscape depth` },
        "16": { description: msg`Maximum depth, pin-sharp` },
        none: { description: msg`No aperture selected`, label: NONE },
    },
    camera: {
        "arri-alexa": { description: msg`Perfect skin tones, prestige TV` },
        "arriflex-16sr": { description: msg`Vintage indie, chunky grain` },
        blackmagic: { description: msg`Documentary realism, vivid` },
        imax: { description: msg`Epic film grain, grand scale` },
        none: { description: msg`No camera selected`, label: NONE },
        "panavision-dxl2": { description: msg`Polished Hollywood look` },
        "red-v-raptor": { description: msg`8K digital, punchy saturation` },
        "sony-venice": { description: msg`Neutral color, blockbuster look` },
    },
    focalLength: {
        "8": { description: msg`Fisheye, extreme distortion` },
        "14": { description: msg`Ultra-wide, architectural` },
        "24": { description: msg`Wide angle, storytelling` },
        "35": { description: msg`Intimate, street photography` },
        "50": { description: msg`Natural human eye perspective` },
        "85": { description: msg`Portrait, flattering proportions` },
        "100": { description: msg`Macro telephoto, tight framing` },
        "135": { description: msg`Telephoto, elegant distance` },
        "200": { description: msg`Extreme compression, voyeuristic` },
        none: { description: msg`No focal length selected`, label: NONE },
    },
    lens: {
        "canon-k35": { description: msg`1970s glass, dreamlike` },
        "cooke-s4": { description: msg`The Cooke Look, painterly` },
        fisheye: { description: msg`Extreme distortion`, label: msg`Fisheye` },
        "hawk-anamorphic": { description: msg`Modern anamorphic, sharp` },
        lensbaby: { description: msg`Sweet spot focus, dreamy` },
        macro: { description: msg`Extreme close-up detail`, label: msg`Macro` },
        none: { description: msg`No lens selected`, label: NONE },
        "panavision-anamorphic": { description: msg`2x squeeze, blue flares` },
        petzval: { description: msg`Swirly bokeh, vintage` },
        telephoto: { description: msg`Compressed perspective`, label: msg`Telephoto` },
        "tilt-shift": { description: msg`Selective focus plane`, label: msg`Tilt-Shift` },
        "wide-angle": { description: msg`Expansive field of view`, label: msg`Wide Angle` },
        "zeiss-ultra": { description: msg`Clinical sharpness, 3D pop` },
        zoom: { description: msg`Variable focal length`, label: msg`Zoom Lens` },
    },
};

interface CinemaOptionLike {
    description: string;
    id: string | number | undefined;
    label: string;
}

/** The option with its label and description in the UI locale; anything without a descriptor stays English. */
export const localizeCinemaOption = <T extends CinemaOptionLike>(
    group: CinemaOptionGroup,
    option: T,
    translate: (descriptor: MessageDescriptor) => string,
): T => {
    const key = option.id === undefined ? "none" : String(option.id);
    const text = Object.hasOwn(CINEMA_OPTION_TEXT[group], key) ? CINEMA_OPTION_TEXT[group][key] : undefined;

    if (!text) {
        return option;
    }

    return {
        ...option,
        description: text.description ? translate(text.description) : option.description,
        label: text.label ? translate(text.label) : option.label,
    };
};

export const localizeCinemaOptions = <T extends CinemaOptionLike>(
    group: CinemaOptionGroup,
    options: ReadonlyArray<T>,
    translate: (descriptor: MessageDescriptor) => string,
): T[] => options.map((option) => localizeCinemaOption(group, option, translate));

/** The localized label of the option with `id`, or `null` when `id` is unset or names no option. */
export const localizeCinemaOptionLabel = <T extends CinemaOptionLike>(
    group: CinemaOptionGroup,
    options: ReadonlyArray<T>,
    id: T["id"],
    translate: (descriptor: MessageDescriptor) => string,
): string | null => {
    const option = id === undefined ? undefined : options.find((candidate) => candidate.id === id);

    return option ? localizeCinemaOption(group, option, translate).label : null;
};
