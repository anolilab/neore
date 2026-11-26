/**
 * The one secret detector for text the backend keeps or passes on: provider keys and tokens, JWTs, `Bearer` credentials,
 * private key blocks, `password:` / `token=` style values and long high-entropy strings are replaced with `REDACTED`.
 *
 * It errs towards keeping text: ordinary words, dates, numbers, UUIDs, commit hashes and code identifiers stay, and a
 * secret that looks like none of these shapes passes. It is a guard behind the prompt that asks models not to keep
 * secrets, not a replacement for it.
 */

export const REDACTED = "«redacted»";

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu;

/** Prefixed provider credentials. Each needs a long enough body that a word such as `sk-8` or `ghost_town` is safe. */
const PROVIDER_TOKENS = [
    /(?<![\w-])sk-(?=[\w-]{0,256}\d)[\w-]{20,}/gu, // OpenAI / Anthropic style (`sk-…`, `sk-proj-…`, `sk-ant-…`)
    /\b[prs]k_(?:live|test)_[\dA-Za-z]{10,}/gu, // Stripe
    /\bgh[oprsu]_[\dA-Za-z]{20,}/gu, // GitHub tokens
    /\bgithub_pat_\w{20,}/gu,
    /\bglpat-[\w-]{20,}/gu, // GitLab
    /\bxox[abeposr]-[\dA-Za-z-]{10,}/gu, // Slack
    /\b(?:AKIA|ASIA)[\dA-Z]{16}\b/gu, // AWS access key id
    /\bAIza[\w-]{35}/gu, // Google API key
    /\bhf_[\dA-Za-z]{30,}/gu, // Hugging Face
    /\bnpm_[\dA-Za-z]{36}/gu,
    /(?<![\w-])eyJ[\w-]{8,4096}\.[\w-]{8,4096}\.[\w-]{8,}/gu, // JWT; one start per run, so `eyJ-eyJ-…` stays linear
    /\bhttps:\/\/hooks\.slack\.com\/(?:services|triggers|workflows)\/[\w/-]+/gu, // a webhook URL is its own credential
    /\bhttps:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/[\w/-]+/gu,
];

/**
 * `Bearer …` / `Basic …` outside an `Authorization:` header (inside one, `ASSIGNED_SECRET` takes any value). A Bearer
 * value needs a digit or a base64 symbol, or mixed-case letters that read as random; a Basic value of 12 characters or
 * more needs a digit or a symbol, and any Basic value may decode to a user name and password joined by a colon
 * (`dXNlcjox` is `user:1`). So "basic understanding", "basic math" and "bearer bonds" stay.
 */
const BEARER = /\b(?<scheme>bearer)\s+(?<value>[\w.~+/=-]{8,})/giu;
const BASIC = /\b(?<scheme>basic)\s+(?<value>[\d+/a-z]{4,}={0,2})(?![\w-])/giu;
const MIN_SYMBOL_BASIC = 12;
const BASE64_SYMBOL = /[\d+/=]/u;
const MIN_LETTER_ONLY_BEARER = 16;
const LOWER = /[a-z]/u;
const UPPER = /[A-Z]/u;
/** What a Basic value decodes to: printable `user:password`. */
const BASIC_PAIR = /^[\u{21}-\u{39}\u{3B}-\u{7E}]+:[\u{20}-\u{7E}]+$/u;

/** A name that ends in a secret's word (`DB_PASSWORD`, `client-secret`), not one that only contains it (`max_tokens`, `passwordless`). */
const PASSWORD_NAME = String.raw`[\w-]{0,40}?(?:passw(?:or)?d|passphrase|pwd)`;

export const SECRET_NAME = String.raw`[\w-]{0,40}?(?:passw(?:or)?d|passphrase|secret|token|(?:api|access|private|secret)[_-]?key|authorization|credentials?)`;
/**
 * A quoted value of at least `min` characters. A backslash escapes the next character, so `"prefix\"rest"` is one value.
 * On one line it may be of any length: its scan stops at the next quote, and every value starts at one, so the scans
 * never overlap. A double-quoted value may span lines (`"alpha\nbeta"`, up to 1000 characters) when it holds no space
 * and its closing quote ends a word: after `"abc` and a line break, `User likes "green" tea` or `User buys 27" monitors`
 * is a new line of prose, not the value. A single-quoted one never spans lines: in prose `'` is mostly an apostrophe
 * ("rock 'n' roll").
 */
