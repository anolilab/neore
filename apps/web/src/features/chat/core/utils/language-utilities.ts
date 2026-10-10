"use client";

import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// Type for lingui's t macro (template literal tag function)

type LinguiT = (template: TemplateStringsArray, ...args: any[]) => string;

// Comprehensive list of BCP 47 language codes supported by Web Speech API and ElevenLabs
// These are language codes (ISO 639-1) combined with country codes (ISO 3166-1 alpha-2)
export const LANGUAGE_CODES = [
    "af-ZA", // Afrikaans
    "ar-SA", // Arabic (Saudi Arabia)
    "ar-EG", // Arabic (Egypt)
    "ar-AE", // Arabic (UAE)
    "az-AZ", // Azerbaijani
    "be-BY", // Belarusian
    "bg-BG", // Bulgarian
    "bn-BD", // Bengali (Bangladesh)
    "bs-BA", // Bosnian
    "ca-ES", // Catalan
    "cs-CZ", // Czech
    "cy-GB", // Welsh
    "da-DK", // Danish
    "de-DE", // German
    "de-AT", // German (Austria)
    "de-CH", // German (Switzerland)
    "el-GR", // Greek
    "en-US", // English (US)
    "en-GB", // English (UK)
    "en-AU", // English (Australia)
    "en-CA", // English (Canada)
    "en-IE", // English (Ireland)
    "en-NZ", // English (New Zealand)
    "en-ZA", // English (South Africa)
    "es-ES", // Spanish (Spain)
    "es-MX", // Spanish (Mexico)
    "es-AR", // Spanish (Argentina)
    "es-CO", // Spanish (Colombia)
    "es-CL", // Spanish (Chile)
    "es-PE", // Spanish (Peru)
    "es-VE", // Spanish (Venezuela)
    "es-EC", // Spanish (Ecuador)
    "es-GT", // Spanish (Guatemala)
    "es-CU", // Spanish (Cuba)
    "es-BO", // Spanish (Bolivia)
    "es-DO", // Spanish (Dominican Republic)
    "es-HN", // Spanish (Honduras)
    "es-PY", // Spanish (Paraguay)
    "es-SV", // Spanish (El Salvador)
    "es-NI", // Spanish (Nicaragua)
    "es-CR", // Spanish (Costa Rica)
    "es-PA", // Spanish (Panama)
    "es-UY", // Spanish (Uruguay)
    "et-EE", // Estonian
    "fa-IR", // Persian
    "fi-FI", // Finnish
    "fr-FR", // French
    "fr-CA", // French (Canada)
    "fr-BE", // French (Belgium)
    "fr-CH", // French (Switzerland)
    "ga-IE", // Irish
    "gl-ES", // Galician
    "gu-IN", // Gujarati
    "he-IL", // Hebrew
    "hi-IN", // Hindi
    "hr-HR", // Croatian
    "hu-HU", // Hungarian
    "hy-AM", // Armenian
    "id-ID", // Indonesian
    "is-IS", // Icelandic
    "it-IT", // Italian
    "it-CH", // Italian (Switzerland)
    "ja-JP", // Japanese
    "jv-ID", // Javanese
    "ka-GE", // Georgian
    "kk-KZ", // Kazakh
    "km-KH", // Khmer
    "kn-IN", // Kannada
    "ko-KR", // Korean
    "ky-KG", // Kyrgyz
    "lo-LA", // Lao
    "lt-LT", // Lithuanian
    "lv-LV", // Latvian
    "mk-MK", // Macedonian
    "ml-IN", // Malayalam
    "mn-MN", // Mongolian
    "mr-IN", // Marathi
    "ms-MY", // Malay
    "mt-MT", // Maltese
    "my-MM", // Myanmar
    "ne-NP", // Nepali
    "nl-NL", // Dutch
    "nl-BE", // Dutch (Belgium)
    "no-NO", // Norwegian
    "pa-IN", // Punjabi
    "pl-PL", // Polish
    "ps-AF", // Pashto
    "pt-BR", // Portuguese (Brazil)
    "pt-PT", // Portuguese (Portugal)
    "ro-RO", // Romanian
    "ru-RU", // Russian
    "si-LK", // Sinhala
    "sk-SK", // Slovak
    "sl-SI", // Slovenian
    "sq-AL", // Albanian
    "sr-RS", // Serbian
    "su-ID", // Sundanese
    "sv-SE", // Swedish
    "sw-KE", // Swahili
    "ta-IN", // Tamil
    "te-IN", // Telugu
    "th-TH", // Thai
    "tr-TR", // Turkish
    "uk-UA", // Ukrainian
    "ur-PK", // Urdu
    "uz-UZ", // Uzbek
    "vi-VN", // Vietnamese
    "zh-CN", // Chinese (Simplified)
    "zh-TW", // Chinese (Traditional)
    "zh-HK", // Chinese (Hong Kong)
    "zu-ZA", // Zulu
] as const;

