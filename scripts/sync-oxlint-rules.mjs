/**
 * Writes `.oxlintrc.json` from ESLint's own configuration, so oxlint enforces only what ESLint
 * enforces and can gate CI without reporting code ESLint accepts.
 *
 * ESLint stays the authority. For every project with a `lint:eslint` script (and the root deploy
 * files), this asks ESLint which files it lints and how each rule is set on each of them. A rule
 * that oxlint can run is enabled only when ESLint sets it the same way (severity and options) on
 * every file it lints, or, for a plugin rule, on every file that loads the plugin. Everything else
 * is off, every oxlint category is off, and the files ESLint does not lint are ignored.
 *
 * Run it after ESLint's config or `@anolilab/eslint-config` changes, or when the oxlint job flags
 * code that ESLint accepts (add the rule to OXLINT_DIFFERS below):
 *
 *     pnpm lint:oxlint:sync
 *
 * Collecting runs one child process per project from inside that project: the shared ESLint
 * config picks its plugins from the current directory's package.json.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINTABLE = ["*.js", "*.jsx", "*.mjs", "*.cjs", "*.ts", "*.tsx", "*.mts", "*.cts"];

/**
 * Rules ESLint enforces everywhere whose oxlint version still reports code ESLint accepts, or
 * rejects ESLint's options. ESLint enforces them; oxlint leaves them off.
 * @type {Record<string, string>}
 */
const OPTIONS_REJECTED = "oxlint rejects the options ESLint sets";
const REPORTS_ACCEPTED_CODE = "oxlint reports code that ESLint accepts";
const OXLINT_DIFFERS = {
    "import/no-named-as-default": REPORTS_ACCEPTED_CODE,
    "jsx-a11y/role-has-required-aria-props": REPORTS_ACCEPTED_CODE,
    "sonarjs/no-os-command-from-path": REPORTS_ACCEPTED_CODE,
    "unicorn/explicit-length-check": REPORTS_ACCEPTED_CODE,
    "unicorn/no-immediate-mutation": REPORTS_ACCEPTED_CODE,
    "unicorn/no-process-exit": REPORTS_ACCEPTED_CODE,
    "unicorn/no-useless-spread": REPORTS_ACCEPTED_CODE,
    "unicorn/prefer-export-from": REPORTS_ACCEPTED_CODE,
    "unicorn/prefer-global-this": REPORTS_ACCEPTED_CODE,
    "unicorn/prefer-modern-dom-apis": REPORTS_ACCEPTED_CODE,
    "unicorn/prefer-number-properties": REPORTS_ACCEPTED_CODE,
    "unicorn/prefer-string-raw": REPORTS_ACCEPTED_CODE,
    "unicorn/prefer-ternary": REPORTS_ACCEPTED_CODE,
    "unicorn/prefer-top-level-await": REPORTS_ACCEPTED_CODE,
    "unicorn/prefer-type-error": REPORTS_ACCEPTED_CODE,
    "unicorn/require-module-specifiers": REPORTS_ACCEPTED_CODE,
    "unicorn/text-encoding-identifier-case": REPORTS_ACCEPTED_CODE,
    "preserve-caught-error": OPTIONS_REJECTED,
    "unicorn/escape-case": OPTIONS_REJECTED,
    "unicorn/no-empty-file": OPTIONS_REJECTED,
    "unicorn/no-unreadable-array-destructuring": OPTIONS_REJECTED,
    "unicorn/prefer-add-event-listener": OPTIONS_REJECTED,
    "unicorn/prefer-array-find": OPTIONS_REJECTED,
    "unicorn/prefer-array-flat": OPTIONS_REJECTED,
    "unicorn/prefer-set-has": OPTIONS_REJECTED,
};

/** oxlint's rule scopes and the ESLint rule prefixes that name the same rules. */
const SCOPE_PREFIXES = {
    eslint: [""],
    import: ["import/", "import-x/"],
    jest: ["jest/"],
    jsdoc: ["jsdoc/"],
    jsx_a11y: ["jsx-a11y/"],
    nextjs: ["@next/next/"],
    node: ["n/", "node/"],
    oxc: [],
    promise: ["promise/"],
    react: ["react/", "react-hooks/"],
    react_perf: ["react-perf/"],
    typescript: ["@typescript-eslint/"],
    unicorn: ["unicorn/"],
    vitest: ["vitest/"],
    vue: ["vue/"],
};

