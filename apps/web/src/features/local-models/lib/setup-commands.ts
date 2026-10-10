/**
 * Copy-paste commands for the local-model setup guide, with this site's
 * origin filled in.
 *
 * Ollama answers cross-origin requests only from origins in `OLLAMA_ORIGINS`
 * (its default list covers localhost and app/file schemes, never a public
 * https site), so the one thing a user must change is that variable — set
 * where the Ollama SERVER process reads it, which differs per OS: the menu-bar
 * app on macOS reads launchd's environment, the Linux service reads systemd's,
 * the Windows tray app reads the user environment.
 */

export type SetupOs = "linux" | "macos" | "windows";

export interface SetupStep {
    /** Shell text to copy. */
    command: string;
    id: string;
}

const SHELL_METACHAR_RE = /["'`$\\]/gu;

/**
 * Double-quoted for every shell here. A real `location.origin` never contains
 * quotes, `$`, backticks or backslashes; stripping them means a hostile value
 * cannot turn a copied command into something else.
 */
const quote = (value: string) => `"${value.replaceAll(SHELL_METACHAR_RE, "")}"`;

export const buildOllamaOriginSteps = (origin: string, os: SetupOs): SetupStep[] => {
    const value = quote(origin);

    switch (os) {
        case "macos": {
            return [
                { command: `launchctl setenv OLLAMA_ORIGINS ${value}`, id: "set" },
                // The menu-bar app only reads the variable at start.
                { command: "osascript -e 'quit app \"Ollama\"' && open -a Ollama", id: "restart" },
            ];
        }
        case "windows": {
            return [
                { command: `setx OLLAMA_ORIGINS ${value}`, id: "set" },
                // `setx` affects NEW processes only: the tray app must be restarted.
                {
                    command: String.raw`Stop-Process -Name "ollama*" -ErrorAction SilentlyContinue; Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"`,
                    id: "restart",
                },
            ];
        }
        default: {
            return [
                {
                    command: String.raw`sudo mkdir -p /etc/systemd/system/ollama.service.d && printf '[Service]\nEnvironment=${quote(`OLLAMA_ORIGINS=${origin}`)}\n' | sudo tee /etc/systemd/system/ollama.service.d/origins.conf`,
                    id: "set",
                },
                { command: "sudo systemctl daemon-reload && sudo systemctl restart ollama", id: "restart" },
            ];
        }
    }
};

/** For a server started by hand rather than as a service — any OS with a POSIX shell. */
export const buildOllamaServeCommand = (origin: string): string => `OLLAMA_ORIGINS=${quote(origin)} ollama serve`;

/** LM Studio's CLI: start the server with CORS on. The GUI equivalent is Developer → Settings → "Enable CORS". */
export const LM_STUDIO_SERVE_COMMAND = "lms server start --cors";

const WINDOWS_RE = /windows/iu;
const LINUX_RE = /linux|x11|cros/iu;
const ANDROID_RE = /android/iu;

/** Best guess at the visitor's OS for the default tab. */
export const detectSetupOs = (userAgent: string | undefined): SetupOs => {
    if (!userAgent) {
        return "macos";
    }

    if (WINDOWS_RE.test(userAgent)) {
        return "windows";
    }

    if (LINUX_RE.test(userAgent) && !ANDROID_RE.test(userAgent)) {
        return "linux";
    }

    return "macos";
};
