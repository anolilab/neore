import { describe, expect, it } from "vitest";

import { buildOllamaOriginSteps, buildOllamaServeCommand, detectSetupOs } from "./setup-commands";

const ORIGIN = "https://app.example.com";

describe(buildOllamaOriginSteps, () => {
    it("sets the variable where each OS's Ollama server reads it, then restarts it", () => {
        expect.assertions(4);
        expect(buildOllamaOriginSteps(ORIGIN, "macos")[0]?.command).toBe('launchctl setenv OLLAMA_ORIGINS "https://app.example.com"');
        expect(buildOllamaOriginSteps(ORIGIN, "windows")[0]?.command).toBe('setx OLLAMA_ORIGINS "https://app.example.com"');
        expect(buildOllamaOriginSteps(ORIGIN, "linux")[0]?.command).toContain('Environment="OLLAMA_ORIGINS=https://app.example.com"');
        expect(buildOllamaOriginSteps(ORIGIN, "linux")[1]?.command).toBe("sudo systemctl daemon-reload && sudo systemctl restart ollama");
    });

    it("cannot be broken out of by a quote in the origin", () => {
        expect.assertions(1);
        expect(buildOllamaOriginSteps("https://a.example\"; $(rm -rf ~) `x` '", "macos")[0]?.command).toBe(
            'launchctl setenv OLLAMA_ORIGINS "https://a.example; (rm -rf ~) x "',
        );
    });
});

describe(buildOllamaServeCommand, () => {
    it("scopes the variable to one foreground server", () => {
        expect.assertions(1);
        expect(buildOllamaServeCommand(ORIGIN)).toBe('OLLAMA_ORIGINS="https://app.example.com" ollama serve');
    });
});

describe(detectSetupOs, () => {
    it.each([
        ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36", "windows"],
        ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36", "linux"],
        ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36", "macos"],
        ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36", "macos"],
    ])("%s → %s", (userAgent, os) => {
        expect.assertions(1);
        expect(detectSetupOs(userAgent)).toBe(os);
    });
});
