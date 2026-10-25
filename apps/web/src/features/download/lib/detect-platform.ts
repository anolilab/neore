export type DesktopPlatform = "macos" | "windows" | "linux" | "other";
export type DesktopArch = "x64" | "arm64";

export interface DetectedPlatform {
    arch?: DesktopArch;
    platform: DesktopPlatform;
}

const IPHONE_OR_IPAD_RE = /iPhone|iPad|iPod/;
const ANDROID_RE = /Android/;
const WINDOWS_RE = /Windows/;
const MAC_RE = /Macintosh|Mac OS X/;
const LINUX_RE = /Linux|X11/;
const X64_RE = /x86_64|x86-64|amd64/i;
const ARM64_RE = /aarch64|arm64/i;

/**
 * Detects the desktop platform from a User-Agent string.
 *
 * Arch is reported only where the UA reliably tells:
 * - Linux: the kernel arch token (`x86_64` / `aarch64`) is present in most UAs.
 * - Windows and macOS: NOT reported. Apple Silicon Safari and Chromium on
 *   Windows on ARM send the x64 / Intel token, so a UA cannot tell them apart.
 *   Callers should offer every installer for these.
 *
 * Mobile UAs (iPhone/iPad, Android) map to "other" even though iPadOS and
 * Android carry the Mac and Linux tokens. iPadOS in desktop mode sends a Mac UA
 * with no mobile token, so the caller passes `navigator.maxTouchPoints`: a Mac
 * has none, an iPad has several.
 */
export const detectPlatform = (userAgent: string, maxTouchPoints = 0): DetectedPlatform => {
    if (IPHONE_OR_IPAD_RE.test(userAgent) || ANDROID_RE.test(userAgent)) {
        return { platform: "other" };
    }

    if (WINDOWS_RE.test(userAgent)) {
        return { platform: "windows" };
    }

    if (MAC_RE.test(userAgent)) {
        return maxTouchPoints > 1 ? { platform: "other" } : { platform: "macos" };
    }

    if (LINUX_RE.test(userAgent)) {
        if (ARM64_RE.test(userAgent)) {
            return { arch: "arm64", platform: "linux" };
        }

        if (X64_RE.test(userAgent)) {
            return { arch: "x64", platform: "linux" };
        }

        return { platform: "linux" };
    }

    return { platform: "other" };
};
