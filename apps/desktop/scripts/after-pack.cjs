// Flips the Electron fuses on the packed binary, before signing. electron-builder
// writes the ASAR integrity hash itself (it is read at runtime), so the
// EmbeddedAsarIntegrityValidation fuse is safe to turn on here.
//
// Also makes node-pty's `spawn-helper` (macOS prebuilds only) executable: its tarball ships the file without
// the execute bit, and a terminal cannot start a shell without it. This runs before signing, so the signed app keeps the mode.
const { chmodSync, readdirSync } = require("node:fs");
const path = require("node:path");

/** @param {string} directory @returns {string[]} */
const findSpawnHelpers = (directory) =>
    readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name === "spawn-helper")
        .map((entry) => path.join(entry.parentPath, entry.name));

/** @param {import("electron-builder").AfterPackContext} context */
module.exports = async function afterPack(context) {
    const { flipFuses, FuseV1Options, FuseVersion } = await import("@electron/fuses");
    const { appOutDir, electronPlatformName, packager } = context;
    // Linux names the binary after `executableName`; the other platforms after the product.
    const name = electronPlatformName === "linux" ? packager.executableName : packager.appInfo.productFilename;
    const extension = { darwin: ".app", mas: ".app", win32: ".exe" }[electronPlatformName] ?? "";

    if (electronPlatformName !== "win32") {
        for (const helper of findSpawnHelpers(appOutDir)) {
            chmodSync(helper, 0o755);
        }
    }

    await flipFuses(path.join(appOutDir, `${name}${extension}`), {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    });
};
