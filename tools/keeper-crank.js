#!/usr/bin/env node
"use strict";
const { main, fatal } = require("./keeper-worker-cli");
if (require.main === module) main().catch(fatal);
