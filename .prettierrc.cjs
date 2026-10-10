const config = require("@anolilab/prettier-config");

module.exports = {
    ...config,
    plugins: ["prettier-plugin-tailwindcss"],
    overrides: [
        ...(config.overrides ?? []),
        {
            // The shared config sets `trailingComma: "all"`, which prettier applies
            // to .jsonc too. Two problems: `jsonc/comma-dangle` rejects it, and
            // these are Wrangler deploy configs — a trailing comma there depends on
            // the parser being lenient. Not worth finding out during a deploy.
            files: "*.jsonc",
            options: { trailingComma: "none" },
        },
    ],
};
