/**
 * The Develop UI decides from the host's capability report and never from which
 * host it is. This reads every source file of the feature and its route and fails
 * when a Git host's name turns up in one, as gating code, a label or a comment:
 * the page's wording for the host (its name, its word for a change) arrives as data
 * from the backend. The scanner is checked against injected snippets first, so a
 * scan that matches nothing cannot pass for a clean tree.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_FILE = /\.tsx?$/u;
const TEST_FILE = /\.test\.tsx?$/u;
const HOST_NAMES = /github|gitlab|gitea|forgejo|codeberg|bitbucket|azure|visualstudio|\bghe\b/giu;
const RAW_HTML = /dangerouslySetInnerHTML|\binnerHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/gu;

/** Every host name or raw-HTML sink in `source`. */
const findViolations = (source: string): string[] => [...source.matchAll(HOST_NAMES), ...source.matchAll(RAW_HTML)].map((match) => match[0]);

const FEATURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = path.resolve(FEATURE, "../../routes/_shortcut/develop.tsx");

const sourcesIn = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
        const full = path.join(directory, name);

        if (statSync(full).isDirectory()) {
            return sourcesIn(full);
        }

        return SOURCE_FILE.test(name) && !TEST_FILE.test(name) ? [full] : [];
    });

describe("the Develop UI is host-neutral", () => {
    it.each([
        ['if (host.kind === "gitlab") {', ["gitlab"]],
        ["const isGithub = host.label === 'GitHub'", ["Github", "GitHub"]],
        ["switch (hostKind) { case 'forgejo': }", ["forgejo"]],
        ["host.label.includes('Bitbucket')", ["Bitbucket"]],
        ['hostKind === "azure"', ["azure"]],
        ["<div dangerouslySetInnerHTML={{ __html: body }} />", ["dangerouslySetInnerHTML"]],
        ["element.innerHTML = body", ["innerHTML"]],
    ])("catches %s", (snippet, found) => {
        expect(findViolations(snippet)).toEqual(found);
    });

    it("lets a capability read through", () => {
        expect(findViolations('isHostCapabilityAvailable(host.capabilities, "inbox.drafts")')).toEqual([]);
    });

    it("scans the feature and its route", () => {
        const files = [...sourcesIn(FEATURE), ROUTE];

        expect(files.length).toBeGreaterThan(8);
        expect(files).toContain(ROUTE);
    });

    it("finds no host name and no raw HTML in them", () => {
        const found = [...sourcesIn(FEATURE), ROUTE].flatMap((file) =>
            findViolations(readFileSync(file, "utf8")).map((hit) => `${path.relative(FEATURE, file)}: ${hit}`),
        );

        expect(found).toEqual([]);
    });
});
