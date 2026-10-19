/**
 * Where a pasted skill URL may be read from. Pure (no server imports), pinned by
 * `source-url.test.ts`.
 *
 * Skill registries such as skills.sh list skills that live in GitHub repositories,
 * and their own API needs a Vercel OIDC token, so GitHub is the one source. The
 * fetched URL is NEVER the pasted one: the pasted URL is only read for an owner,
 * a repository, a ref and a path, each checked against a strict character set, and
 * the request is built from those on the fixed host `raw.githubusercontent.com`.
 * A pasted host, port, credentials, query or fragment therefore cannot steer it.
 */

import { SKILL_MARKDOWN_FILE } from "./markdown";

export const SKILL_SOURCE_HOST = "raw.githubusercontent.com";

const GITHUB_NAME = /^[\w.-]{1,100}$/;
const SKILL_NAME = /^[a-z\d][a-z\d-]{0,99}$/;
/** A ref (branch, tag or commit): letters, digits, `.`, `_`, `-`, with `/` inside a branch name. */
const REF = /^[\w.-]+(?:\/[\w.-]+){0,5}$/;
const PATH_SEGMENT = /^[\w.-]{1,100}$/;
const MAX_PATH_SEGMENTS = 8;

/** Where a skills.sh listing's `owner/repo/skill` is usually found in the repository. */
const SKILLS_SH_LAYOUTS = (skill: string): string[] => [`skills/${skill}`, skill, `.claude/skills/${skill}`];

export type SkillSourceResult = { error: string; ok: false } | { ok: true; urls: string[] };

const fail = (error: string): SkillSourceResult => {
    return { error, ok: false };
};

const rawUrl = (owner: string, repo: string, ref: string, directory: string[]): string =>
    `https://${SKILL_SOURCE_HOST}/${owner}/${repo}/${ref}/${[...directory, SKILL_MARKDOWN_FILE].join("/")}`;

const validSegments = (segments: string[]): boolean =>
    segments.length <= MAX_PATH_SEGMENTS && segments.every((segment) => PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..");

/** `dir/SKILL.md` or `dir` -> `dir`'s segments, or `undefined` when the path is not a skill location. */
const directoryOf = (segments: string[]): string[] | undefined => {
    const directory = segments.at(-1) === SKILL_MARKDOWN_FILE ? segments.slice(0, -1) : segments;

    return validSegments(directory) ? directory : undefined;
};

/** A ref may itself contain `/`, which the URL cannot tell from the path; only a single-segment ref is read, others need the raw URL. */
const fromGithub = (segments: string[]): SkillSourceResult => {
    const [owner, repo, kind, ref, ...rest] = segments;

    if (!owner || !repo || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) {
        return fail("Paste a link to a skill in a GitHub repository.");
    }

    if (kind === undefined) {
        return { ok: true, urls: [rawUrl(owner, repo, "HEAD", [])] };
    }

    if ((kind !== "blob" && kind !== "tree") || !ref || !REF.test(ref)) {
        return fail("Paste a link to a skill folder or its SKILL.md.");
    }

    const directory = directoryOf(rest);

    return directory ? { ok: true, urls: [rawUrl(owner, repo, ref, directory)] } : fail("That path is not a skill location.");
};

const fromRaw = (segments: string[]): SkillSourceResult => {
    const [owner, repo, ref, ...rest] = segments;

    if (!owner || !repo || !ref || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo) || !REF.test(ref) || segments.at(-1) !== SKILL_MARKDOWN_FILE) {
        return fail("Paste a link to a SKILL.md file.");
    }

    const directory = directoryOf(rest);

    return directory ? { ok: true, urls: [rawUrl(owner, repo, ref, directory)] } : fail("That path is not a skill location.");
};

const fromSkillsSh = (segments: string[]): SkillSourceResult => {
    const [owner, repo, skill] = segments;

    // `/site/<domain>/<skill>` entries are hosted by their own site, not in GitHub.
    if (
        segments.length !== 3 ||
        owner === "site" ||
        !owner ||
        !repo ||
        !skill ||
        !GITHUB_NAME.test(owner) ||
        !GITHUB_NAME.test(repo) ||
        !SKILL_NAME.test(skill)
    ) {
        return fail("Paste a skills.sh link of the form skills.sh/owner/repo/skill.");
    }

    return { ok: true, urls: SKILLS_SH_LAYOUTS(skill).map((directory) => rawUrl(owner, repo, "HEAD", directory.split("/"))) };
};

/** The raw GitHub URLs to try, in order, for a pasted GitHub or skills.sh link; or why the link is refused. */
export const resolveSkillSourceUrls = (pasted: string): SkillSourceResult => {
    let url: URL;

    try {
        url = new URL(pasted.trim());
    } catch {
        return fail("That is not a valid link.");
    }

    if (url.protocol !== "https:" || url.username || url.password || url.port) {
        return fail("Only plain https links are accepted.");
    }

    const segments = url.pathname.split("/").filter(Boolean);

    switch (url.hostname) {
        case "github.com": {
            return fromGithub(segments);
        }
        case "raw.githubusercontent.com": {
            return fromRaw(segments);
        }
        case "skills.sh":
        case "www.skills.sh": {
            return fromSkillsSh(segments);
        }
        default: {
            return fail("Skills can be imported from GitHub and skills.sh links.");
        }
    }
};
