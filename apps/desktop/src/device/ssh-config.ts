/**
 * A read-only reader for the simple keys of `~/.ssh/config`. The transport runs `ssh -F /dev/null`, so nothing in
 * that file applies by itself: the keys read here are passed to `ssh` explicitly, resolved as ssh would: blocks in file
 * order (settings before the first `Host` line first), the first value of a key wins, and a block applies to an alias
 * when one of its `Host` patterns matches it and no negated pattern does. `IdentityFile` is the exception: ssh adds every
 * applicable one, and the transport takes one key, so a host with more than one is disabled. What the reader cannot
 * honour (a `Match` rule whose criteria can select the host and that sets a key the transport uses, `Include` in a `Host` block, `ProxyJump`, `ProxyCommand`, a
 * relative `IdentityFile`, a malformed `Port`) makes a host disabled instead of being guessed at.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface SshHost {
    alias: string;
    /** Why the host cannot be used; null when it can. */
    disabledReason: string | null;
    hostName: string | null;
    identityFile: string | null;
    port: number | null;
    user: string | null;
}

interface Block {
    hostName: string | null;
    /** How many applicable `IdentityFile` lines set a key; ssh uses all of them, so more than one disables the host. */
    identityCount: number;
    identityFile: string | null;
    /** The `Host` patterns of the block; the block before the first `Host` line holds `*`, as ssh applies it to every host. */
    patterns: string[];
    port: number | null;
    /** The first ProxyJump or ProxyCommand value: `none` connects directly, any other is unsupported. */
    proxy: "direct" | "unsupported" | null;
    reason: string | null;
    user: string | null;
}

// A leading `!` negates a pattern; anywhere else `!` is a literal character of an alias, as in `build!legacy`.
const WILDCARD = /[*?]/u;
const GLOB_SPECIAL = /[$()+.\\[\]^{|}]/gu;
const KEY_END = /[\s=]/u;
const LINE_BREAK = /\r?\n/u;
const DIGITS = /^\d+$/u;
const SPACE = /\s/u;
/** `~user/...` or `~user`, not `~` or `~/...`: another user's home. */
const OTHER_USER_HOME = /^~[^/]/u;

const EMPTY: Block = { hostName: null, identityCount: 0, identityFile: null, patterns: [], port: null, proxy: null, reason: null, user: null };

const MULTIPLE_IDENTITIES = "This host has more than one IdentityFile in ~/.ssh/config, which Neore does not support.";
const RELATIVE_IDENTITY = "This host has a relative IdentityFile in ~/.ssh/config, which Neore does not support.";
const NO_KEY_FILES = "This host sets IdentityFile none in ~/.ssh/config, which Neore cannot honour.";
const PROXY = "This host uses ProxyJump or ProxyCommand in ~/.ssh/config, which Neore does not support.";
const MATCH_RULE = "This host is used by a Match rule in ~/.ssh/config, which Neore does not evaluate.";

/** Drops a trailing `# comment`: a `#` that starts the text or follows a space, outside quotes. */
const stripComment = (value: string): string => {
    let quoted = false;

    for (let index = 0; index < value.length; index += 1) {
        const char = value.charAt(index);

        if (char === "\\" && (!quoted || value.charAt(index + 1) === '"')) {
            index += 1;
        } else if (char === '"') {
            quoted = !quoted;
        } else if (char === "#" && !quoted && (index === 0 || SPACE.test(value.charAt(index - 1)))) {
            return value.slice(0, index);
        }
    }

    return value;
};

/** Splits a value into words as ssh does: spaces separate, double quotes group, and a backslash makes the next character literal (inside quotes only a double quote). */
const words = (value: string): string[] => {
    const text = stripComment(value);
    const found: string[] = [];
    let word: string | null = null;
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text.charAt(index);

        if (char === "\\" && index + 1 < text.length && (!quoted || text.charAt(index + 1) === '"')) {
            index += 1;
            word = (word ?? "") + text.charAt(index);
        } else if (char === '"') {
            quoted = !quoted;
            word ??= "";
        } else if (!quoted && SPACE.test(char)) {
            if (word !== null) {
                found.push(word);
                word = null;
            }
        } else {
            word = (word ?? "") + char;
        }
    }

    if (word !== null) {
        found.push(word);
    }

    return found;
};

const firstWord = (value: string): string | null => words(value)[0] ?? null;

const expandHome = (value: string, home: string): string => (value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value);

/** Decimal digits only, 1 to 65535; anything else is null. */
const parsePort = (value: string): number | null => {
    const port = DIGITS.test(value) ? Number(value) : NaN;

    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
};