const quotedValue = (min: 0 | 1): string =>
    String.raw`"(?:[^"\\\s]|\\\S|\r?\n){${min},1000}"(?![^\s,.;:)\]}])|"(?:[^"\\\n]|\\.){${min},}"|'(?:[^'\\\n]|\\.){${min},}'`;
const QUOTED_OR_WORD = String.raw`${quotedValue(0)}|(?:(?:bearer|basic)\s+)?\S+`;

/** A character of an unquoted value: a `.`, `,` or `;` ends it only before a space or the end, so `blue.Orange42` is one. */
const IN_VALUE = String.raw`(?:[^\n.,;]|[.,;](?=\S))`;

/**
 * The gap after an `=`: spaces, and at most one line break before a value that is not the next setting. After an empty
 * `DB_PASSWORD=`, `DB_HOST=localhost` on the next line is not its value; a value found there must look like a
 * credential (`isNextLineValue`), so prose on the next line is not either.
 */
const ASSIGNMENT_GAP = String.raw`[^\S\n]*(?:\r?\n[^\S\n]*(?![\w.-]+=))?`;

/** An assigned value: quoted, or to the end of its clause or the next `NAME=`, joining words and all. */
const ASSIGNED_VALUE = String.raw`(?<value>${quotedValue(0)}|[^\s"'](?:(?!\s[\w.-]+=)${IN_VALUE})*)`;

/**
 * A password assigned with `=`: `DB_PASSWORD=correct horse`, `WIFI_PASSWORD=walk to the park`. An assignment gives a
 * value, never a description, so it runs to the end of its clause (or the next `NAME=`), joining words and all.
 */
const PASSWORD_ASSIGNMENT = new RegExp(String.raw`(?<name>\b${PASSWORD_NAME}["']?[^\S\n]*=${ASSIGNMENT_GAP})${ASSIGNED_VALUE}`, "giu");

/** A password's word as code spells it: `password`, `Password`, `PASSWORD`, and the same for `passwd`, `passphrase`, `pwd`. */
const PASSWORD_WORD = "[Pp]ass(?:w(?:or)?d|phrase)|PASS(?:W(?:OR)?D|PHRASE)|[Pp]wd|PWD";
const PASSWORD_WORD_CAPITAL = "Pass(?:w(?:or)?d|phrase)|PASS(?:W(?:OR)?D|PHRASE)|Pwd|PWD";

/**
 * A password after `:` and a name written as code: `db_password: correct horse`, `wifiPassword: walk to the park`,
 * `"password": correct horse`. Like `=`, the value runs to the end of its clause, unless it describes the password
 * (`db_password: stored in the vault`). Case-sensitive, so a plain `Password:` label is left to `PASSWORD_VALUE`,
 * where the value may describe ("Password: case sensitive").
 */
const CODE_PASSWORD_LABEL = new RegExp(
    String.raw`(?<name>(?:\b\w{0,40}?_(?:${PASSWORD_WORD})|\b\w{0,40}?[\da-z](?:${PASSWORD_WORD_CAPITAL})|\b\w{0,40}?(?:${PASSWORD_WORD})["'])\s*:\s*)${ASSIGNED_VALUE}`,
    "gu",
);

/**
 * A password stated in prose or after a colon: `my password is correct horse battery staple!`, `password: hunter`. The
 * value may be several words, so it runs to the end of its clause: a `.`, `,` or `;` before a space, a line end, a
 * joining word such as "and", or a preposition such as "to" (captured: "hard to remember" describes, it does not give).
 * A value with no such end within 121 characters runs to the end of its clause, so a long one never leaves a tail.
 * `isPasswordValue` keeps the ones that describe the password instead of giving it.
 */
const PASSWORD_VALUE = new RegExp(
    String.raw`(?<name>\b${PASSWORD_NAME}(?<separator>\s+(?:is|was)\s+|["']?\s*:\s*))(?<value>${quotedValue(1)}|[^\s"']${IN_VALUE}{0,120}?(?=[.,;]?\s*$|[.,;]\s|\s*\n|\s+(?:and|but|so|because|which)\s|\s+(?<preposition>for|on|at|in|to|from|with)\s)|[^\s"']${IN_VALUE}{120,})`,
    "giu",
);

/** Only a text that names a password takes the password passes: their name scan is the slowest step on a long text. */
const PASSWORD_HINT = /passw|passphrase|pwd/iu;

