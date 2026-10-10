import type { NodePlopAPI } from "plop";

export default function (plop: NodePlopAPI): void {
    plop.setGenerator("service", {
        description: "Scaffold a new Cloudflare Worker microservice",
        prompts: [
            {
                message: 'Service name (kebab-case, e.g. "image-resizer"):',
                name: "name",
                type: "input",
                validate: (value: string) => {
                    if (!value) return "Service name is required";
                    if (!/^[a-z][a-z0-9-]*$/.test(value)) return "Must be kebab-case (lowercase letters, numbers, hyphens)";
                    return true;
                },
            },
            {
                message: "Service description:",
                name: "description",
                type: "input",
            },
            {
                default: "8787",
                message: "Port for local dev (default 8787):",
                name: "port",
                type: "input",
            },
        ],
        actions: [
            {
                path: "services/{{kebabCase name}}/package.json",
                templateFile: "tools/generators/service/templates/package.json.hbs",
                type: "add",
            },
            {
                path: "services/{{kebabCase name}}/tsconfig.json",
                templateFile: "tools/generators/service/templates/tsconfig.json.hbs",
                type: "add",
            },
            {
                path: "services/{{kebabCase name}}/wrangler.jsonc",
                templateFile: "tools/generators/service/templates/wrangler.jsonc.hbs",
                type: "add",
            },
            {
                path: "services/{{kebabCase name}}/.gitignore",
                templateFile: "tools/generators/service/templates/.gitignore.hbs",
                type: "add",
            },
            {
                path: "services/{{kebabCase name}}/src/index.ts",
                templateFile: "tools/generators/service/templates/src/index.ts.hbs",
                type: "add",
            },
            {
                path: "services/{{kebabCase name}}/src/middleware/auth.ts",
                templateFile: "tools/generators/service/templates/src/middleware/auth.ts.hbs",
                type: "add",
            },
            {
                path: "services/{{kebabCase name}}/src/middleware/security.ts",
                templateFile: "tools/generators/service/templates/src/middleware/security.ts.hbs",
                type: "add",
            },
            {
                path: "services/{{kebabCase name}}/src/middleware/logger.ts",
                templateFile: "tools/generators/service/templates/src/middleware/logger.ts.hbs",
                type: "add",
            },
            {
                path: "services/{{kebabCase name}}/src/routes/health.ts",
                templateFile: "tools/generators/service/templates/src/routes/health.ts.hbs",
                type: "add",
            },
            {
                path: "services/{{kebabCase name}}/src/lib/health-check.ts",
                templateFile: "tools/generators/service/templates/src/lib/health-check.ts.hbs",
                type: "add",
            },
            () =>
                [
                    "",
                    "Next steps:",
                    "  1. Add {{name}} to pnpm-workspace.yaml packages list (if not using services/*)",
                    "  2. Run `pnpm install` from the root",
                    '  3. Add `"dev:{{name}}": "pnpm --filter={{name}} dev"` to root package.json scripts',
                    "  4. Generate and set PARSER_SIGNING_SECRET: pnpm env:generate-signing-secret | wrangler secret put PARSER_SIGNING_SECRET --cwd services/{{name}}",
                    "",
                ].join("\n"),
        ],
    });
}
