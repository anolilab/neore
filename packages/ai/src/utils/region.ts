/**
 * List of EU/EEA/GDPR countries (ISO 3166-1 alpha-2 codes)
 */
const GDPR_COUNTRIES = new Set([
    // UK territories
    "AI", // Anguilla
    // EU Member States
    "AT", // Austria
    // Dutch territories
    "AW", // Aruba
    // Finnish territories
    "AX", // Aland Islands
    "BE", // Belgium
    "BG", // Bulgaria
    "BL", // Saint Barthelemy
    "BM", // Bermuda
    // Other GDPR-compliant territories
    "CH", // Switzerland
    "CW", // Curacao
    "CY", // Cyprus
    "CZ", // Czech Republic
    "DE", // Germany
    "DK", // Denmark
    "EE", // Estonia
    "EL", // Greece (alternative code)
    "ES", // Spain
    "FI", // Finland
    "FK", // Falkland Islands
    // Danish territories
    "FO", // Faroe Islands
    "FR", // France
    "GB", // United Kingdom
    "GF", // French Guiana
    "GG", // Guernsey
    "GI", // Gibraltar
    "GL", // Greenland
    "GP", // Guadeloupe
    "GR", // Greece
    "HR", // Croatia
    "HU", // Hungary
    "IE", // Ireland
    "IM", // Isle of Man
    "IO", // British Indian Ocean Territory
    // EEA Countries (non-EU)
    "IS", // Iceland
    "IT", // Italy
    "JE", // Jersey
    "KY", // Cayman Islands
    "LI", // Liechtenstein
    "LT", // Lithuania
    "LU", // Luxembourg
    "LV", // Latvia
    "MF", // Saint Martin
    "MQ", // Martinique
    "MS", // Montserrat
    "MT", // Malta
    "NC", // New Caledonia
    "NL", // Netherlands
    "NO", // Norway
    "PF", // French Polynesia
    "PL", // Poland
    "PM", // Saint Pierre and Miquelon
    "PN", // Pitcairn, Henderson, Ducie and Oeno Islands
    "PT", // Portugal
    // French territories
    "RE", // Reunion
    "RO", // Romania
    "SE", // Sweden
    "SH", // Saint Helena, Ascension and Tristan da Cunha
    "SI", // Slovenia
    "SK", // Slovakia
    "SX", // Sint Maarten
    "TC", // Turks and Caicos Islands
    "UK", // United Kingdom (alternative code)
    "VG", // British Virgin Islands
    "WF", // Wallis and Futuna
    "YT", // Mayotte
]);

/**
 * Check if a country code is in the EU/GDPR region.
 * @param countryCode ISO 3166-1 alpha-2 country code (e.g., "US", "DE", "FR")
 * @returns True if the country is in the EU/GDPR region
 */
export const isEURegion = (countryCode: string | null | undefined): boolean => {
    if (!countryCode) {
        return false;
    }

    return GDPR_COUNTRIES.has(countryCode.toUpperCase());
};

/**
 * Extract region/country code from HTTP headers
 * Supports common headers used by CDNs and edge providers.
 * @param headers HTTP headers object
 * @returns Country code or null if not found
 */
export const getRegionFromHeaders = (headers: Record<string, string | undefined>): string | null => {
    // Check various common headers (case-insensitive)
    const countryHeaders = [
        "cf-ipcountry", // Cloudflare
        "x-vercel-ip-country", // Vercel
        "x-country-code", // Generic
        "cloudfront-viewer-country", // AWS CloudFront
        "x-appengine-country", // Google App Engine
    ];

    for (const header of countryHeaders) {
        const value = headers[header] ?? headers[header.toLowerCase()];

        if (value && typeof value === "string" && value.length === 2) {
            return value.toUpperCase();
        }
    }

    return null;
};

/**
 * Check if request headers indicate EU/GDPR region.
 * @param headers HTTP headers object
 * @returns True if the request is from EU/GDPR region
 */
export const isEURequest = (headers: Record<string, string | undefined>): boolean => {
    const countryCode = getRegionFromHeaders(headers);

    return isEURegion(countryCode);
};
