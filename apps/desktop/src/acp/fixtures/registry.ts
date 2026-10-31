/** The shape of the live ACP registry file, reduced: a binary with checksums, one without, an npx-only agent and malformed entries. */

export const SHA = "0434cab747e8f655bbf57dba2421dfd4e01f885ded7776d166150547f07385f3";

export const REGISTRY_FIXTURE = {
    agents: [
        {
            authors: ["Ada Lovelace", "Grace Hopper"],
            description: "ACP wrapper for Amp",
            distribution: {
                binary: {
                    "darwin-aarch64": { archive: "https://example.com/amp-darwin-aarch64.tar.gz", cmd: "./amp-acp", sha256: SHA.toUpperCase() },
                    "darwin-x86_64": { archive: "https://example.com/amp-darwin-x86_64.tar.gz", cmd: "./amp-acp", sha256: SHA },
                    "linux-aarch64": { archive: "https://example.com/amp-linux-aarch64.zip", cmd: "./amp-acp", sha256: SHA },
                    "linux-x86_64": { archive: "https://example.com/amp-linux-x86_64.zip", args: ["acp"], cmd: "./amp-acp", env: { AMP_MODE: "acp" }, sha256: SHA },
                    "windows-x86_64": { archive: "https://example.com/amp.tar.bz2", cmd: "amp-acp.exe", sha256: SHA },
                },
            },
            id: "amp-acp",
            license: "Apache-2.0",
            name: "Amp",
            repository: "https://github.com/someone/amp-acp",
            version: "0.10.0",
        },
        {
            description: "No checksum",
            distribution: { binary: { "darwin-aarch64": { archive: "https://example.com/c.tar.gz", cmd: "./c" }, "linux-x86_64": { archive: "https://example.com/c-linux.tar.gz", cmd: "./c" } } },
            id: "cortex-code",
            license: "MIT",
            name: "Cortex",
            repository: "https://github.com/snowflake/cortex",
            version: "1.0.0",
        },
        { description: "npx only", distribution: { npx: { package: "thing@1.0.0" } }, id: "thing", name: "Thing", version: "1.0.0" },
        { distribution: { binary: {} }, id: "Bad Id", name: "Bad", version: "1.0.0" },
        { id: "no-distribution", name: "Broken", version: "1.0.0" },
    ],
    version: "1.0.0",
};

