#!/usr/bin/env node
import { main } from './native-cli.js';
main().catch(error => {
  console.error(`view-latex-md: ${error.message}`);
  process.exitCode = 1;
});
