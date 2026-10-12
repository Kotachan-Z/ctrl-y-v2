import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { findDestructiveStatements, hasDestructiveReview } from "./migration-policy";

let needsReview = false;
try {
  // Workspace-filtered scripts run from packages/database; git paths are repo-relative.
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const base = process.env.PR_BASE_REF ? `origin/${process.env.PR_BASE_REF}...HEAD` : "HEAD^..HEAD";
  const paths = execFileSync(
    "git",
    ["diff", "--diff-filter=A", "--name-only", "-z", base, "--", "packages/database/migrations/"],
    { cwd: root, encoding: "utf8" },
  ).split("\0");
  for (const path of paths) {
    if (!/^packages\/database\/migrations\/[^/]+\.sql$/.test(path)) continue;
    const sql = await readFile(resolve(root, path), "utf8");
    const matches = findDestructiveStatements(sql);
    if (matches.length && !hasDestructiveReview(sql)) {
      console.error(`${path}: ${matches.join(", ")}`);
      needsReview = true;
      process.exitCode = 1;
    }
  }
  if (!needsReview) console.log("New migration destructive SQL check: OK");
} catch (err) {
  console.error("::error::Migration check failed. See error details below.");
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  if (needsReview) {
    console.error(
      "::error::Destructive SQL requires human review. Before applying, add -- destructive-change: reviewed in the leading -- comment lines before any SQL.",
    );
  }
}
