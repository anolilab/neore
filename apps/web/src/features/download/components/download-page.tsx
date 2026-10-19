"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { useMemo, useSyncExternalStore } from "react";

import LandingFooter from "@/features/marketing/components/landing-footer";
import Navbar from "@/features/marketing/components/navbar-menu";
import { trackEvent } from "@/lib/analytics";

import type { DesktopArch, DesktopPlatform } from "../lib/detect-platform";
import { detectPlatform } from "../lib/detect-platform";

// Installers are published on the GitHub release created by .github/workflows/desktop.yml.
// A release starts as a draft, which is not visible on the public releases page, so until
// it is published the list below is empty. The URL itself never changes between releases.
const RELEASES_URL = "https://github.com/anolilab/neore/releases";

interface Installer {
    arch: DesktopArch;
    files: string;
    platform: Exclude<DesktopPlatform, "other">;
}

const PLATFORM_NAMES: Record<Exclude<DesktopPlatform, "other">, string> = {
    linux: "Linux",
    macos: "macOS",
    windows: "Windows",
};

const INSTALLERS: Installer[] = [
    { arch: "arm64", files: "Apple Silicon (.dmg)", platform: "macos" },
    { arch: "x64", files: "Intel (.dmg)", platform: "macos" },
    { arch: "x64", files: "x64 (.exe)", platform: "windows" },
    { arch: "arm64", files: "ARM64 (.exe)", platform: "windows" },
    { arch: "x64", files: "x64 (.AppImage, .deb)", platform: "linux" },
    { arch: "arm64", files: "ARM64 (.AppImage, .deb)", platform: "linux" },
];

const noopSubscribe = (): (() => void) => () => {};
const getServerUserAgent = (): string => "";
const getClientUserAgent = (): string => navigator.userAgent;

const DownloadPage = () => {
    const { t } = useLingui();

    // Server render has no UA, so it renders the "other" layout and the client swaps in the
    // detected platform after hydration (useSyncExternalStore keeps the UA a stable string).
    const userAgent = useSyncExternalStore(noopSubscribe, getClientUserAgent, getServerUserAgent);
    const detected = useMemo(() => detectPlatform(userAgent), [userAgent]);

    const primaryPlatform = detected.platform === "other" ? null : detected.platform;

    return (
        <div className="bg-brand-white text-brand-obsidian min-h-screen">
            <Navbar theme="light" />

            <main className="border-brand-silver container mx-auto border-x">
                <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-24 lg:px-10">
                    <p className="text-primary mb-4 font-mono text-xs font-medium tracking-widest uppercase">
                        <Trans>Desktop</Trans>
                    </p>
                    <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">
                        <Trans>Download Neore for desktop</Trans>
                    </h1>
                    <p className="text-brand-graphite mb-10 leading-relaxed">
                        <Trans>
                            The desktop app runs on macOS, Windows and Linux. Installers are attached to a desktop release on GitHub, and they appear there once
                            that release is published.
                        </Trans>
                    </p>

                    {primaryPlatform ? (
                        <div className="mb-12">
                            <a
                                className={cn(buttonVariants({ size: "lg" }))}
                                href={RELEASES_URL}
                                onClick={() => {
                                    trackEvent("desktop_download_clicked", {
                                        arch: detected.arch ?? "unknown",
                                        platform: primaryPlatform,
                                    });
                                }}
                            >
                                {t`Download for ${PLATFORM_NAMES[primaryPlatform]}`}
                            </a>
                            {detected.arch === undefined && (
                                <p className="text-brand-graphite mt-3 text-sm">
                                    <Trans>Your browser does not say which processor you have, so choose the matching installer below.</Trans>
                                </p>
                            )}
                        </div>
                    ) : null}

                    <section aria-labelledby="all-installers-heading">
                        <h2 className="mb-4 text-2xl font-semibold tracking-tight" id="all-installers-heading">
                            <Trans>All installers</Trans>
                        </h2>
                        <ul className="divide-brand-silver border-brand-silver divide-y rounded-md border">
                            {INSTALLERS.map((installer) => (
                                <li className="flex items-center justify-between gap-4 px-4 py-3" key={`${installer.platform}-${installer.arch}`}>
                                    <span className="text-sm">
                                        <span className="font-medium">{PLATFORM_NAMES[installer.platform]}</span>
                                        <span className="text-brand-graphite"> · {installer.files}</span>
                                    </span>
                                    <a
                                        className="text-primary text-sm font-medium hover:underline"
                                        href={RELEASES_URL}
                                        onClick={() => {
                                            trackEvent("desktop_download_clicked", {
                                                arch: installer.arch,
                                                platform: installer.platform,
                                            });
                                        }}
                                    >
                                        <Trans>Download</Trans>
                                        <span className="sr-only">
                                            {" "}
                                            {PLATFORM_NAMES[installer.platform]} {installer.files}
                                        </span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                        <p className="text-brand-graphite mt-4 text-sm">
                            <Trans>
                                Downloads open the GitHub releases page. If no installers are listed there yet, the desktop release has not been published.
                            </Trans>
                        </p>
                    </section>
                </div>
            </main>

            <LandingFooter />
        </div>
    );
};

export default DownloadPage;
