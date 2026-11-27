// Keeps the published code runnable on every runtime the SDK claims (Node 22+, Deno, Bun, Cloudflare Workers):
// src/ must not import node: modules or use Node-only globals, and package.json must have no runtime dependencies.
import { readFileSync, readdirSync } from "node:fs";

const problems = [];
for (const file of readdirSync(new URL("../src/", import.meta.url))) {
  const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [pattern, what] of [
    [/from\s+["']node:|import\(\s*["']node:|require\(/, "a Node module import"],
    [/\bprocess\./, "process"],
    [/\bBuffer\b/, "Buffer"],
  ]) {
    if (pattern.test(code)) problems.push(`src/${file}: ${what}`);
  }
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  if (pkg[field] && Object.keys(pkg[field]).length > 0) problems.push(`package.json: ${field} must stay empty`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("edge check: ok");
