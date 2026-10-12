/** Heads-up heuristic, not a full SQL safety verifier.
 * COLUMN-less DROP forms and DELETE/UPDATE-based data destruction are not comprehensively covered.
 */
export function findDestructiveStatements(sql: string): string[] {
  // Preserve whitespace between tokens when removing line and block comments.
  const uncommented = sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, " ");
  const identifier = String.raw`(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*)`;
  const pattern = new RegExp(
    [
      String.raw`\bDROP\s+(?:TABLE|COLUMN|CONSTRAINT|TYPE|INDEX|SCHEMA|VIEW|MATERIALIZED\s+VIEW|SEQUENCE)\b`,
      String.raw`\bTRUNCATE\b`,
      String.raw`\bALTER\s+COLUMN\b[^;]*?\bTYPE\b`,
      String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${identifier}(?:\s*\.\s*${identifier})?\s+RENAME\s+(?:COLUMN\s+${identifier}\s+TO|TO)\b`,
      String.raw`\bALTER\s+COLUMN\s+${identifier}\s+SET\s+NOT\s+NULL\b`,
      String.raw`\bDELETE\s+FROM\b`,
    ].join("|"),
    "gi",
  );
  return Array.from(uncommented.matchAll(pattern), ([match]) => match.replace(/\s+/g, " "));
}

export function hasDestructiveReview(sql: string): boolean {
  for (const line of sql.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "-- destructive-change: reviewed") return true;
    if (trimmed && !trimmed.startsWith("--")) break;
  }
  return false;
}
