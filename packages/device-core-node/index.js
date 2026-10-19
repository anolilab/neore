// Loads the per-platform binary written by `pnpm run build` (see README header in
// src/lib.rs). One binary per target; this machine's is `device-core-node.<platform>-<arch>.node`.
"use strict";

const path = require("node:path");

const file = path.join(__dirname, `device-core-node.${process.platform}-${process.arch}.node`);

module.exports = require(file);
