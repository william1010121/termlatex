#!/usr/bin/env node
import { main } from './native-cli.js';
main().catch(error => {
  console.error(`termlatex: ${error.message}`);
  process.exitCode = 1;
});