// Complete language name translations for all language codes - must be at top level for Lingui extraction
// Using msg macro to create message descriptors that can be translated at runtime
const LANGUAGE_VARIANT_NAMES = {
    "af-ZA": msg`Afrikaans (South Africa)`,
    "ar-AE": msg`Arabic (UAE)`,
    "ar-EG": msg`Arabic (Egypt)`,
    "ar-SA": msg`Arabic (Saudi Arabia)`,
    "az-AZ": msg`Azerbaijani (Azerbaijan)`,
    "be-BY": msg`Belarusian (Belarus)`,
    "bg-BG": msg`Bulgarian (Bulgaria)`,
    "bn-BD": msg`Bengali (Bangladesh)`,
    "bs-BA": msg`Bosnian (Bosnia)`,
    "ca-ES": msg`Catalan (Spain)`,
    "cs-CZ": msg`Czech (Czech Republic)`,
    "cy-GB": msg`Welsh (UK)`,
    "da-DK": msg`Danish (Denmark)`,
    "de-AT": msg`German (Austria)`,
    "de-CH": msg`German (Switzerland)`,
    "de-DE": msg`German`,
    "el-GR": msg`Greek (Greece)`,
    "en-AU": msg`English (Australia)`,
    "en-CA": msg`English (Canada)`,
    "en-GB": msg`English (UK)`,
    "en-IE": msg`English (Ireland)`,
    "en-NZ": msg`English (New Zealand)`,
    "en-US": msg`English (US)`,
    "en-ZA": msg`English (South Africa)`,
    "es-AR": msg`Spanish (Argentina)`,
    "es-BO": msg`Spanish (Bolivia)`,
    "es-CL": msg`Spanish (Chile)`,
    "es-CO": msg`Spanish (Colombia)`,
    "es-CR": msg`Spanish (Costa Rica)`,
    "es-CU": msg`Spanish (Cuba)`,
    "es-DO": msg`Spanish (Dominican Republic)`,
    "es-EC": msg`Spanish (Ecuador)`,
    "es-ES": msg`Spanish (Spain)`,
    "es-GT": msg`Spanish (Guatemala)`,
    "es-HN": msg`Spanish (Honduras)`,
    "es-MX": msg`Spanish (Mexico)`,
    "es-NI": msg`Spanish (Nicaragua)`,
    "es-PA": msg`Spanish (Panama)`,
    "es-PE": msg`Spanish (Peru)`,
    "es-PY": msg`Spanish (Paraguay)`,
    "es-SV": msg`Spanish (El Salvador)`,
    "es-UY": msg`Spanish (Uruguay)`,
    "es-VE": msg`Spanish (Venezuela)`,
    "et-EE": msg`Estonian (Estonia)`,
    "fa-IR": msg`Persian (Iran)`,
    "fi-FI": msg`Finnish (Finland)`,
    "fr-BE": msg`French (Belgium)`,
    "fr-CA": msg`French (Canada)`,
    "fr-CH": msg`French (Switzerland)`,
    "fr-FR": msg`French`,
    "ga-IE": msg`Irish (Ireland)`,
    "gl-ES": msg`Galician (Spain)`,
    "gu-IN": msg`Gujarati (India)`,
    "he-IL": msg`Hebrew (Israel)`,
    "hi-IN": msg`Hindi (India)`,
    "hr-HR": msg`Croatian (Croatia)`,
    "hu-HU": msg`Hungarian (Hungary)`,
    "hy-AM": msg`Armenian (Armenia)`,
    "id-ID": msg`Indonesian (Indonesia)`,
    "is-IS": msg`Icelandic (Iceland)`,
    "it-CH": msg`Italian (Switzerland)`,
    "it-IT": msg`Italian`,
    "ja-JP": msg`Japanese (Japan)`,
    "jv-ID": msg`Javanese (Indonesia)`,
    "ka-GE": msg`Georgian (Georgia)`,
    "kk-KZ": msg`Kazakh (Kazakhstan)`,
    "km-KH": msg`Khmer (Cambodia)`,
    "kn-IN": msg`Kannada (India)`,
    "ko-KR": msg`Korean (South Korea)`,
    "ky-KG": msg`Kyrgyz (Kyrgyzstan)`,
    "lo-LA": msg`Lao (Laos)`,
    "lt-LT": msg`Lithuanian (Lithuania)`,
    "lv-LV": msg`Latvian (Latvia)`,
    "mk-MK": msg`Macedonian (North Macedonia)`,
    "ml-IN": msg`Malayalam (India)`,
    "mn-MN": msg`Mongolian (Mongolia)`,
    "mr-IN": msg`Marathi (India)`,
    "ms-MY": msg`Malay (Malaysia)`,
    "mt-MT": msg`Maltese (Malta)`,
    "my-MM": msg`Myanmar (Myanmar)`,
    "ne-NP": msg`Nepali (Nepal)`,
    "nl-BE": msg`Dutch (Belgium)`,
    "nl-NL": msg`Dutch`,
    "no-NO": msg`Norwegian (Norway)`,
    "pa-IN": msg`Punjabi (India)`,
    "pl-PL": msg`Polish (Poland)`,
    "ps-AF": msg`Pashto`,
    "pt-BR": msg`Portuguese (Brazil)`,
    "pt-PT": msg`Portuguese (Portugal)`,
    "ro-RO": msg`Romanian (Romania)`,
    "ru-RU": msg`Russian (Russia)`,
    "si-LK": msg`Sinhala (Sri Lanka)`,
    "sk-SK": msg`Slovak (Slovakia)`,
    "sl-SI": msg`Slovenian (Slovenia)`,
    "sq-AL": msg`Albanian (Albania)`,
    "sr-RS": msg`Serbian (Serbia)`,
    "su-ID": msg`Sundanese (Indonesia)`,
    "sv-SE": msg`Swedish (Sweden)`,
    "sw-KE": msg`Swahili (Kenya)`,
    "ta-IN": msg`Tamil (India)`,
    "te-IN": msg`Telugu (India)`,
    "th-TH": msg`Thai (Thailand)`,
    "tr-TR": msg`Turkish (Turkey)`,
    "uk-UA": msg`Ukrainian (Ukraine)`,
    "ur-PK": msg`Urdu (Pakistan)`,
    "uz-UZ": msg`Uzbek (Uzbekistan)`,
    "vi-VN": msg`Vietnamese (Vietnam)`,
    "zh-CN": msg`Chinese (Simplified)`,
    "zh-HK": msg`Chinese (Hong Kong)`,
    "zh-TW": msg`Chinese (Traditional)`,
    "zu-ZA": msg`Zulu (South Africa)`,
} as const;

