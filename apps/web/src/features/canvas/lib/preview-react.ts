/**
 * Live preview for React (JSX/TSX) code artifacts, at zero app-bundle cost:
 * everything the preview needs — transpiler, React, Tailwind — is loaded from a
 * CDN INSIDE the sandboxed preview frame (see `preview-shell.ts`), never by the
 * app.
 *
 * What the frame loads (pinned, so a CDN-side release can never change it):
 * - `@babel/standalone` and `@tailwindcss/browser` as classic scripts from
 *   jsDelivr, each with an SRI hash. They are immutable npm files, so the hash
 *   is stable for the version.
 * - React, ReactDOM and the allowlisted libraries as ES modules from esm.sh,
 *   through an import map. esm.sh (not jsDelivr's `+esm`) because its
 *   `?external=` keeps `react`/`react-dom` as bare specifiers, which the map
 *   points at ONE copy — two Reacts in one tree break every hook. These carry
 *   no SRI: esm.sh builds are not byte-stable across its own releases, and an
 *   entry hash would not cover the transitive module graph anyway.
 *
 * How it runs: the source is transpiled to CommonJS (TypeScript + automatic
 * JSX runtime), its `require` calls are checked against the allowlist, the
 * needed modules are `import()`ed, and the compiled code is injected as an
 * inline classic script wrapped in a factory — the frame's CSP allows inline
 * scripts but not `eval`, so injection is the only way to run it. Errors
 * surface through `console.error`, which the preview bridge forwards to the
 * canvas console panel.
 */

/** Pinned npm versions for everything the React preview frame loads. */
export const REACT_PREVIEW_VERSIONS = {
    babel: "7.29.9",
    clsx: "2.1.1",
    framerMotion: "13.4.1",
    lucideReact: "1.47.0",
    react: "19.3.0",
    recharts: "3.10.1",
    tailwind: "4.3.3",
} as const;

export interface PreviewScriptAsset {
    integrity: string;
    src: string;
}

export const BABEL_STANDALONE_SCRIPT: PreviewScriptAsset = {
    // eslint-disable-next-line no-secrets/no-secrets -- a public SRI hash
    integrity: "sha384-oLbIC13I/8DNBviftYPfOFQS5DC2WUmwk0SyIPmnzu1Ui+vYyATSSBJiJ5ETa4o/",
    src: `https://cdn.jsdelivr.net/npm/@babel/standalone@${REACT_PREVIEW_VERSIONS.babel}/babel.min.js`,
};

export const TAILWIND_BROWSER_SCRIPT: PreviewScriptAsset = {
    // eslint-disable-next-line no-secrets/no-secrets -- a public SRI hash
    integrity: "sha384-2ql948lIdLcGEE0/qxNiudyTjgauA3RDJERu5xW75kFCvSl5a9odyQYCb6tEjnmB",
    src: `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@${REACT_PREVIEW_VERSIONS.tailwind}/dist/index.global.js`,
};

const ESM_ORIGIN = "https://esm.sh";
const EXTERNAL_REACT = "external=react,react-dom";

/**
 * The only bare specifiers an artifact may import. Anything else is reported
 * in the console panel instead of failing as an opaque module-resolution error.
 */
export const REACT_PREVIEW_IMPORT_MAP: Readonly<Record<string, string>> = {
    clsx: `${ESM_ORIGIN}/clsx@${REACT_PREVIEW_VERSIONS.clsx}`,
    "framer-motion": `${ESM_ORIGIN}/framer-motion@${REACT_PREVIEW_VERSIONS.framerMotion}?${EXTERNAL_REACT}&bundle`,
    "lucide-react": `${ESM_ORIGIN}/lucide-react@${REACT_PREVIEW_VERSIONS.lucideReact}?${EXTERNAL_REACT}`,
    react: `${ESM_ORIGIN}/react@${REACT_PREVIEW_VERSIONS.react}`,
    "react-dom": `${ESM_ORIGIN}/react-dom@${REACT_PREVIEW_VERSIONS.react}?external=react`,
    "react-dom/client": `${ESM_ORIGIN}/react-dom@${REACT_PREVIEW_VERSIONS.react}/client?${EXTERNAL_REACT}`,
    "react/jsx-runtime": `${ESM_ORIGIN}/react@${REACT_PREVIEW_VERSIONS.react}/jsx-runtime`,
    recharts: `${ESM_ORIGIN}/recharts@${REACT_PREVIEW_VERSIONS.recharts}?${EXTERNAL_REACT}&bundle`,
};

/** JSON for embedding in a `<script>`: `<` is escaped so the payload can never close the element. */
const toScriptJson = (value: unknown): string => JSON.stringify(value).replaceAll("<", String.raw`\u003c`);

/**
 * Pure helpers the frame runner uses, kept as a separate string so the tests
 * can evaluate the exact code the frame runs.
 *
 * - `findRequires`: the specifiers Babel's CommonJS output `require`s.
 * - `unsupportedImports`: those not in the import map.
 * - `pickComponent`: the default export, else `App` (exported or not), else
 *   the only capitalised function export.
 */