/** A setting's literal, not a password: `requireStrongPassword=false`, `ALLOW_EMPTY_PASSWORD=yes on the test box`. */
const SETTING_LITERALS = new Set(["disabled", "enabled", "false", "nil", "no", "none", "null", "off", "on", "true", "undefined", "yes"]);
/** Words that start a new clause after a setting's literal, so what follows describes it instead of continuing the value. */
const CLAUSE_STARTS = new Set(["and", "at", "because", "but", "for", "from", "in", "on", "per", "since", "so", "to", "until", "when", "with"]);
/** Units and qualifiers of a length: "16 characters long", `password: 12 digits minimum`. */
const COUNT_UNITS = /^(?:characters?|chars?|digits?|letters?|symbols?|words?)$/iu;
const COUNT_QUALIFIERS = new Set(["long", "longer", "max", "maximum", "min", "minimum", "more", "or"]);
const COUNT_NUMBER = /^\d{1,3}\+?$/u;
const WORD_SPLIT = /\s+/u;

const isSettingLiteral = (value: string): boolean => SETTING_LITERALS.has(value.toLowerCase());

/** A setting's literal alone, or followed by a clause that starts with a preposition or joining word. */
const isSetting = (value: string): boolean => {
    const [first = "", second] = value.trim().split(WORD_SPLIT, 2);

    return isSettingLiteral(first) && (second === undefined || CLAUSE_STARTS.has(second.toLowerCase()));
};

/** A length, not a password: a number, a unit, then at most "long", "minimum" or "or more". */
const isCount = (value: string): boolean => {
    // At most a number, a unit and two qualifiers: a fifth word means more than a length.
    const words = value.trim().split(WORD_SPLIT, 5);
    const [number = "", unit = "", ...rest] = words;

    return words.length <= 4 && COUNT_NUMBER.test(number) && COUNT_UNITS.test(unit) && rest.every((word) => COUNT_QUALIFIERS.has(word.toLowerCase()));
};

/** The rest of the clause after a one-word value: `password: 12` + ` characters minimum`. */
const CLAUSE_TAIL = /^[^\n.,;]{0,40}/u;

/**
 * First words that describe a password rather than give it: "my password is expired", "the password is in the vault",
 * "Password: forgotten often", `requireStrongPassword: false`. So is a letter-only word ending in -ed ("my password was
 * hacked"), and one ending in -ing or -ly when more words follow it ("changing weekly"); alone, an -ing or -ly word is
 * a describing word only when it is listed here, so "my password is butterfly" gives one and "is expiring" does not.
 */
const DESCRIBING_WORDS = new Set([
    "a",
    "about",
    "also",
    "always",
    "amazing",
    "an",
    "annoying",
    "any",
    "at",
    "bad",
    "being",
    "blank",
    "boring",
    "changing",
    "complex",
    "confusing",
    "costly",
    "daily",
    "easy",
    "empty",
    "expiring",
    "failing",
    "false",
    "fine",
    "for",
    "forgotten",
    "friendly",
    "from",
    "frustrating",
    "good",
    "hard",
    "her",
    "hidden",
    "his",
    "hourly",
    "important",
    "in",
    "interesting",
    "invalid",
    "its",
    "just",
    "known",
    "likely",
    "loading",
    "long",
    "lost",
    "lovely",
    "missing",
    "monthly",
    "my",
    "never",
    "new",
    "nightly",
    "nil",
    "no",
    "none",
    "not",
    "now",
    "null",
    "off",
    "ok",
    "okay",
    "old",
    "on",
    "only",
    "optional",
    "our",
    "pending",
    "quarterly",
    "random",
    "renewing",
    "reset",
    "resetting",
    "rotating",
    "same",
    "secure",
    "set",
    "short",
    "silly",
    "simple",
    "still",
    "strong",
    "syncing",
    "temporary",
    "the",
    "their",
    "this",
    "too",
    "true",
    "ugly",
    "unique",
    "unknown",
    "unlikely",
    "valid",
    "very",
    "weak",
    "weekly",
    "what",
    "working",
    "wrong",
    "yearly",
    "yes",
    "your",
]);
const PARTICIPLE = /^\p{L}+ed$/u;
const DESCRIBING_SUFFIX = /^\p{L}+(?:ing|ly)$/u;