// Language name translations - must be at top level for Lingui extraction
const LANGUAGE_NAMES = {
    af: msg`Afrikaans`,
    ar: msg`Arabic`,
    az: msg`Azerbaijani`,
    be: msg`Belarusian`,
    bg: msg`Bulgarian`,
    bn: msg`Bengali`,
    bs: msg`Bosnian`,
    ca: msg`Catalan`,
    cs: msg`Czech`,
    cy: msg`Welsh`,
    da: msg`Danish`,
    de: msg`German`,
    el: msg`Greek`,
    en: msg`English`,
    es: msg`Spanish`,
    et: msg`Estonian`,
    fa: msg`Persian`,
    fi: msg`Finnish`,
    fr: msg`French`,
    ga: msg`Irish`,
    gl: msg`Galician`,
    gu: msg`Gujarati`,
    he: msg`Hebrew`,
    hi: msg`Hindi`,
    hr: msg`Croatian`,
    hu: msg`Hungarian`,
    hy: msg`Armenian`,
    id: msg`Indonesian`,
    is: msg`Icelandic`,
    it: msg`Italian`,
    ja: msg`Japanese`,
    jv: msg`Javanese`,
    ka: msg`Georgian`,
    kk: msg`Kazakh`,
    km: msg`Khmer`,
    kn: msg`Kannada`,
    ko: msg`Korean`,
    ky: msg`Kyrgyz`,
    lo: msg`Lao`,
    lt: msg`Lithuanian`,
    lv: msg`Latvian`,
    mk: msg`Macedonian`,
    ml: msg`Malayalam`,
    mn: msg`Mongolian`,
    mr: msg`Marathi`,
    ms: msg`Malay`,
    mt: msg`Maltese`,
    my: msg`Myanmar`,
    ne: msg`Nepali`,
    nl: msg`Dutch`,
    no: msg`Norwegian`,
    pa: msg`Punjabi`,
    pl: msg`Polish`,
    ps: msg`Pashto`,
    pt: msg`Portuguese`,
    ro: msg`Romanian`,
    ru: msg`Russian`,
    si: msg`Sinhala`,
    sk: msg`Slovak`,
    sl: msg`Slovenian`,
    sq: msg`Albanian`,
    sr: msg`Serbian`,
    su: msg`Sundanese`,
    sv: msg`Swedish`,
    sw: msg`Swahili`,
    ta: msg`Tamil`,
    te: msg`Telugu`,
    th: msg`Thai`,
    tr: msg`Turkish`,
    uk: msg`Ukrainian`,
    ur: msg`Urdu`,
    uz: msg`Uzbek`,
    vi: msg`Vietnamese`,
    zh: msg`Chinese`,
    zu: msg`Zulu`,
} as const;

