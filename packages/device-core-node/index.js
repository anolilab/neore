// Loads the binary written by `pnpm run build` (see README header in src/lib.rs).
// napi names it `device-core-node.<platform>-<arch>.node`, with an ABI suffix on
// Windows and Linux (`win32-x64-msvc`, `linux-x64-gnu`), so match on the prefix.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const prefix = `device-core-node.${process.platform}-${process.arch}`;
const file = fs.readdirSync(__dirname).find((name) => name === `${prefix}.node` || (name.startsWith(`${prefix}-`) && name.endsWith(".node")));

if (!file) {
    throw new Error(`no device-core-node binary for ${process.platform}-${process.arch} in ${__dirname}`);
}

module.exports = require(path.join(__dirname, file));