/**
 * `password: hunter2`, `API_KEY=…`, `"token": "…"`. The name and separator stay; the value goes. After a colon an
 * unquoted value must look like a credential or follow `Authorization: Bearer`, so "Password: forgotten often" stays.
 * After `=`, a value on the next line is one only as `ASSIGNMENT_GAP` allows.
 */
const ASSIGNED_SECRET = new RegExp(
    String.raw`(?<name>\b${SECRET_NAME}["']?\s*(?<separator>[:=])(?:(?<=:)\s*|${ASSIGNMENT_GAP}))(?<value>${QUOTED_OR_WORD})`,
    "giu",
);
const QUOTED = /^["']/u;
const SCHEME = /^(?:bearer|basic)\s/iu;

/**
 * `the API secret is s3cret!`: in prose the value must look like a credential (a digit or a symbol, six characters or
 * more), so "the secret is patience" stays.
 */
const STATED_SECRET = new RegExp(String.raw`(?<name>\b${SECRET_NAME}\s+(?:is|was)\s+)(?<value>["']?[^\s"']{6,}["']?)`, "giu");
const CREDENTIAL_SYMBOL = /[\d!#$%&*+/=?@^_~-]/u;
/** A hyphen or underscore between letters joins words (`low-and-slow`, `self_taught`); it says nothing about a credential. */
const WORD_JOINER = /(?<=\p{L})[_-](?=\p{L})/gu;
/** A value that is only the marker (a sentence's closing punctuation aside): `password: «redacted».` stays as it is. */
const ALREADY_REDACTED = new RegExp(String.raw`^(?:(?:bearer|basic)\s+)?${REDACTED}[.,;:!?)]*$`, "iu");

const looksLikeCredential = (value: string): boolean => CREDENTIAL_SYMBOL.test(value.replaceAll(WORD_JOINER, ""));

/** A value on the line after `=` is one word of at least this length: a list's `-` or a sentence there is no value. */
const MIN_NEXT_LINE_VALUE = 6;
const SPACE = /\s/u;

/**
 * Whether a value found after `=` (its `name` holds the gap) may be the value: on the next line, only one quoted, or
 * one word that looks like a credential, so "User is 42 years old" there stays.
 */
const isNextLineValue = (name: string, value: string): boolean =>
    !name.includes("\n") || QUOTED.test(value) || (value.length >= MIN_NEXT_LINE_VALUE && !SPACE.test(value) && looksLikeCredential(value));

/**
 * A label that names a design token: `design token:`, `The brand token is`, `"color-token":`. A design word must come
 * first, so `API token: summer-2024` and `access_token=letmein-2024` are still credentials.
 */
const DESIGN_WORDS = new Set(["brand", "color", "colour", "css", "design", "font", "radius", "shadow", "size", "spacing", "style", "theme", "typography"]);
/**
 * A design token's value, which no credential looks like: a scale step (`blue-600`, `--spacing-4`, `$gray-50`), a hex
 * colour (`#1e40af`) or a CSS length (`16px`, `1.5rem`).
 */
const DESIGN_SCALE_STEP = /^(?:--|\$)?[a-z]+(?:-[a-z]+)*-\d{1,4}(?:\.\d)?$/iu;
const DESIGN_HEX_COLOUR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu;
const DESIGN_LENGTH = /^\d{1,4}(?:\.\d{1,3})?(?:px|r?em|pt|%|v[hw]|m?s)$/iu;
/** A value's quotes and a sentence's closing punctuation. */
const VALUE_WRAPPING = /^["']|["']?[.,;:!?)]{0,4}$/gu;

const isDesignValue = (value: string): boolean => {
    const bare = value.replaceAll(VALUE_WRAPPING, "");

    return DESIGN_SCALE_STEP.test(bare) || DESIGN_HEX_COLOUR.test(bare) || DESIGN_LENGTH.test(bare);
};

const DESIGN_LABEL_REACH = 40;

/** What may follow a label's `token`, its quote aside: the separator, or "is" / "was". */
const AFTER_TOKEN = new Set(["", ":", "=", "is", "was"]);
const LEADING_QUOTE = /^["']/u;
const WORD_GAP = new Set([" ", "-", "_"]);
const MAX_WORD_GAP = 3;
const LETTER_ONLY = /\p{L}/u;

/**
 * Whether the match at `offset` (its label `name`, the text before it in `whole`) gives a design token's value: the
 * label ends in `token`, and the word joined to it by a space, `-` or `_` is a design word (`brand token is`,
 * `color-token:`). `brand_token_api_key=` or `color.⏎token:` is no design label.
 */
const isDesignToken = (whole: string, offset: number, name: string, value: string): boolean => {
    const at = name.toLowerCase().lastIndexOf("token");

    if (
        at === -1 ||
        !AFTER_TOKEN.has(
            name
                .slice(at + "token".length)
                .replace(LEADING_QUOTE, "")
                .trim()
                .toLowerCase(),
        ) ||
        !isDesignValue(value)
    ) {
        return false;
    }

    const before = `${whole.slice(Math.max(0, offset - DESIGN_LABEL_REACH), offset)}${name.slice(0, at)}`;
    let end = before.length;

    while (end > 0 && before.length - end < MAX_WORD_GAP && WORD_GAP.has(before[end - 1] ?? "")) {
        end -= 1;
    }

    let start = end;

    while (start > 0 && LETTER_ONLY.test(before[start - 1] ?? "")) {
        start -= 1;
    }

    return end < before.length && DESIGN_WORDS.has(before.slice(start, end).toLowerCase());
};

/**
 * A URL's random-looking path segments and values go one by one; outside URLs, a run is a candidate. Long enough for
 * `sid=` and a 20-character value; `redactRandomRun` holds a run without a `name=` to 32 characters.
 */
const URL_OR_CANDIDATE = /\bhttps?:\/\/\S+|(?<![\w+/=-])[\w+/=-]{22,}(?![\w+/=-])/gu;
const URL_PART = /[\w+=-]{22,}/gu;
/** Each `=`-separated part of a run (base64 padding only at its end): `session_id=<random>` is one run whose name keeps the whole from reading as random. */
const RUN_VALUE = /(?:^|(?<==))[\w+/-]{20,}(?:={1,2}$)?/gu;
const MIN_RUN_CANDIDATE = 32;
/** A `name=` inside a run, not base64 padding: an `=` with a character before it and a value after it. */
const NAMED_VALUE = /[^=]=[^=]/u;
/** A value's base64 padding, which is no `=` between a name and its value. */
const BASE64_PADDING = /={1,2}$/u;
/**
 * A value under 32 characters counts with at most two `-` / `_` in it: a URL-safe id (a nanoid) has
 * one or two, a code such as `sku=ABC-123-DEF-456-GHI-789-J` has them between every group.
 */
const VALUE_SEPARATOR = /[_-]/gu;
const MAX_SHORT_VALUE_SEPARATORS = 2;
const HEX_LIKE = /^[\da-f-]+$/iu;
const DIGIT = /\d/gu;
const LETTER = /[a-z]/iu;

/**
 * An AWS secret access key: 40 base64 characters, mixed case, with a digit or a `+` / `/`. Its `/` makes it read as a
 * path, so its case must switch more often than a camelCase path's does (`components/ChatPanel/MessageListItemView`
 * runs about 2.7 characters per case, a random key under 2.25 in 99 of 100).
 */
const AWS_SECRET_KEY = /^[\dA-Za-z+/]{40}$/u;
const AWS_SECRET_MARK = /[\d+/]/u;
const MAX_AWS_CLASS_RUN = 2.25;

const MIN_HEX_SECRET = 48;
const MIN_PATH_SEGMENT = 20;
const MIN_ENTROPY_BITS = 3.5;
const MIN_DIGITS = 2;
/** Three or more lowercase letters, a capital, then two or more lowercase: a camelCase word, as an identifier has (`shouldRender`). */
const CAMEL_WORD = /(?<=[a-z]{3})[A-Z][a-z]{2}/u;
const MAX_MEAN_CLASS_RUN = 3;

const shannonEntropy = (value: string): number => {
    const counts = new Map<string, number>();

    for (const char of value) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
    }

    let bits = 0;

    for (const count of counts.values()) {
        const p = count / value.length;

        bits -= p * Math.log2(p);
    }

    return bits;
};

const CHARACTER_CLASS = (char: string): "digit" | "lower" | "upper" => {
    if (char >= "0" && char <= "9") {
        return "digit";
    }

    return char === char.toLowerCase() ? "lower" : "upper";
};

/**
 * The mean length of the runs of one character class (lower case, upper case, digit) among the letters and digits:
 * under 2 in a random key, 4 or more in a name like `ReleaseNotesDashboard2024` whose words are long lower-case runs.
 */
const meanClassRun = (value: string): number => {
    const alphanumeric = value.replaceAll(/[^\dA-Za-z]/gu, "");
    let runs = 0;
    let previous: string | undefined;

    for (const char of alphanumeric) {
        const kind = CHARACTER_CLASS(char);

        if (kind !== previous) {
            runs += 1;
            previous = kind;
        }
    }

    return runs === 0 ? Infinity : alphanumeric.length / runs;
};

/**
 * A 32+ character run that reads as random. Hex (UUIDs, a commit hash) needs 48 characters; a path whose every segment
 * is short is a path.
 */
export const looksLikeRandomSecret = (value: string): boolean => {
    if (HEX_LIKE.test(value) && value.replaceAll("-", "").length < MIN_HEX_SECRET) {
        return false;
    }

    if (value.includes("/") && value.split("/").every((segment) => segment.length < MIN_PATH_SEGMENT)) {
        return false;
    }

    const digits = value.match(DIGIT)?.length ?? 0;
    // One digit is enough for a long mixed-case run: an opaque 32-character token often has only one.
    const enoughDigits =
        digits >= MIN_DIGITS || (digits >= 1 && value.length >= MIN_RUN_CANDIDATE && LOWER.test(value) && UPPER.test(value) && !CAMEL_WORD.test(value));

    return enoughDigits && LETTER.test(value) && meanClassRun(value) <= MAX_MEAN_CLASS_RUN && shannonEntropy(value) >= MIN_ENTROPY_BITS;
};

/**
 * A plain identifier before an `=`: `session_id`, `utm_campaign_2024`, `SESSION_ID`, `sessionId`. Each of its `_`, `-`
 * or `.` segments is a word of up to 16 letters with at most a number at its end, a number, or camelCase words; a
 * random string's half (`kfexbet74wbpz7lp56`) has digits inside its letters or runs longer.
 */
const NAME_SEPARATOR = /[_.-]/u;
const NAME_SEGMENTS = [/^[a-z]{1,16}\d{0,4}$/u, /^[A-Z]{1,16}\d{0,4}$/u, /^\d{1,4}$/u, /^[a-z]{1,16}(?:[A-Z][a-z]{2,15}){1,4}$/u];
const isPlainName = (part: string): boolean => part.split(NAME_SEPARATOR).every((segment) => NAME_SEGMENTS.some((pattern) => pattern.test(segment)));

/**
 * A value under 32 characters, judged alone, must switch character class as often as a random string does: a code made
 * of words and numbers (`Release2024Q3Build17`, `Win10x64Build19045Pro`) runs above 2 characters per class.
 */
const MAX_SHORT_VALUE_CLASS_RUN = 2;
/** A longer value judged alone may run a little longer per class, still under what a code of words and numbers runs. */
const MAX_LONG_VALUE_CLASS_RUN = 2.5;

/** Whether a value judged alone switches character class as often as a random string of its length does. */
const switchesLikeRandom = (value: string): boolean =>
    value.length >= MIN_RUN_CANDIDATE
        ? meanClassRun(value) <= MAX_LONG_VALUE_CLASS_RUN
        : (value.match(VALUE_SEPARATOR)?.length ?? 0) <= MAX_SHORT_VALUE_SEPARATORS && meanClassRun(value) <= MAX_SHORT_VALUE_CLASS_RUN;

/**
 * `run` with a random value redacted. A run of 32 characters or more that reads as random (or, outside a URL, as an
 * AWS key) goes whole, its name aside when every part before an `=` is a plain name (`session_id=«redacted»`). Then,
 * in a run of plain names, each value of 20 characters or more is judged alone, so `sid=<random>` loses its value
 * although the run is short or its name makes it read as words.
 */
const redactRandomRun = (run: string, awsKeys: boolean): string => {
    const isSecret = (value: string): boolean => looksLikeRandomSecret(value) || (awsKeys && looksLikeAwsSecretKey(value));
    const parts = run.replace(BASE64_PADDING, "").split("=");
    const named = NAMED_VALUE.test(run) && parts.slice(0, -1).every((part) => isPlainName(part));

    if (run.length >= MIN_RUN_CANDIDATE && isSecret(run)) {
        return named ? `${parts[0] ?? ""}=${REDACTED}` : REDACTED;
    }

    if (!named) {
        return run;
    }

    // Offset 0 is the name, never a value.
    return run.replaceAll(RUN_VALUE, (value: string, offset: number) => (offset > 0 && isSecret(value) && switchesLikeRandom(value) ? REDACTED : value));
};

/** A 40-character AWS secret key, which `looksLikeRandomSecret` misses when it holds fewer than two digits or reads as a path. */
const looksLikeAwsSecretKey = (value: string): boolean =>
    AWS_SECRET_KEY.test(value) &&
    LOWER.test(value) &&
    UPPER.test(value) &&
    AWS_SECRET_MARK.test(value) &&
    meanClassRun(value) <= MAX_AWS_CLASS_RUN &&
    shannonEntropy(value) >= MIN_ENTROPY_BITS;

const AWS_SECRET_KEY_LENGTH = 40;
/** A run of an AWS key's characters: a `.`, `?`, `)`, `-` or quote after a URL's last segment ends it. */
const AWS_KEY_RUN = /[\d+/A-Za-z]{40,}/gu;
/**
 * A path segment of four or more letters that reads as words (`file`, `keys`, `DesignSystem`), which a segment of a
 * random key seldom does; a shorter one (`kq`, `abc`) is as likely to be part of a key.
 */
const WORD_SEGMENT = /^(?=\w{4})[A-Z]?[a-z]{2,}(?:[A-Z][a-z]{2,})*$/u;

/** Whether `segments`, joined by `/`, are one AWS secret key: not starting or ending at a `/`, and no segment a word. */
const isAwsKeyWindow = (segments: ReadonlyArray<string>): boolean =>
    looksLikeAwsSecretKey(segments.join("/")) && segments.at(0) !== "" && segments.at(-1) !== "" && segments.every((segment) => !WORD_SEGMENT.test(segment));

/**
 * `path` with an AWS secret key that spans whole `/`-separated segments redacted: in
 * `https://example.com/wJalr…/K7MD…/bPxR…/run` each segment is too short to read as random, but together they are a key.
 * Each start reads at most 40 characters on, so this stays linear.
 */
const redactAwsKeyInRun = (path: string): string => {
    const segments = path.split("/");
    const out: string[] = [];

    let start = 0;

    while (start < segments.length) {
        let joined = segments[start] ?? "";
        let end = start;

        while (joined.length < AWS_SECRET_KEY_LENGTH && end + 1 < segments.length) {
            end += 1;
            joined += `/${segments[end] ?? ""}`;
        }

        const isKey = joined.length === AWS_SECRET_KEY_LENGTH && isAwsKeyWindow(segments.slice(start, end + 1));

        out.push(isKey ? REDACTED : (segments[start] ?? ""));
        start = (isKey ? end : start) + 1;
    }

    return out.join("/");
};

const redactAwsKeysInPath = (text: string): string => text.replaceAll(AWS_KEY_RUN, (run) => redactAwsKeyInRun(run));

const isBasicCredential = (value: string): boolean => {
    if (value.length >= MIN_SYMBOL_BASIC && BASE64_SYMBOL.test(value)) {
        return true;
    }

    try {
        return BASIC_PAIR.test(atob(value));
    } catch {
        return false;
    }
};

const isBearerCredential = (value: string): boolean =>
    BASE64_SYMBOL.test(value) ||
    (value.length >= MIN_LETTER_ONLY_BEARER && LOWER.test(value) && UPPER.test(value) && meanClassRun(value) <= MAX_MEAN_CLASS_RUN);

const describesPassword = (value: string, preposition: string | undefined): boolean => {
    const first = value.split(WORD_SPLIT, 1)[0]?.toLowerCase() ?? "";
    const followed = value.trim().includes(" ") || preposition !== undefined;

    return DESCRIBING_WORDS.has(first) || PARTICIPLE.test(first) || (followed && DESCRIBING_SUFFIX.test(first)) || isCount(value);
};

/** Whether an `=`-assigned password value is the password itself: anything but the marker or a setting's literal. */
const isAssignedPassword = (value: string): boolean => !ALREADY_REDACTED.test(value) && !isSetting(value) && !isCount(value);

/**
 * Whether a stated password value is the password itself. A quoted value always is. Otherwise a value that starts
 * with a describing word or gives a length is prose, one with a digit or a symbol is a password, and a letter-only one
 * is a password only when it is a single word that ends its clause: "my password is hunter" gives one, "my password
 * is hard to remember" and "the password is twelve characters long" do not.
 */
const isPasswordValue = (value: string, preposition: string | undefined): boolean => {
    if (ALREADY_REDACTED.test(value)) {
        return false;
    }

    if (QUOTED.test(value)) {
        return true;
    }

    if (describesPassword(value, preposition)) {
        return false;
    }

    return looksLikeCredential(value) || (!value.includes(" ") && preposition === undefined);
};

const redactAssignedSecrets = (text: string): string =>
    text.replaceAll(ASSIGNED_SECRET, (match: string, name: string, separator: string, value: string, offset: number, whole: string) => {
        const unquoted = !QUOTED.test(value);
        const keep =
            ALREADY_REDACTED.test(value) ||
            !isNextLineValue(name, value) ||
            isDesignToken(whole, offset, name, value) ||
            (unquoted && (isSettingLiteral(value) || isCount(`${value}${CLAUSE_TAIL.exec(whole.slice(offset + match.length))?.[0] ?? ""}`))) ||
            (separator === ":" && unquoted && !SCHEME.test(value) && !looksLikeCredential(value));

        return keep ? match : `${name}${REDACTED}`;
    });

/** `text` with every secret-looking value replaced by `REDACTED`. Idempotent. */
export const redactSecrets = (text: string): string => {
    let result = text.replaceAll(PRIVATE_KEY_BLOCK, () => REDACTED);

    for (const pattern of PROVIDER_TOKENS) {
        result = result.replaceAll(pattern, () => REDACTED);
    }

    if (PASSWORD_HINT.test(result)) {
        result = result
            .replaceAll(PASSWORD_ASSIGNMENT, (match: string, name: string, value: string) =>
                isAssignedPassword(value) && isNextLineValue(name, value) ? `${name}${REDACTED}` : match,
            )
            .replaceAll(CODE_PASSWORD_LABEL, (match: string, name: string, value: string) =>
                isAssignedPassword(value) && (QUOTED.test(value) || !describesPassword(value, undefined)) ? `${name}${REDACTED}` : match,
            )
            .replaceAll(PASSWORD_VALUE, (match: string, name: string, _separator: string, value: string, preposition: string | undefined) =>
                isPasswordValue(value, preposition) ? `${name}${REDACTED}` : match,
            );
    }

    result = result
        .replaceAll(BEARER, (match: string, scheme: string, value: string) => (isBearerCredential(value) ? `${scheme} ${REDACTED}` : match))
        .replaceAll(BASIC, (match: string, scheme: string, value: string) => (isBasicCredential(value) ? `${scheme} ${REDACTED}` : match));

    const assigned = redactAssignedSecrets(result);

    // Once more after a change: a label kept for the design word before it (`api_key=Xy7-color token: blue-600`) is
    // judged again now that the word went with its value, so a second call finds nothing left to redact.
    return (assigned === result ? assigned : redactAssignedSecrets(assigned))
        .replaceAll(STATED_SECRET, (match: string, name: string, value: string, offset: number, whole: string) =>
            looksLikeCredential(value) && !ALREADY_REDACTED.test(value) && !isDesignToken(whole, offset, name, value) ? `${name}${REDACTED}` : match,
        )
        .replaceAll(URL_OR_CANDIDATE, (match: string) => {
            if (match.startsWith("http")) {
                return redactAwsKeysInPath(match).replaceAll(URL_PART, (part) => redactRandomRun(part, false));
            }

            const redacted = redactRandomRun(match, true);

            return redacted === match && match.includes("/") ? redactAwsKeysInPath(match) : redacted;
        });
};

/** A quoted value that spans lines after a secret's name: `DB_PASSWORD="alpha⏎beta"`. */
const MULTILINE_ASSIGNED = new RegExp(
    String.raw`(?<name>\b${SECRET_NAME}["']?[^\S\n]*[:=][^\S\n]*)(?<value>"(?:[^"\\\s]|\\\S|\r?\n){0,1000}"(?![^\s,.;:)\]}]))`,
    "giu",
);

/**
 * `text` with each quoted secret value that spans lines redacted, for a caller that reads `text` line by line next:
 * split first, a value's later lines would read as ordinary text.
 */
export const redactMultilineSecrets = (text: string): string =>
    text.replaceAll(MULTILINE_ASSIGNED, (match: string, name: string, value: string) => (value.includes("\n") ? `${name}${REDACTED}` : match));

/** True when `text` holds a value `redactSecrets` would remove. */
export const containsSecret = (text: string): boolean => redactSecrets(text) !== text;