// Country name translations - must be at top level for Lingui extraction
const COUNTRY_NAMES = {
    AE: msg`UAE`,
    AL: msg`Albania`,
    AM: msg`Armenia`,
    AR: msg`Argentina`,
    AT: msg`Austria`,
    AU: msg`Australia`,
    AZ: msg`Azerbaijan`,
    BA: msg`Bosnia`,
    BD: msg`Bangladesh`,
    BE: msg`Belgium`,
    BG: msg`Bulgaria`,
    BO: msg`Bolivia`,
    BR: msg`Brazil`,
    BY: msg`Belarus`,
    CA: msg`Canada`,
    CH: msg`Switzerland`,
    CL: msg`Chile`,
    CN: msg`China`,
    CO: msg`Colombia`,
    CR: msg`Costa Rica`,
    CU: msg`Cuba`,
    CZ: msg`Czech Republic`,
    DE: msg`Germany`,
    DK: msg`Denmark`,
    DO: msg`Dominican Republic`,
    EC: msg`Ecuador`,
    EE: msg`Estonia`,
    EG: msg`Egypt`,
    ES: msg`Spain`,
    FI: msg`Finland`,
    FR: msg`France`,
    GB: msg`UK`,
    GE: msg`Georgia`,
    GR: msg`Greece`,
    GT: msg`Guatemala`,
    HK: msg`Hong Kong`,
    HN: msg`Honduras`,
    HR: msg`Croatia`,
    HU: msg`Hungary`,
    ID: msg`Indonesia`,
    IE: msg`Ireland`,
    IL: msg`Israel`,
    IN: msg`India`,
    IR: msg`Iran`,
    IS: msg`Iceland`,
    IT: msg`Italy`,
    JP: msg`Japan`,
    KE: msg`Kenya`,
    KG: msg`Kyrgyzstan`,
    KH: msg`Cambodia`,
    KR: msg`South Korea`,
    KZ: msg`Kazakhstan`,
    LA: msg`Laos`,
    LK: msg`Sri Lanka`,
    LT: msg`Lithuania`,
    LV: msg`Latvia`,
    MK: msg`North Macedonia`,
    MM: msg`Myanmar`,
    MN: msg`Mongolia`,
    MT: msg`Malta`,
    MY: msg`Malaysia`,
    NI: msg`Nicaragua`,
    NL: msg`Netherlands`,
    NO: msg`Norway`,
    NP: msg`Nepal`,
    PA: msg`Panama`,
    PK: msg`Pakistan`,
    PL: msg`Poland`,
    PT: msg`Portugal`,
    PY: msg`Paraguay`,
    RO: msg`Romania`,
    RS: msg`Serbia`,
    RU: msg`Russia`,
    SA: msg`Saudi Arabia`,
    SE: msg`Sweden`,
    SI: msg`Slovenia`,
    SK: msg`Slovakia`,
    SV: msg`El Salvador`,
    TH: msg`Thailand`,
    TR: msg`Turkey`,
    TW: msg`Taiwan`,
    UA: msg`Ukraine`,
    US: msg`US`,
    UY: msg`Uruguay`,
    UZ: msg`Uzbekistan`,
    VE: msg`Venezuela`,
    VN: msg`Vietnam`,
    ZA: msg`South Africa`,
} as const;

/**
 * Gets a readable language name from a BCP 47 code using lingui's t macro.
 * This function must be called within a component that has access to useLingui().
 * @param code BCP 47 language code (e.g., "en-US", "es-ES")
 * @param t The translation function from useLingui() (template literal function)
 * @returns Translated language name
 */
