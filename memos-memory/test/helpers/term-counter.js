#!/usr/bin/env node
// Fake CLI that counts SIGTERMs, then writes the count to $FAKE_CLI_OUT and exits 0.

import { writeFileSync } from "node:fs";

let count = 0;
process.on("SIGTERM", () => {
  count += 1;
  if (count === 1) {
    setTimeout(() => {
      writeFileSync(process.env.FAKE_CLI_OUT, JSON.stringify({ sigterms: count }));
      process.exit(0);
    }, 400);
  }
});
process.stdin.resume();
process.stdin.on("end", () => {});
// Signal readiness so the test knows handlers are installed.
writeFileSync(`${process.env.FAKE_CLI_OUT}.ready`, "1");
setTimeout(() => process.exit(9), 10000);
