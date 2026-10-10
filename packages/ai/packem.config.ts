import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

export default defineConfig({
    externals: [
        "@ai-sdk/groq",
        "@ai-sdk/provider",
        "@ai-sdk/react",
        "@ai-sdk/ui-utils",
        "@ai-sdk/xai",
        "@openrouter/ai-sdk-provider",
        "@requesty/ai-sdk",
        "@visulima/iso-locale",
        "ai",
        "ollama-ai-provider-v2",
        "zod",
    ],
    node10Compatibility: {
        typeScriptVersion: ">=5.0",
        writeToPackageJson: true,
    },
    runtime: "node",
    transformer,
    validation: {
        dependencies: {
            unused: {
                exclude: ["@ai-sdk/react", "@ai-sdk/ui-utils", "ollama-ai-provider-v2"],
            },
        },
    },
});
