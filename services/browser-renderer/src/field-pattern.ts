/**
 * A password field's `pattern`, read without running it: the page sets it, so a regular expression built from it could
 * backtrack for as long as the page likes, inside the Worker. Only a plain sequence is read (literal letters and digits,
 * `.`, `\d`, `\w`, `\S`, and classes of ranges and characters, each with a quantifier); anything else (a group, an
 * alternation, a lookaround, a negated class, a property escape) is not, and the field is refused.
 */

/** One step of a pattern: one of `characters`, from `min` to `max` times. */
export interface PatternStep {
    /** The letters and digits the step takes. */
    characters: string;
    max: number;
    min: number;
}

/** The longest pattern read: past it, the field is refused rather than read. */
export const MAX_PATTERN_LENGTH = 512;

const DIGITS = "0123456789";

const LOWER = "abcdefghijklmnopqrstuvwxyz";

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Every character a stand-in may hold: a symbol would need an encoding of its own in the form's body. */
export const ALPHANUMERIC = `${UPPER}${LOWER}${DIGITS}`;

/** The escapes read as classes, as the letters and digits they take (`\w`'s `_` and `\S`'s symbols are never drawn). */
const CLASS_ESCAPES = new Map([
    ["d", DIGITS],
    ["S", ALPHANUMERIC],
    ["w", ALPHANUMERIC],
]);

/** Characters that stand for themselves outside a class. */
const PLAIN_RE = /^[\dA-Za-z]$/u;

/** Characters that may follow `\` as themselves, outside a class and in one. */
const ESCAPED_SYMBOL_RE = /^[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~-]$/u;

const QUANTIFIER_RE = /^\{(\d{1,4})(?:(,)(\d{0,4}))?\}/u;

/** Characters a class cannot hold unescaped. */
const CLASS_STOP = new Set(["[", "]"]);

/** What one read gives: the characters taken, and where the read ended. */
interface Read {
    characters: string;
    end: number;
}

/** The letters and digits from `from` to `to`, or `null` for a range that is not of one kind (`0-z`). */
const range = (from: string, to: string): string | null => {
    for (const set of [DIGITS, LOWER, UPPER]) {
        const start = set.indexOf(from);
        const end = set.indexOf(to);

        if (start !== -1 && end !== -1) {
            return start <= end ? set.slice(start, end + 1) : null;
        }
    }

    return null;
};

/** The escape at `pattern[at]` (`\`): a class escape, or a symbol as itself; `null` for any other. */
const readEscape = (pattern: string, at: number): (Read & { isClass: boolean }) | null => {
    const next = pattern[at + 1] ?? "";
    const escaped = CLASS_ESCAPES.get(next);

    if (escaped !== undefined) {
        return { characters: escaped, end: at + 2, isClass: true };
    }

    return ESCAPED_SYMBOL_RE.test(next) ? { characters: next, end: at + 2, isClass: false } : null;
};

/** One character of a class at `pattern[at]`, plain or escaped; `null` for a stop or a set operation of the `v` flag. */
const readCharacter = (pattern: string, at: number): (Read & { isClass: boolean }) | null => {
    const char = pattern[at];

    if (char === undefined || CLASS_STOP.has(char) || pattern.startsWith("&&", at) || pattern.startsWith("--", at)) {
        return null;
    }

    return char === "\\" ? readEscape(pattern, at) : { characters: char, end: at + 1, isClass: false };
};

/** One member of a class at `pattern[at]`: a character, an escape, or a range of letters or digits. */
const readMember = (pattern: string, at: number): Read | null => {
    const first = readCharacter(pattern, at);

    if (!first || first.isClass || pattern[first.end] !== "-" || pattern[first.end + 1] === "]") {
        return first;
    }

    const last = readCharacter(pattern, first.end + 1);
    const between = last && !last.isClass ? range(first.characters, last.characters) : null;

    return last === null || between === null ? null : { characters: between, end: last.end };
};

/** The class at `pattern[at]` (`[`), or `null` when it is not read (negated, nested, or with a set operation). */
const readClass = (pattern: string, at: number): Read | null => {
    if (pattern[at + 1] === "^") {
        return null;
    }

    let index = at + 1;
    let characters = "";

    while (pattern[index] !== "]") {
        const member = readMember(pattern, index);

        if (!member) {
            return null;
        }

        characters += member.characters;
        index = member.end;
    }

    return { characters, end: index + 1 };
};

/** The atom at `pattern[at]`: a class, an escape, `.`, or a letter or digit. */
const readAtom = (pattern: string, at: number): Read | null => {
    const char = pattern[at] ?? "";

    if (char === "[") {
        return readClass(pattern, at);
    }

    if (char === "\\") {
        return readEscape(pattern, at);
    }

    if (char === ".") {
        return { characters: ALPHANUMERIC, end: at + 1 };
    }

    return PLAIN_RE.test(char) ? { characters: char, end: at + 1 } : null;
};

interface Quantity {
    end: number;
    max: number;
    min: number;
}

/** The quantifier at `pattern[at]` (none is once), a lazy one's `?` included; `null` for `{3,2}`. */
const readQuantifier = (pattern: string, at: number, end: number): Quantity | null => {
    const rest = pattern.slice(at, end);
    const counted = QUANTIFIER_RE.exec(rest);
    let quantity: Quantity;

    if (rest.startsWith("*") || rest.startsWith("+") || rest.startsWith("?")) {
        quantity = { end: at + 1, max: rest.startsWith("?") ? 1 : Infinity, min: rest.startsWith("+") ? 1 : 0 };
    } else if (counted) {
        const min = Number(counted[1]);
        let max = min;

        if (counted[2] !== undefined) {
            max = counted[3] === "" ? Infinity : Number(counted[3]);
        }

        quantity = { end: at + counted[0].length, max, min };
    } else {
        return { end: at, max: 1, min: 1 };
    }

    if (quantity.max < quantity.min) {
        return null;
    }

    // A lazy quantifier matches the same strings as a greedy one, as the whole pattern is anchored.
    return quantity.end < end && pattern[quantity.end] === "?" ? { ...quantity, end: quantity.end + 1 } : quantity;
};

/**
 * The steps of `pattern`, as `^(?:pattern)$` matches it, or `null` when it is not a plain sequence this reads. Only the
 * letters and digits of each step are kept: a step left with none makes the pattern unread, unless it may be left out.
 */
export const readPattern = (pattern: string): PatternStep[] | null => {
    if (pattern.length > MAX_PATTERN_LENGTH) {
        return null;
    }

    const steps: PatternStep[] = [];
    // `^` and `$` are only read where they change nothing: at the very start and end.
    const end = pattern.endsWith("$") && !pattern.endsWith(String.raw`\$`) ? pattern.length - 1 : pattern.length;
    let index = pattern.startsWith("^") ? 1 : 0;

    while (index < end) {
        const atom = readAtom(pattern, index);
        const quantity = atom ? readQuantifier(pattern, atom.end, end) : null;

        if (!atom || !quantity) {
            return null;
        }

        const kept = [...new Set(atom.characters)].filter((candidate) => ALPHANUMERIC.includes(candidate)).join("");

        if (kept === "" && quantity.min > 0) {
            return null;
        }

        if (kept !== "" && quantity.max > 0) {
            steps.push({ characters: kept, max: quantity.max, min: quantity.min });
        }

        index = quantity.end;
    }

    return index === end ? steps : null;
};
