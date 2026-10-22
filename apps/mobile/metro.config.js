const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

// The workspace packages (`@neore/client-runtime`, `@neore/backend`) are TypeScript
// source behind `exports`, so Metro must watch the monorepo root and follow symlinks.
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules"), path.resolve(workspaceRoot, "node_modules")];

module.exports = config;