/** `Key value` or `Key=value`, as OpenSSH reads it; null for a line with no value. */
const splitLine = (line: string): { key: string; value: string } | null => {
    const end = line.search(KEY_END);

    if (end <= 0) {
        return null;
    }

    let rest = line.slice(end).trimStart();

    if (rest.startsWith("=")) {
        rest = rest.slice(1).trimStart();
    }

    return { key: line.slice(0, end), value: rest.trimEnd() };
};

const unsupported = (key: string): string => `This host uses ${key} in ~/.ssh/config, which Neore does not support.`;

/** What one setting line says about its Host block. */
const settingOf = (key: string, value: string, home: string): Partial<Block> => {
    switch (key.toLowerCase()) {
        // ssh expands `%` tokens (%h, %n, %r, ...) in these values, and the transport runs with -F /dev/null, so a value
        // that holds one cannot be honoured.
        case "hostname": {
            const name = firstWord(value);

            return name?.includes("%") ? { reason: unsupported(key) } : { hostName: name };
        }
        case "identityfile": {
            const file = firstWord(value);

            if (file === null) {
                return {};
            }

            // `none` suppresses key files, and the transport cannot express that: it would fall back to the default keys.
            if (file.toLowerCase() === "none") {
                return { reason: NO_KEY_FILES };
            }

            // `~user/...` names another user's home, which the reader does not expand; ssh's own `~` is the only one handled.
            if (file.includes("%") || OTHER_USER_HOME.test(file)) {
                return { reason: unsupported(key) };
            }

            const expanded = expandHome(file, home);

            // A relative key is resolved by ssh against a place this reader does not know, so the host is disabled rather than guessed at.
            return path.isAbsolute(expanded) ? { identityCount: 1, identityFile: expanded } : { identityCount: 1, reason: RELATIVE_IDENTITY };
        }
        case "include": {
            return { reason: unsupported(key) };
        }
        case "port": {
            const port = parsePort(firstWord(value) ?? "");

            // An invalid value is kept as 0 so that no later Port fills it in; the host is disabled.
            return port === null ? { port: 0, reason: "This host has an invalid Port in ~/.ssh/config." } : { port };
        }
        case "proxycommand":
        case "proxyjump": {
            // `none` turns proxying off, so the host connects directly; any other value needs a jump or command the transport cannot make.
            return { proxy: firstWord(value)?.toLowerCase() === "none" ? "direct" : "unsupported" };
        }
        case "user": {
            return { user: firstWord(value) };
        }
        default: {
            // Everything else is left to the defaults: the transport passes only the keys above.
            return {};
        }
    }
};

/** The first value of a key wins, as in ssh; the IdentityFile lines are counted, not merged. */
const mergeFirst = (block: Block, patch: Partial<Block>): Block => {
    return {
        ...block,
        hostName: block.hostName ?? patch.hostName ?? null,
        identityCount: block.identityCount + (patch.identityCount ?? 0),
        identityFile: block.identityFile ?? patch.identityFile ?? null,
        port: block.port ?? patch.port ?? null,
        proxy: block.proxy ?? patch.proxy ?? null,
        reason: block.reason ?? patch.reason ?? null,
        user: block.user ?? patch.user ?? null,
    };
};

/** One criterion of a `Match` line: the names of `host` or `originalhost`, or `other` for one this reader cannot evaluate (`user`, `exec`, `all`, a negated name, ...). */
interface MatchCriterion {
    keyword: "host" | "originalhost" | "other";
    names: string[];
}

/** A `Match` line, and whether it sets a key the transport uses before the next Host or Match line. */
interface MatchRule {
    criteria: MatchCriterion[];
    relevant: boolean;
}

/** The criteria of a `Match` line; one this reader cannot evaluate makes the whole line `other`, which can select any host. */
const readMatch = (value: string): MatchCriterion[] => {
    const tokens = words(value);
    const criteria: MatchCriterion[] = [];

    for (let index = 0; index < tokens.length; index += 1) {
        const keyword = (tokens[index] ?? "").toLowerCase();
        const names = (tokens[index + 1] ?? "").split(",").filter(Boolean);

        if ((keyword !== "host" && keyword !== "originalhost") || names.length === 0 || names.some((name) => name.startsWith("!"))) {
            return [{ keyword: "other", names: [] }];
        }

        criteria.push({ keyword: keyword === "host" ? "host" : "originalhost", names });
        index += 1;
    }

    return criteria.length === 0 ? [{ keyword: "other", names: [] }] : criteria;
};

/** OpenSSH matches host patterns without regard to case, so `Host PROD` selects `prod`. */
const globMatches = (pattern: string, name: string): boolean => {
    const source = pattern.replaceAll(GLOB_SPECIAL, String.raw`\$&`).replaceAll("*", ".*").replaceAll("?", ".");

    return new RegExp(`^${source}$`, "iu").test(name);
};

