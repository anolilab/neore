#!/usr/bin/env node
/**
 * Generate encryption key for data encryption.
 *
 * Note: this writes only ENCRYPTION_KEY. `pnpm dev:setup` generates
 * BETTER_AUTH_SECRET and the other backend keys in `backend/.dev.vars`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const generateEncryptionKey = () => {
    const key = crypto.randomBytes(32);

    return key.toString("base64");
};

const checkKeyInEnvironment = (filePath, keyName) => {
    if (!fs.existsSync(filePath)) {
        return false;
    }

    const environmentContent = fs.readFileSync(filePath, "utf8");
    const regex = new RegExp(`^${keyName}=.+$`, "m");

    return regex.test(environmentContent);
};

const updateEnvironmentFile = (filePath, keyName, keyValue) => {
    let environmentContent = "";

    if (fs.existsSync(filePath)) {
        environmentContent = fs.readFileSync(filePath, "utf8");
    }

    const keyRegex = new RegExp(`^${keyName}=.*$`, "m");

    if (keyRegex.test(environmentContent)) {
        const emptyKeyRegex = new RegExp(`^${keyName}=$`, "m");

        if (emptyKeyRegex.test(environmentContent)) {
            environmentContent = environmentContent.replace(emptyKeyRegex, `${keyName}=${keyValue}`);
            console.log(`✅ Updated ${keyName} in ${path.basename(filePath)}`);
        } else {
            console.log(`ℹ️  ${keyName} already has a value in ${path.basename(filePath)}`);

            return false;
        }
    } else {
        if (environmentContent && !environmentContent.endsWith("\n")) {
            environmentContent += "\n";
        }

        environmentContent += `${keyName}=${keyValue}\n`;

        console.log(`✅ Added ${keyName} to ${path.basename(filePath)}`);
    }

    fs.writeFileSync(filePath, environmentContent);

    return true;
};

(() => {
    console.log("🔐 Generating encryption keys...\n");

    // `backend/.dev.vars`, the file the backend reads. Writing anywhere else
    // would report success while the key went nowhere.
    const backendEnvPath = path.join(rootDir, "backend", ".dev.vars");

    // Process ENCRYPTION_KEY
    console.log("📝 Processing ENCRYPTION_KEY...");

    if (checkKeyInEnvironment(backendEnvPath, "ENCRYPTION_KEY")) {
        console.log("ℹ️  ENCRYPTION_KEY already exists in backend/.dev.vars with a value");
        console.log("💡 If you want to regenerate, remove the existing value first\n");
    } else {
        const key = generateEncryptionKey();

        console.log("Generated ENCRYPTION_KEY:");
        console.log("========================");
        console.log(key);
        console.log("========================");

        const updated = updateEnvironmentFile(backendEnvPath, "ENCRYPTION_KEY", key);

        if (updated) {
            console.log("✅ ENCRYPTION_KEY added to backend/.dev.vars\n");
        }

        console.log("\n📁 Environment variable format:");
        console.log("========================");
        console.log(`ENCRYPTION_KEY=${key}`);
        console.log("========================");
    }

    // Process CONNECTOR_ENCRYPTION_KEY (for connector OAuth tokens)
    console.log("\n📝 Processing CONNECTOR_ENCRYPTION_KEY...");

    if (checkKeyInEnvironment(backendEnvPath, "CONNECTOR_ENCRYPTION_KEY")) {
        console.log("ℹ️  CONNECTOR_ENCRYPTION_KEY already exists in backend/.dev.vars with a value");
        console.log("💡 If you want to regenerate, remove the existing value first\n");
    } else {
        const connectorKey = crypto.randomBytes(32).toString("hex");

        console.log("Generated CONNECTOR_ENCRYPTION_KEY (hex):");
        console.log("========================");
        console.log(connectorKey);
        console.log("========================");

        const updated = updateEnvironmentFile(backendEnvPath, "CONNECTOR_ENCRYPTION_KEY", connectorKey);

        if (updated) {
            console.log("✅ CONNECTOR_ENCRYPTION_KEY added to backend/.dev.vars\n");
        }

        console.log("\n📁 Environment variable format:");
        console.log("========================");
        console.log(`CONNECTOR_ENCRYPTION_KEY=${connectorKey}`);
        console.log("========================");
    }

    console.log("\n⚠️  Important Security Notes:");
    console.log("- Keep this key secret and secure");
    console.log("- Never commit this key to version control");
    console.log("- Store it securely in your environment variables");
    console.log("- Use different keys for different environments (dev/staging/prod)");
    console.log("- If compromised, generate a new key immediately");

    console.log("\n💡 For BETTER_AUTH_SECRET and JWKS, use:");
    console.log("   pnpm env:sync:auth");

    console.log("\n✅ Key generation complete!");
})();