export const getLanguageName = (code: string, t: LinguiT, i18n?: I18n): string => {
    // First, try to get the complete name from the full language code map
    const fullNameDescriptor = LANGUAGE_VARIANT_NAMES[code as keyof typeof LANGUAGE_VARIANT_NAMES];

    if (fullNameDescriptor && i18n) {
        return i18n._(fullNameDescriptor);
    }

    // Fallback: construct from language and country maps
    const [lang, country] = code.split("-", 2);

    if (!lang) {
        return code;
    }

    // Get language name from map
    const langDescriptor = LANGUAGE_NAMES[lang as keyof typeof LANGUAGE_NAMES];
    const langName = langDescriptor && i18n ? i18n._(langDescriptor) : lang;

    if (!country) {
        return langName;
    }

    // Get country name from map
    const countryDescriptor = COUNTRY_NAMES[country as keyof typeof COUNTRY_NAMES];
    const countryName = countryDescriptor && i18n ? i18n._(countryDescriptor) : null;

    return countryName ? t`${langName} (${countryName})` : langName;
};

/**
 * Maps a navigator language code to a full BCP 47 code.
 * Handles cases like "de" -> "de-DE", "en" -> "en-US", etc.
 * @param navigatorLang The language code from navigator.language (e.g., "de", "en", "de-DE")
 * @returns A full BCP 47 code that exists in LANGUAGE_CODES, or "en-US" as fallback
 */
export const mapNavigatorLanguage = (navigatorLang: string): string => {
    // If it's already a full BCP 47 code, check if it exists in our list
    if (LANGUAGE_CODES.includes(navigatorLang as (typeof LANGUAGE_CODES)[number])) {
        return navigatorLang;
    }

    // Map common language codes to their default country variants
    const languageToCountry: Record<string, string> = {
        af: "af-ZA",
        ar: "ar-SA",
        az: "az-AZ",
        be: "be-BY",
        bg: "bg-BG",
        bn: "bn-BD",
        bs: "bs-BA",
        ca: "ca-ES",
        cs: "cs-CZ",
        cy: "cy-GB",
        da: "da-DK",
        de: "de-DE",
        el: "el-GR",
        en: "en-US",
        es: "es-ES",
        et: "et-EE",
        fa: "fa-IR",
        fi: "fi-FI",
        fr: "fr-FR",
        ga: "ga-IE",
        gl: "gl-ES",
        gu: "gu-IN",
        he: "he-IL",
        hi: "hi-IN",
        hr: "hr-HR",
        hu: "hu-HU",
        hy: "hy-AM",
        id: "id-ID",
        is: "is-IS",
        it: "it-IT",
        ja: "ja-JP",
        jv: "jv-ID",
        ka: "ka-GE",
        kk: "kk-KZ",
        km: "km-KH",
        kn: "kn-IN",
        ko: "ko-KR",
        ky: "ky-KG",
        lo: "lo-LA",
        lt: "lt-LT",
        lv: "lv-LV",
        mk: "mk-MK",
        ml: "ml-IN",
        mn: "mn-MN",
        mr: "mr-IN",
        ms: "ms-MY",
        mt: "mt-MT",
        my: "my-MM",
        ne: "ne-NP",
        nl: "nl-NL",
        no: "no-NO",
        pa: "pa-IN",
        pl: "pl-PL",
        ps: "ps-AF",
        pt: "pt-PT",
        ro: "ro-RO",
        ru: "ru-RU",
        si: "si-LK",
        sk: "sk-SK",
        sl: "sl-SI",
        sq: "sq-AL",
        sr: "sr-RS",
        su: "su-ID",
        sv: "sv-SE",
        sw: "sw-KE",
        ta: "ta-IN",
        te: "te-IN",
        th: "th-TH",
        tr: "tr-TR",
        uk: "uk-UA",
        ur: "ur-PK",
        uz: "uz-UZ",
        vi: "vi-VN",
        zh: "zh-CN",
        zu: "zu-ZA",
    };

    // Extract just the language code (before the hyphen)
    const langCode = navigatorLang.split("-", 1)[0]?.toLowerCase();
    const mappedCode = langCode ? languageToCountry[langCode] : undefined;

    // Return mapped code if it exists in our list, otherwise fallback to en-US
    if (mappedCode && LANGUAGE_CODES.includes(mappedCode as (typeof LANGUAGE_CODES)[number])) {
        return mappedCode;
    }

    return "en-US";
};

/**
 * Creates a list of languages with translated labels.
 * @param i18n The i18n instance from useLingui()
 * @param t The translation function from useLingui() (template literal function)
 * @returns Array of language objects with code and label
 */
export const createLanguageList = (i18n: I18n, t: LinguiT): { label: string; value: string }[] =>
    LANGUAGE_CODES.map((code) => {
        return {
            label: getLanguageName(code, t, i18n),
            value: code,
        };
    });
