/**
 * A read-only reader for the simple keys of `~/.ssh/config`. The transport runs `ssh -F /dev/null`, so nothing in
 * that file applies by itself: the keys read here are passed to `ssh` explicitly, resolved as ssh would: blocks in file
 * order (settings before the first `Host` line first), the first value of a key wins, and a block applies to an alias
 * when one of its `Host` patterns matches it and no negated pattern does. What the reader cannot honour
 * (`Match`, `Include`, `ProxyJump`, `ProxyCommand`) makes a host disabled instead of being guessed at.
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
    identityFile: string | null;
    /** The `Host` patterns of the block; the block before the first `Host` line holds `*`, as ssh applies it to every host. */
    patterns: string[];
    port: number | null;
    reason: string | null;
    user: string | null;
}

const WILDCARD = /[!*?]/u;
const GLOB_SPECIAL = /[$()+.\\[\]^{|}]/gu;
const KEY_END = /[\s=]/u;
const WORD = /"([^"]*)"|(\S+)/gu;
const LINE_BREAK = /\r?\n/u;
/** A `Match` criterion that depends on something this reader cannot evaluate: it may change any host. */
const MATCH_ANYWHERE = new Set(["all", "canonical", "exec", "final", "localnetwork", "tagged"]);

const EMPTY: Block = { hostName: null, identityFile: null, patterns: [], port: null, reason: null, user: null };

const words = (value: string): string[] => Array.from(value.matchAll(WORD), (match) => match[1] ?? match[2] ?? "");

const firstWord = (value: string): string | null => words(value)[0] ?? null;

const expandHome = (value: string, home: string): string => (value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value);

const parsePort = (value: string): number | null => {
    const port = Number(value);

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
        case "hostname": {
            return { hostName: firstWord(value) };
        }
        case "identityfile": {
            const file = firstWord(value);

            return { identityFile: file === null ? null : expandHome(file, home) };
        }
        case "include":
        case "proxycommand":
        case "proxyjump": {
            return { reason: unsupported(key) };
        }
        case "port": {
            return { port: parsePort(firstWord(value) ?? "") };
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

/** The first value of a key wins, as in ssh. */
const mergeFirst = (block: Block, patch: Partial<Block>): Block => {
    return {
        ...block,
        hostName: block.hostName ?? patch.hostName ?? null,
        identityFile: block.identityFile ?? patch.identityFile ?? null,
        port: block.port ?? patch.port ?? null,
        reason: block.reason ?? patch.reason ?? null,
        user: block.user ?? patch.user ?? null,
    };
};

/** The names a `Match` line mentions, and whether it has a criterion that may apply to any host. */
const readMatch = (value: string): { anything: boolean; names: string[] } => {
    const parts = words(value).flatMap((word) => word.split(","));

    return { anything: parts.some((part) => MATCH_ANYWHERE.has(part.toLowerCase())), names: parts };
};

const globMatches = (pattern: string, name: string): boolean => {
    const source = pattern.replaceAll(GLOB_SPECIAL, String.raw`\$&`).replaceAll("*", ".*").replaceAll("?", ".");

    return new RegExp(`^${source}$`, "u").test(name);
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
    matched: Set<string>;
    matchesAnything: boolean;
}

const readLines = (text: string, home: string): Parsed => {
    const blocks: Block[] = [{ ...EMPTY, patterns: ["*"] }];
    const matched = new Set<string>();
    let matchesAnything = false;
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
            const match = readMatch(parts.value);

            current = -1;
            matchesAnything ||= match.anything;

            for (const name of match.names) {
                matched.add(name);
            }
        } else if (blocks[current] !== undefined) {
            blocks[current] = mergeFirst(blocks[current], settingOf(parts.key, parts.value, home));
        }
    }

    return { blocks, matched, matchesAnything };
};

/** Parses the text of an ssh config. Pure, so it is tested without a file. */
export const parseSshConfig = (text: string, home: string): SshHost[] => {
    const { blocks, matched, matchesAnything } = readLines(text, home);
    const hosts: SshHost[] = [];

    // Wildcard patterns are not hosts; they only contribute settings. An alias a line names twice is listed once, and one its own line negates is not listed.
    const listed = blocks.flatMap((block) => block.patterns.filter((alias) => !WILDCARD.test(alias) && appliesTo(block, alias)));

    const aliases = [...new Set(listed)];

    for (const alias of aliases) {
        const effective = { ...EMPTY };

        for (const candidate of blocks) {
            if (appliesTo(candidate, alias)) {
                Object.assign(effective, mergeFirst(effective, candidate));
            }
        }

        const usesMatch = matchesAnything || matched.has(alias) || (effective.hostName !== null && matched.has(effective.hostName));

        hosts.push({
            alias,
            disabledReason: effective.reason ?? (usesMatch ? "This host is used by a Match rule in ~/.ssh/config, which Neore does not evaluate." : null),
            hostName: effective.hostName,
            identityFile: effective.identityFile,
            port: effective.port,
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