export const REACT_PREVIEW_HELPERS = String.raw`
function findRequires(code) {
  var found = [];
  var pattern = /\brequire\((["'])([^"'\\]+)\1\)/g;
  var match;
  while ((match = pattern.exec(code)) !== null) {
    if (found.indexOf(match[2]) === -1) found.push(match[2]);
  }
  return found;
}
function unsupportedImports(specifiers, allowed) {
  return specifiers.filter(function (specifier) { return allowed.indexOf(specifier) === -1; });
}
function isComponent(value) {
  if (typeof value === "function") return true;
  return typeof value === "object" && value !== null && typeof value.$$typeof === "symbol";
}
function pickComponent(moduleExports, app) {
  if (moduleExports && isComponent(moduleExports.default)) return moduleExports.default;
  if (isComponent(app)) return app;
  if (!moduleExports) return undefined;
  var named = Object.keys(moduleExports).filter(function (key) {
    return key !== "default" && /^[A-Z]/.test(key) && isComponent(moduleExports[key]);
  });
  return named.length === 1 ? moduleExports[named[0]] : undefined;
}
`;

const buildRunnerScript = (source: string): string => String.raw`(function () {
  var SOURCE = ${toScriptJson(source)};
  var ALLOWED = ${toScriptJson(Object.keys(REACT_PREVIEW_IMPORT_MAP))};
${REACT_PREVIEW_HELPERS}
  function fail() { console.error.apply(console, arguments); }
  if (typeof Babel === "undefined") {
    fail("The preview could not load its transpiler (network error or failed integrity check).");
    return;
  }
  var compiled;
  try {
    compiled = Babel.transform(SOURCE, {
      filename: "artifact.tsx",
      sourceType: "module",
      presets: [["typescript", { isTSX: true, allExtensions: true }], ["react", { runtime: "automatic" }]],
      plugins: ["transform-modules-commonjs"]
    }).code;
  } catch (error) {
    fail("Could not compile the component:\n" + (error && error.message ? error.message : error));
    return;
  }
  var specifiers = findRequires(compiled);
  var unsupported = unsupportedImports(specifiers, ALLOWED);
  if (unsupported.length > 0) {
    fail("Unsupported import" + (unsupported.length > 1 ? "s" : "") + ": " + unsupported.map(function (s) { return JSON.stringify(s); }).join(", ") +
      ". The preview runs a single file and can import only: " + ALLOWED.join(", ") + ".");
    return;
  }
  var needed = specifiers.slice();
  ["react", "react-dom/client"].forEach(function (s) { if (needed.indexOf(s) === -1) needed.push(s); });
  Promise.all(needed.map(function (s) { return import(s); })).then(function (namespaces) {
    var modules = {};
    needed.forEach(function (s, i) {
      // Babel's interop reads a module WITHOUT __esModule as { default: module }.
      modules[s] = Object.assign({}, namespaces[i], { __esModule: true });
    });
    window.__neoreArtifact = function (factory) {
      delete window.__neoreArtifact;
      var module = { exports: {} };
      var app;
      try {
        app = factory(function (s) { return modules[s]; }, module, module.exports);
      } catch (error) {
        fail(error);
        return;
      }
      var Component = pickComponent(module.exports, app);
      if (!Component) {
        fail("Nothing to render: export a React component as the default export, or name it App.");
        return;
      }
      var report = function (error, info) {
        fail(error, info && info.componentStack ? "\nComponent stack:" + info.componentStack : "");
      };
      modules["react-dom/client"].createRoot(document.getElementById("root"), { onCaughtError: report, onUncaughtError: report })
        .render(modules.react.createElement(Component));
    };
    var script = document.createElement("script");
    script.textContent = "window.__neoreArtifact(function (require, module, exports) {" + compiled +
      "\n;return typeof App === \"undefined\" ? undefined : App;\n});";
    document.body.appendChild(script);
  }, function (error) {
    fail("Could not load the preview's libraries (network error or CDN outage):", error);
  });
})();`;

const scriptTag = ({ integrity, src }: PreviewScriptAsset): string => `<script src="${src}" integrity="${integrity}" crossorigin="anonymous"></script>`;

/**
 * The body of the React preview document; `buildPreviewSrcdoc` prepends the
 * CSP, `<base>` and console bridge. The import map comes first because a map
 * added after the first module load is ignored.
 */
export const buildReactPreviewDocument = (source: string): string =>
    [
        `<script type="importmap">${toScriptJson({ imports: REACT_PREVIEW_IMPORT_MAP })}</script>`,
        scriptTag(TAILWIND_BROWSER_SCRIPT),
        scriptTag(BABEL_STANDALONE_SCRIPT),
        "<style>html,body{margin:0;min-height:100%}</style>",
        '<div id="root"></div>',
        `<script>${buildRunnerScript(source)}</script>`,
    ].join("");