/** Whether a block's `Host` patterns select the alias: a negated match excludes the block, otherwise one positive match suffices. */
const appliesTo = (block: Block, alias: string): boolean => {
    let matched = false;

    for (const pattern of block.patterns) {
        if (pattern.startsWith("!")) {
            if (globMatches(pattern.slice(1), alias)) {
                return false;
            }
        } else if (globMatches(pattern, alias)) {
            matched = true;
        }
    }

    return matched;
};

interface Parsed {
    blocks: Block[];
    matchRules: MatchRule[];
}

/** The keys the transport passes to ssh: a Match rule that sets none of them changes nothing the picker uses. */
const TRANSPORT_KEYS = new Set(["hostname", "identityfile", "port", "proxycommand", "proxyjump", "user"]);

const readLines = (text: string, home: string): Parsed => {
    const blocks: Block[] = [{ ...EMPTY, patterns: ["*"] }];
    const matchRules: MatchRule[] = [];
    // The index of the block that settings belong to: 0 is the global block before the first Host line; a Match block holds settings of its own, none of them a Host's.
    let current = 0;

    for (const raw of text.split(LINE_BREAK)) {
        const line = raw.trim();
        const parts = line === "" || line.startsWith("#") ? null : splitLine(line);
        const key = parts?.key.toLowerCase();

        if (parts === null) {
            continue;
        }

        if (key === "host") {
            blocks.push({ ...EMPTY, patterns: words(parts.value) });
            current = blocks.length - 1;
        } else if (key === "match") {
            matchRules.push({ criteria: readMatch(parts.value), relevant: false });
            current = -1;
        } else if (current === -1) {
            // Settings under a Match line apply to the hosts its criteria select, which this reader does not evaluate: they count only when they set a key the transport uses.
            const rule = matchRules.at(-1);

            // An Include under a Match line can set any of them, so it counts as well.
            if (rule !== undefined && (key === "include" || TRANSPORT_KEYS.has(key ?? ""))) {
                rule.relevant = true;
            }
        } else if (!(key === "include" && current === 0)) {
            // An Include before the first Host line adds blocks of its own, which this reader never sees; it is no reason to disable a host.
            blocks[current] = mergeFirst(blocks[current], settingOf(parts.key, parts.value, home));
        }
    }

    return { blocks, matchRules };
};

/** OpenSSH compares `Match host` and `Match originalhost` names without regard to case, unlike `Host` patterns. */
const matchesMatchName = (pattern: string, name: string): boolean => globMatches(pattern.toLowerCase(), name.toLowerCase());

/** Whether one criterion can hold for an alias: `host` tests the resolved host name, `originalhost` the alias as typed. */
const criterionMayMatch = (criterion: MatchCriterion, alias: string, hostName: string): boolean => {
    if (criterion.keyword === "other") {
        return true;
    }

    const name = criterion.keyword === "host" ? hostName : alias;

    return criterion.names.some((pattern) => matchesMatchName(pattern, name));
};

/** Parses the text of an ssh config. Pure, so it is tested without a file. */
export const parseSshConfig = (text: string, home: string): SshHost[] => {
    const { blocks, matchRules } = readLines(text, home);
    const hosts: SshHost[] = [];

    // Wildcard patterns are not hosts; they only contribute settings. An alias a line names twice is listed once, and one its own line negates is not listed.
    const listed = blocks.flatMap((block) => block.patterns.filter((alias) => !WILDCARD.test(alias) && !alias.startsWith("!") && appliesTo(block, alias)));

    const aliases = [...new Set(listed)];

    for (const alias of aliases) {
        const effective = { ...EMPTY };

        for (const candidate of blocks) {
            if (appliesTo(candidate, alias)) {
                Object.assign(effective, mergeFirst(effective, candidate));
            }
        }

        const usesMatch = matchRules.some((rule) => rule.relevant && rule.criteria.every((criterion) => criterionMayMatch(criterion, alias, effective.hostName ?? alias)));

        hosts.push({
            alias,
            disabledReason: effective.reason ?? (effective.proxy === "unsupported" ? PROXY : null) ?? (effective.identityCount > 1 ? MULTIPLE_IDENTITIES : null) ?? (usesMatch ? MATCH_RULE : null),
            hostName: effective.hostName,
            identityFile: effective.identityFile,
            port: effective.port === 0 ? null : effective.port,
            user: effective.user,
        });
    }

    return hosts;
};

/** Reads `~/.ssh/config`. A missing or unreadable file is an empty list. */
export const readSshConfig = (home: string = homedir(), read: (file: string) => string = (file) => readFileSync(file, "utf8")): SshHost[] => {
    try {
        return parseSshConfig(read(path.join(home, ".ssh", "config")), home);
    } catch {
        return [];
    }
};
