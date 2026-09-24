import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// Bundle workspace code, but let Firebase install its runtime SDKs normally.
execFileSync(
  "bun",
  [
    "build",
    "src/functions.ts",
    "--target=node",
    "--outdir=dist",
    "--external",
    "firebase-functions",
    "--external",
    "@hono/node-server",
  ],
  { stdio: "inherit" },
);
const source = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  "dist/package.json",
  JSON.stringify(
    {
      name: source.name,
      version: source.version,
      private: true,
      type: "module",
      main: "functions.js",
      engines: source.engines,
      dependencies: {
        "firebase-functions": source.dependencies["firebase-functions"],
        "firebase-admin": source.dependencies["firebase-admin"],
        "@hono/node-server": source.dependencies["@hono/node-server"],
      },
    },
    null,
    2,
  ) + "\n",
);
