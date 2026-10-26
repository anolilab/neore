// Flips the Electron fuses on the packed binary, before signing. electron-builder
// writes the ASAR integrity hash itself (it is read at runtime), so the
// EmbeddedAsarIntegrityValidation fuse is safe to turn on here.
const path = require("node:path");

/** @param {import("electron-builder").AfterPackContext} context */
module.exports = async function afterPack(context) {
    const { flipFuses, FuseV1Options, FuseVersion } = await import("@electron/fuses");
    const { appOutDir, electronPlatformName, packager } = context;
    // Linux names the binary after `executableName`; the other platforms after the product.
    const name = electronPlatformName === "linux" ? packager.executableName : packager.appInfo.productFilename;
    const extension = { darwin: ".app", mas: ".app", win32: ".exe" }[electronPlatformName] ?? "";

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
