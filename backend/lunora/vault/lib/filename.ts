// Filename validation & sanitization utilities

const MAX_FILENAME_LENGTH = 200; // Reasonable UI-friendly cap while keeping extension
const INVALID_FILENAME_PUNCT = /[<>:"/\\|?*]/g; // Reserved punctuation
const WHITESPACE_RE = /\s+/g;
const JUST_DOTS_RE = /^\.+$/;

const RESERVED_BASENAMES = new Set([
    "aux",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "con",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
    "nul",
    "prn",
]);

/**
 * Strip trailing spaces and dots — Windows treats a name ending in either as the
 * name without them, so `report.` and `report` collide.
 *
 * A scan rather than `/[ .]+$/g`: an anchored `+` backtracks from every position
 * on a long run that does not reach the end, which is quadratic on a filename an
 * uploader chooses. This is one pass.
 */
const stripTrailingSpacesAndDots = (value: string): string => {
    let end = value.length;

    while (end > 0) {
        const c = value[end - 1];

        if (c !== " " && c !== ".") {
            break;
        }

        end -= 1;
    }

    return end === value.length ? value : value.slice(0, end);
};

const stripControlChars = (s: string): string => {
    let out = "";

    for (const ch of s) {
        const code = ch.codePointAt(0) ?? 0;

        if (code >= 32 && code !== 127) {
            out += ch;
        }
    }

    return out;
};

const sanitizeAndValidateFileName = (input: string): string => {
    // Normalize and trim
    const normalized = (input ?? "").normalize("NFKC").trim();
    // Remove control chars and forbidden punctuation
    const noCtrl = stripControlChars(normalized);
    const cleaned = noCtrl.replaceAll(INVALID_FILENAME_PUNCT, "_").replaceAll(WHITESPACE_RE, " ");
    // Disallow names that are just dots or empty after cleaning
    let candidate = cleaned.replace(JUST_DOTS_RE, "").trim();

    if (candidate.length === 0) {
        candidate = "file";
    }

    // Split base and extension (preserve last extension if present)
    const lastDot = candidate.lastIndexOf(".");
    const hasExtension = lastDot > 0 && lastDot < candidate.length - 1; // dot not first/last
    const base = (hasExtension ? candidate.slice(0, lastDot) : candidate).trim();
    const extension = hasExtension ? candidate.slice(lastDot + 1).trim() : "";

    // Trim trailing dots/spaces from base and ext FIRST
    let safeBase = stripTrailingSpacesAndDots(base);
    const safeExtension = stripTrailingSpacesAndDots(extension);

    // If trimming yields empty string, set to 'file' before reserved-name check
    if (safeBase.length === 0) {
        safeBase = "file";
    }

    // Now check reserved names on the TRIMMED base (case-insensitive)
    const baseLower = safeBase.toLowerCase();

    if (RESERVED_BASENAMES.has(baseLower)) {
        safeBase += "-file";
    }

    // Enforce max length while keeping extension if possible
    const extensionWithDot = safeExtension ? `.${safeExtension}` : "";
    const maxBaseLength = Math.max(1, MAX_FILENAME_LENGTH - extensionWithDot.length);

    if (safeBase.length > maxBaseLength) {
        safeBase = safeBase.slice(0, maxBaseLength);
        // If we sliced to whitespace, collapse
        safeBase = safeBase.trim();

        if (safeBase.length === 0) {
            safeBase = "file";
        }
    }

    // Reassemble
    const result = `${safeBase}${extensionWithDot}`;

    // Final guard against empty/oversized
    if (result.length === 0) {
        return "file";
    }

    if (result.length > MAX_FILENAME_LENGTH) {
        return result.slice(0, MAX_FILENAME_LENGTH);
    }

    return result;
};

export default sanitizeAndValidateFileName;
