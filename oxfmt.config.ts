// @ts-check
import config from "@anolilab/oxfmt-config";

/**
 * Ported option-for-option from `.prettierrc.cjs` (which spreads `@anolilab/prettier-config`)
 * so oxfmt formats code and data files exactly as Prettier did. The shared preset covers the
 * common subset; the rest is set here.
 *
 * Markdown, CSS and HTML stay on Prettier (each project's `lint:oxfmt` runs it on those files):
 * oxfmt's Markdown output reflows lists and blockquotes.
 *
 * Ignore rules come from `.gitignore` and `.prettierignore`, which oxfmt reads by default.
 *
 * @type {import('oxfmt').OxfmtConfig}
 */
export default {
    ...config,
    arrowParens: "always",
    bracketSpacing: true,
    embeddedLanguageFormatting: "auto",
    endOfLine: "lf",
    htmlWhitespaceSensitivity: "css",
    insertFinalNewline: true,
    jsxSingleQuote: false,
    printWidth: 160,
    proseWrap: "preserve",
    quoteProps: "as-needed",
    semi: true,
    singleQuote: false,
    tabWidth: 4,
    trailingComma: "all",
    useTabs: false,
    vueIndentScriptAndStyle: false,
    // `sort-package-json` owns package.json key order. oxfmt sorts it by default, and Prettier never did.
    sortPackageJson: false,
    // Prettier ran prettier-plugin-tailwindcss with no config, so this is the same default algorithm.
    sortTailwindcss: true,
    // Prettier never formatted TOML. Markdown, CSS and HTML are Prettier's, so oxfmt skips them.
    ignorePatterns: ["**/*.toml", "**/*.md", "**/*.mdx", "**/*.css", "**/*.html"],
    overrides: [
        // oxfmt caps printWidth at 320 (Prettier allowed 1000); package.json lines never reach it.
        { files: ["package*.json"], options: { printWidth: 320 } },
        { files: ["*.yml", "*.yaml"], options: { singleQuote: false } },
        // Wrangler deploy configs: a trailing comma there depends on the parser being lenient.
        { files: ["*.jsonc"], options: { trailingComma: "none" } },
        // apps/web's prettier.config.js never had the jsonc override, so its wrangler.jsonc keeps trailing commas.
        { files: ["apps/web/**/*.jsonc"], options: { trailingComma: "all" } },
    ],
};
