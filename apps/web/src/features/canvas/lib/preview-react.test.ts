import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
    BABEL_STANDALONE_SCRIPT,
    buildReactPreviewDocument,
    REACT_PREVIEW_HELPERS,
    REACT_PREVIEW_IMPORT_MAP,
    REACT_PREVIEW_VERSIONS,
    TAILWIND_BROWSER_SCRIPT,
} from "./preview-react";
import { buildPreviewSrcdoc, getPreviewLanguage, PREVIEW_CSP } from "./preview-srcdoc";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;
const SRI_SHA384 = /^sha384-[\d+/A-Za-z]{64}$/u;
const PINNED_ESM_URL = /^https:\/\/esm\.sh\/[@a-z-]+@\d+\.\d+\.\d+(?:[/?]|$)/u;
const REACT_ITSELF = new Set(["clsx", "react", "react/jsx-runtime"]);

interface Helpers {
    findRequires: (code: string) => string[];
    pickComponent: (moduleExports: object | undefined, app?: unknown) => unknown;
    unsupportedImports: (specifiers: string[], allowed: string[]) => string[];
}

/** Evaluates the exact helper source the frame runs. */
const loadHelpers = (): Helpers =>
    // eslint-disable-next-line sonarjs/code-eval -- evaluates our own constant, to test the code the frame runs
    runInNewContext(`${REACT_PREVIEW_HELPERS}; ({ findRequires, pickComponent, unsupportedImports })`) as Helpers;

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

describe(getPreviewLanguage, () => {
    it("maps jsx, tsx and react to the React preview", () => {
        expect(getPreviewLanguage("jsx")).toBe("react");
        expect(getPreviewLanguage("TSX")).toBe("react");
        expect(getPreviewLanguage("react")).toBe("react");
    });
});

describe("react preview assets", () => {
    it("pins every package to an exact version", () => {
        for (const version of Object.values(REACT_PREVIEW_VERSIONS)) {
            expect(version).toMatch(EXACT_VERSION);
        }

        for (const url of Object.values(REACT_PREVIEW_IMPORT_MAP)) {
            expect(url).toMatch(PINNED_ESM_URL);
        }
    });

    it("loads the classic scripts from jsDelivr with an SRI hash", () => {
        for (const asset of [BABEL_STANDALONE_SCRIPT, TAILWIND_BROWSER_SCRIPT]) {
            expect(asset.src.startsWith("https://cdn.jsdelivr.net/npm/")).toBe(true);
            expect(asset.integrity).toMatch(SRI_SHA384);
        }

        const document = parse(buildReactPreviewDocument("export default () => null"));
        const scripts = [...document.querySelectorAll("script[src]")];

        expect(scripts).toHaveLength(2);

        for (const script of scripts) {
            expect(script.getAttribute("integrity")).toMatch(SRI_SHA384);
            // SRI on a cross-origin script is only checked in CORS mode.
            expect(script.getAttribute("crossorigin")).toBe("anonymous");
        }
    });

    it("keeps react and react-dom external so every library shares one React", () => {
        for (const [specifier, url] of Object.entries(REACT_PREVIEW_IMPORT_MAP)) {
            // React itself, and clsx, which does not import it.
            if (REACT_ITSELF.has(specifier)) {
                continue;
            }

            expect(url, specifier).toContain("external=react");
        }
    });

    it("allows the module CDN as a script source only", () => {
        const directives = PREVIEW_CSP.split("; ");

        expect(directives.find((directive) => directive.startsWith("script-src"))).toContain("https://esm.sh");
        expect(directives.filter((directive) => directive.includes("esm.sh"))).toHaveLength(1);
    });
});

describe(buildReactPreviewDocument, () => {
    it("declares the allowlisted import map before any script runs", () => {
        const html = buildPreviewSrcdoc("export default function App() { return <p>hi</p>; }", "react");
        const document = parse(html);
        const importMap = document.querySelector('script[type="importmap"]');

        expect(importMap).not.toBeNull();
        expect(JSON.parse(importMap?.textContent ?? "")).toStrictEqual({ imports: REACT_PREVIEW_IMPORT_MAP });
        expect(new Set(Object.keys(REACT_PREVIEW_IMPORT_MAP))).toStrictEqual(
            new Set(["clsx", "framer-motion", "lucide-react", "react", "react-dom", "react-dom/client", "react/jsx-runtime", "recharts"]),
        );
        expect(html.indexOf("importmap")).toBeLessThan(html.indexOf(BABEL_STANDALONE_SCRIPT.src));
        expect(document.querySelector("#root")).not.toBeNull();
    });

    it("cannot be broken out of by source containing a closing script tag", () => {
        const source = 'export default () => <p>{"</script><img src=x onerror=alert(1)>"}</p>;';
        const document = parse(buildReactPreviewDocument(source));

        expect(document.querySelector("img")).toBeNull();
        expect(document.querySelectorAll("script")).toHaveLength(4);
    });
});

describe("react preview runner helpers", () => {
    const { findRequires, pickComponent, unsupportedImports } = loadHelpers();

    it("finds the specifiers Babel's CommonJS output requires, once each", () => {
        const compiled = [
            '"use strict";',
            'var _react = _interopRequireDefault(require("react"));',
            'var _jsxRuntime = require("react/jsx-runtime");',
            "var _lucide = require('lucide-react');",
            'var again = require("react");',
        ].join("\n");

        expect(findRequires(compiled)).toEqual(["react", "react/jsx-runtime", "lucide-react"]);
    });

    it("reports imports outside the allowlist, relative ones included", () => {
        const allowed = Object.keys(REACT_PREVIEW_IMPORT_MAP);

        expect(unsupportedImports(["react", "lodash", "./Button", "recharts"], allowed)).toEqual(["lodash", "./Button"]);
        expect(unsupportedImports(["react", "react-dom/client"], allowed)).toEqual([]);
    });

    it("prefers the default export", () => {
        const Default = (): null => null;
        const App = (): null => null;

        expect(pickComponent({ App, default: Default }, App)).toBe(Default);
    });

    it("falls back to App, exported or only declared", () => {
        const App = (): null => null;

        expect(pickComponent({ App }, App)).toBe(App);
        expect(pickComponent({}, App)).toBe(App);
    });

    it("accepts memo/forwardRef objects as components", () => {
        const memoised = { $$typeof: Symbol.for("react.memo"), type: () => null };

        expect(pickComponent({ default: memoised })).toBe(memoised);
    });

    it("falls back to a single capitalised component export, and only a single one", () => {
        const Chart = (): null => null;
        const Table = (): null => null;
        const helper = (): null => null;

        expect(pickComponent({ Chart, helper })).toBe(Chart);
        expect(pickComponent({ Chart, Table })).toBeUndefined();
    });

    it("finds nothing when no component is exported", () => {
        expect(pickComponent({ default: 42 })).toBeUndefined();
        expect(pickComponent({})).toBeUndefined();
    });
});