/** ESLint plugins oxlint loads as JS plugins, by their ESLint rule prefix. */
const JS_PLUGINS = {
    "@eslint-community/eslint-comments/": { name: "eslint-comments", specifier: "@eslint-community/eslint-plugin-eslint-comments" },
    "eslint-comments/": { name: "eslint-comments", specifier: "@eslint-community/eslint-plugin-eslint-comments" },
    "no-secrets/": { name: "no-secrets", specifier: "eslint-plugin-no-secrets" },
    "regexp/": { name: "regexp", specifier: "eslint-plugin-regexp" },
    "sonarjs/": { name: "sonarjs", specifier: "eslint-plugin-sonarjs" },
};

const severity = (value) => {
    const level = Array.isArray(value) ? value[0] : value;

    if (level === 2 || level === "error") {
        return "error";
    }

    return level === 1 || level === "warn" ? "warn" : "off";
};

const pluginOf = (rule) => (rule.includes("/") ? rule.slice(0, rule.lastIndexOf("/")) : "");

/** Child mode: write ESLint's view of the project in the current directory to `out`. */
const collect = async (out, only) => {
    const require = createRequire(join(process.cwd(), "package.json"));
    const { ESLint } = require("eslint");
    const eslint = new ESLint({ cwd: process.cwd() });
    const tracked = execFileSync("git", ["ls-files", "-z", "--", ...LINTABLE], { encoding: "utf8", maxBuffer: 1 << 28 })
        .split("\0")
        .filter((file) => file && (only.length === 0 || only.includes(file)));
    const prefix = relative(ROOT, process.cwd());
    const view = { files: [], plugins: {}, rules: {} };

    for (const file of tracked) {
        const absolute = join(process.cwd(), file);

        if (await eslint.isPathIgnored(absolute)) {
            continue;
        }

        const config = await eslint.calculateConfigForFile(absolute);

        view.files.push(prefix ? `${prefix}/${file}` : file);

        for (const plugin of ["", ...Object.keys(config.plugins ?? {})]) {
            view.plugins[plugin] = (view.plugins[plugin] ?? 0) + 1;
        }

        for (const [rule, value] of Object.entries(config.rules ?? {})) {
            const key = `${severity(value)}|${JSON.stringify(Array.isArray(value) ? value.slice(1) : [])}`;

            view.rules[rule] ??= {};
            view.rules[rule][key] = (view.rules[rule][key] ?? 0) + 1;
        }
    }

    // A file, not stdout: the shared ESLint config prints its own notices there.
    writeFileSync(out, JSON.stringify(view));
};

/** The projects ESLint lints, with the files each one is limited to (none: all). */
const eslintProjects = () => {
    const rootPackage = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deployFiles = rootPackage.scripts["lint:eslint:deploy"].split(" ").slice(1);
    const projects = execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { cwd: ROOT, encoding: "utf8" });

    return [
        ...JSON.parse(projects)
            .filter((project) => project.path !== ROOT)
            .filter((project) => JSON.parse(readFileSync(join(project.path, "package.json"), "utf8")).scripts?.["lint:eslint"])
            .map((project) => ({ dir: project.path, only: [] }))
            .toSorted((a, b) => a.dir.localeCompare(b.dir)),
        { dir: ROOT, only: deployFiles },
    ];
};

/** Collapses the tracked files ESLint does not lint into the fewest directory or file patterns. */
const ignorePatterns = (linted) => {
    const git = (...args) =>
        execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 })
            .split("\0")
            .filter(Boolean);
    // Tracked symlinks too: oxlint follows them (into .agents/ from .claude/skills/), ESLint does not.
    const symlinks = git("ls-files", "-z", "-s")
        .filter((entry) => entry.startsWith("120000 "))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1));
    const tracked = [...git("ls-files", "-z", "--", ...LINTABLE), ...symlinks];
    const lintedDirs = new Set();

    for (const file of linted) {
        for (let dir = dirname(file); dir !== "."; dir = dirname(dir)) {
            lintedDirs.add(dir);
        }
    }

    const patterns = new Set();

    for (const file of tracked) {
        if (linted.has(file)) {
            continue;
        }

        // The outermost directory with nothing ESLint lints in it, else the file itself.
        const parts = file.split("/");
        let pattern = file;

        for (let depth = 1; depth < parts.length; depth++) {
            const dir = parts.slice(0, depth).join("/");

            if (!lintedDirs.has(dir)) {
                pattern = `${dir}/**`;
                break;
            }
        }

        patterns.add(pattern);
    }

    return [...patterns].toSorted();
};

