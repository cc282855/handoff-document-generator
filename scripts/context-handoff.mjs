#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./context-handoff-core.mjs";

export * from "./context-handoff-core.mjs";

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await runCli();
