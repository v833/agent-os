import { createInterface } from "node:readline";
import { parseCliEventLine } from "./cli-events.js";

const startedAt = Date.now();
const stamp = () => `[${((Date.now() - startedAt) / 1000).toFixed(1)}s]`;

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  for (const message of parseCliEventLine(line)) {
    console.log(`${stamp()} ${message}`);
  }
});
