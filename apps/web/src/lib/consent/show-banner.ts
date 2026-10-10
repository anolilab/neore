// @ts-ignore - @c15t/backend may not be installed as a direct dependency
import type { ContractsOutputs } from "@c15t/backend";
import { baseTranslations } from "@c15t/translations/all";

export type SupportedLanguage = keyof typeof baseTranslations;
type JurisdictionCode = ContractsOutputs["showConsentBanner"]["jurisdiction"]["code"];

export const JurisdictionMessages: Record<JurisdictionCode, string> = {
    APPI: "Japan's APPI requires consent for data collection.",
    AU: "Australia's Privacy Act mandates transparency about data collection.",
    BR: "Brazil's LGPD requires consent for cookies.",
    CH: "Switzerland requires similar data protection measures.",
    GDPR: "GDPR or equivalent regulations require a cookie banner.",
    NONE: "No specific requirements",
    PIPA: "South Korea's PIPA requires consent for data collection.",
    PIPEDA: "PIPEDA requires consent for data collection.",
} as const;

const JURISDICTION_MAPPINGS = new Map<string, JurisdictionCode>([
    // GDPR countries (EU + EEA + UK)
    ...[
        "AT",
        "BE",
        "BG",
        "HR",
        "CY",
        "CZ",
        "DK",
        "EE",
        "FI",
        "FR",
        "DE",
        "GR",
        "HU",
        "IE",
        "IT",
        "LV",
        "LT",
        "LU",
        "MT",
        "NL",
        "PL",
        "PT",
        "RO",
        "SK",
        "SI",
        "ES",
        "SE",
        "IS",
        "NO",
        "LI",
        "GB",
    ].map((country): [string, JurisdictionCode] => [country, "GDPR"]),
    // Other jurisdictions
    ["CH", "CH"],
    ["BR", "BR"],
    ["CA", "PIPEDA"],
    ["AU", "AU"],
    ["JP", "APPI"],
    ["KR", "PIPA"],
] as [string, JurisdictionCode][]);

const COUNTRY_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "x-amz-cf-ipcountry", "x-country-code"] as const;

const REGION_HEADERS = ["x-vercel-ip-country-region", "x-region-code"] as const;

const extractCountryCode = (headers: Record<string, string>): string | null => {
    for (const headerName of COUNTRY_HEADERS) {
        const value = headers[headerName];

        if (value) {
            return value.toUpperCase(); // Normalize to uppercase for consistent lookup
        }
    }

    return null;
};

const extractRegionCode = (headers: Record<string, string>): string | null => {
    for (const headerName of REGION_HEADERS) {
        const value = headers[headerName];

        if (value) {
            return value;
        }
    }

    return null;
};

const getPreferredLanguage = (acceptLanguage: string | null): SupportedLanguage => {
    if (!acceptLanguage) {
        return "en";
    }

    const primaryLang = acceptLanguage.split(",", 1)[0]?.split(";", 1)[0]?.split("-", 1)[0]?.toLowerCase();

    if (primaryLang && Object.hasOwn(baseTranslations, primaryLang)) {
        return primaryLang as SupportedLanguage;
    }

    return "en";
};

export const checkJurisdiction = (countryCode: string | null) => {
    // Early return for no country code (e.g. localhost)
    if (!countryCode) {
        return {
            jurisdictionCode: "NONE" as JurisdictionCode,
            message: JurisdictionMessages.NONE,
            showConsentBanner: true,
        };
    }

    const normalizedCountryCode = countryCode.toUpperCase();
    const jurisdictionCode = JURISDICTION_MAPPINGS.get(normalizedCountryCode);

    if (jurisdictionCode) {
        return {
            jurisdictionCode,
            message: JurisdictionMessages[jurisdictionCode],
            showConsentBanner: true,
        };
    }

    // Country not in any jurisdiction - don't show banner
    return {
        jurisdictionCode: "NONE" as JurisdictionCode,
        message: JurisdictionMessages.NONE,
        showConsentBanner: false,
    };
};

export const showBanner = (headers: Record<string, string>): ContractsOutputs["consent"]["showBanner"] => {
    const countryCode = extractCountryCode(headers);
    const regionCode = extractRegionCode(headers);

    const acceptLanguage = headers["accept-language"] || null;
    const preferredLanguage = getPreferredLanguage(acceptLanguage);

    const { jurisdictionCode, message, showConsentBanner } = checkJurisdiction(countryCode);

    return {
        jurisdiction: {
            code: jurisdictionCode,
            message,
        },
        location: {
            countryCode,
            regionCode,
        },
        showConsentBanner,
        translations: {
            language: preferredLanguage,
            translations: baseTranslations[preferredLanguage],
        },
    };
};
