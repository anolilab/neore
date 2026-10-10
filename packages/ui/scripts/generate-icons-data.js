import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(__dirname, "lucide-temp");

function main() {
    try {
        console.log("🔄 Cloning Lucide repo...");

        if (fs.existsSync(TEMP_DIR)) {
            fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        }

        execSync(`git clone --depth 1 https://github.com/lucide-icons/lucide.git ${TEMP_DIR}`, {
            stdio: "pipe",
        });

        console.log("✅ Repo cloned.");
        console.log("📋 Getting icons data from JSON files...");

        const iconsJson = fs.readdirSync(path.join(TEMP_DIR, "icons"));

        const icons = iconsJson
            .filter((icon) => icon.endsWith(".json"))
            .map((icon) => {
                const iconData = JSON.parse(fs.readFileSync(path.join(TEMP_DIR, "icons", icon), "utf-8"));

                return {
                    name: icon.replace(".json", ""),
                    tags: iconData.tags || [],
                    categories: iconData.categories || [],
                };
            });

        console.log(`✅ Processed ${icons.length} icons.`);

        const iconsDataTs = `export const iconsData: Array<{
    name: string;
    categories: string[];
    tags: string[];
}> = [
  ${icons
      .map(
          (icon) => `{
    "name": "${icon.name}",
    "categories": [${icon.categories.map((category) => `"${category}"`).join(",")}],
    "tags": [${icon.tags.map((tag) => `"${tag}"`).join(",")}]
  }`,
      )
      .join(",\n  ")}
];`;

        const outputPath = path.join(__dirname, "..", "src", "data", "icons-data.ts");
        const outputDir = path.dirname(outputPath);

        // Ensure the output directory exists
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        fs.writeFileSync(outputPath, iconsDataTs, "utf-8");

        console.log(`✅ Generated icons data at: ${outputPath}`);
    } catch (error) {
        console.error(error);
        process.exit(1);
    } finally {
        // Clean up temporary directory
        if (fs.existsSync(TEMP_DIR)) {
            console.log("🧹 Temp folder removed.");
            fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        }
    }
}

main();
