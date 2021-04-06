#!/usr/bin/env node
"use strict";

const config = require("./package.json");
const command = require("./src/command");

(async () => {
  await command(config.name, config.version, process.env.argv);
})();
