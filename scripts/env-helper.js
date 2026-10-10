import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

export class EnvHelper {
    constructor(envFileName = ".env", envExampleFileName = ".env-example") {
        this.envPath = path.resolve(process.cwd(), envFileName);
        this.envExamplePath = path.resolve(process.cwd(), envExampleFileName);
        this.config = this.loadEnvConfig();
    }

    displaySecurityWarning(keyType = "key") {
        console.log(`⚠️  Important Security Notes for ${keyType}:`);
        console.log("========================================");
        console.log(`- Keep this ${keyType} secret and secure`);
        console.log(`- Never commit this ${keyType} to version control`);
        console.log("- Store it securely in your environment variables");
        console.log("- Use different keys for different environments (dev/staging/prod)");
        console.log(`- If compromised, generate a new ${keyType} immediately\n`);
    }

    async ensureKey(key, generateValueFunction, description = "") {
        console.log(`🔍 Checking for ${key}...`);

        if (this.hasKey(key)) {
            console.log(`✅ ${key} already exists in .env`);
            console.log(`Current value: ${this.getValue(key)}\n`);
        } else {
            console.log(`❌ ${key} not found in .env, generating new value...`);

            const newValue = await generateValueFunction();

            this.setValue(key, newValue);

            console.log(`✅ Added ${key} to .env`);

            if (description) {
                console.log(`Description: ${description}`);
            }

            console.log(`Generated value: ${newValue}\n`);
        }
    }

    getValue(key) {
        return this.config[key] || "";
    }

    hasKey(key) {
        return key in this.config && this.config[key] && this.config[key].trim() !== "";
    }

    loadEnvConfig() {
        let environmentContent = "";

        if (fs.existsSync(this.envPath)) {
            environmentContent = fs.readFileSync(this.envPath, "utf8");
        } else {
            console.log(`📄 ${path.basename(this.envPath)} file not found, creating from ${path.basename(this.envExamplePath)}...`);

            if (fs.existsSync(this.envExamplePath)) {
                environmentContent = fs.readFileSync(this.envExamplePath, "utf8");
                fs.writeFileSync(this.envPath, environmentContent);
                console.log(`✅ Created ${path.basename(this.envPath)} file from ${path.basename(this.envExamplePath)}\n`);
            } else {
                environmentContent = "";
                fs.writeFileSync(this.envPath, environmentContent);
                console.log(`✅ Created empty ${path.basename(this.envPath)} file\n`);
            }
        }

        const buffer = Buffer.from(environmentContent);

        return dotenv.parse(buffer);
    }

    saveEnvFile() {
        const environmentContent = fs.readFileSync(this.envPath, "utf8");
        let updatedContent = environmentContent;

        for (const [key, value] of Object.entries(this.config)) {
            const keyRegex = new RegExp(`^${key}=.*$`, "m");
            const keyLine = `${key}=${value}`;

            if (keyRegex.test(updatedContent)) {
                updatedContent = updatedContent.replace(keyRegex, keyLine);
            } else {
                updatedContent += updatedContent.endsWith("\n") ? "" : "\n";
                updatedContent += `${keyLine}\n`;
            }
        }

        fs.writeFileSync(this.envPath, updatedContent);
    }

    setValue(key, value) {
        this.config[key] = value;
        this.saveEnvFile();
    }
}
