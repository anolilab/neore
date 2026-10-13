/**
 * Profiles the startup of a Worker bundle that Alchemy built, with the tool Cloudflare
 * names for it: `wrangler check startup`.
 *
 * Cloudflare rejects a Worker whose global scope takes more than 1 s of CPU
 * ("Script startup exceeded CPU time limit"). `wrangler check startup` on the repo's
 * own `wrangler.jsonc` profiles `lunora build`'s esbuild bundle, which is not what
 * deploys: Alchemy bundles each Worker itself with rolldown. This takes THAT bundle
 * (the `worker-bundles-<stage>` artifact `deploy.yml` keeps), wraps its modules in the
 * multipart body `--workerBundle` reads, and profiles it.
 *
 *   pnpm exec tsx scripts/profile-worker-startup.ts <bundle-dir> <main-module>
 *
 * The bindings are not reproduced, so a Worker that reads one at module scope fails
 * here; the profile is still the right thing to compare run against run (it varies by
 * ~100 ms, mostly garbage collection: take the best of several).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const [directory, main] = process.argv.slice(2);

if (directory === undefined || main === undefined) {
    console.error("usage: profile-worker-startup.ts <bundle-dir> <main-module, relative to it>");
    process.exit(2);
}

const walk = (path: string): string[] =>
    readdirSync(path).flatMap((name) => {
        const full = join(path, name);

        return statSync(full).isDirectory() ? walk(full) : [full];
    });

const modules = walk(directory).filter((file) => /\.m?js$/u.test(file));
const form = new FormData();

form.set("metadata", JSON.stringify({ bindings: [], compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat_v2"], main_module: main }));

for (const file of modules) {
    const name = relative(directory, file).split(sep).join("/");

    form.set(name, new Blob([readFileSync(file)], { type: "application/javascript+module" }), name);
}

const bundle = join(tmpdir(), "worker-startup.bundle");

writeFileSync(bundle, Buffer.from(await new Response(form).arrayBuffer()));
console.log(`${modules.length} modules, main ${main}`);

const result = spawnSync(
    "pnpm",
    ["--filter", "@neore/backend", "exec", "wrangler", "check", "startup", "--workerBundle", bundle, "--outfile", join(tmpdir(), "worker-startup.cpuprofile")],
    {
        stdio: "inherit",
    },
);

process.exit(result.status ?? 1);