const main = () => {
    const scratch = mkdtempSync(join(tmpdir(), "oxlint-sync-"));
    const views = eslintProjects().map(({ dir, only }, index) => {
        const out = join(scratch, `${index}.json`);

        process.stderr.write(`ESLint view of ${relative(ROOT, dir) || "."}\n`);
        execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--collect", out, ...only], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });

        return JSON.parse(readFileSync(out, "utf8"));
    });

    const linted = new Set(views.flatMap((view) => view.files));
    const loaded = (plugin) => views.reduce((sum, view) => sum + (view.plugins[plugin] ?? 0), 0);

    /** ESLint's single setting for a rule across every file it applies to, or undefined. */
    const uniform = (eslintName) => {
        const states = {};

        for (const view of views) {
            for (const [key, count] of Object.entries(view.rules[eslintName] ?? {})) {
                states[key] = (states[key] ?? 0) + count;
            }
        }

        const keys = Object.keys(states);

        if (keys.length !== 1 || states[keys[0]] !== loaded(pluginOf(eslintName))) {
            return undefined;
        }

        const [level, options] = keys[0].split("|");

        return level === "off" ? undefined : [level, ...JSON.parse(options)];
    };

    // Against an empty config: the list of rules oxlint has must not depend on the file being rewritten.
    const emptyConfig = join(scratch, "empty.json");

    writeFileSync(emptyConfig, "{}");

    const oxlintRules = JSON.parse(
        execFileSync(join(ROOT, "node_modules/.bin/oxlint"), ["--rules", "--format=json", "--config", emptyConfig], { cwd: ROOT, encoding: "utf8" }),
    );
    const rules = {};
    const typeAware = new Set(
        oxlintRules.filter((rule) => rule.type_aware).map(({ scope, value }) => (scope === "eslint" ? value : `${scope.replaceAll("_", "-")}/${value}`)),
    );
    const plugins = new Set();
    const jsPlugins = new Map();

    const enable = (oxlintName, eslintName, onEnable) => {
        if (OXLINT_DIFFERS[oxlintName]) {
            return;
        }

        const setting = uniform(eslintName);

        if (setting) {
            rules[oxlintName] = setting.length === 1 ? setting[0] : setting;
            onEnable();
        }
    };

    for (const { scope, value } of oxlintRules) {
        const oxlintName = scope === "eslint" ? value : `${scope.replaceAll("_", "-")}/${value}`;

        for (const prefix of SCOPE_PREFIXES[scope] ?? []) {
            enable(oxlintName, prefix + value, () => plugins.add(scope.replaceAll("_", "-")));
        }
    }

    const eslintRuleNames = new Set(views.flatMap((view) => Object.keys(view.rules)));

    for (const eslintName of eslintRuleNames) {
        for (const [prefix, plugin] of Object.entries(JS_PLUGINS)) {
            if (eslintName.startsWith(prefix)) {
                enable(`${plugin.name}/${eslintName.slice(prefix.length)}`, eslintName, () => jsPlugins.set(plugin.name, plugin));
            }
        }
    }

    plugins.delete("eslint");

    const sortedRules = Object.fromEntries(Object.entries(rules).toSorted(([a], [b]) => a.localeCompare(b)));
    const config = {
        $schema: "./node_modules/oxlint/configuration_schema.json",
        plugins: [...plugins].toSorted(),
        jsPlugins: [...jsPlugins.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
        categories: Object.fromEntries(
            ["correctness", "nursery", "pedantic", "perf", "restriction", "style", "suspicious"].map((category) => [category, "off"]),
        ),
        // Type-aware rules need built packages and codegen; leave the mode off unless one is enabled.
        options: { typeAware: Object.keys(sortedRules).some((rule) => typeAware.has(rule)) },
        ignorePatterns: ignorePatterns(linted),
        rules: sortedRules,
    };
    const header = "// Generated by scripts/sync-oxlint-rules.mjs from ESLint's config (`pnpm lint:oxlint:sync`). Do not edit by hand.\n";

    writeFileSync(join(ROOT, ".oxlintrc.json"), header + JSON.stringify(config, undefined, 4) + "\n");
    // In the repository's own format, so a sync leaves nothing for the format check.
    execFileSync(join(ROOT, "node_modules/.bin/oxfmt"), [".oxlintrc.json"], { cwd: ROOT, stdio: "ignore" });
    rmSync(scratch, { force: true, recursive: true });
    process.stderr.write(`${Object.keys(sortedRules).length} rules enabled, ${linted.size} files linted by ESLint\n`);
};

if (process.argv[2] === "--collect") {
    await collect(process.argv[3], process.argv.slice(4));
} else {
    main();
}
