/**
 * Extract the last top-level `{…}` JSON block from a string.
 * String-aware: tracks quote context so braces inside strings are ignored.
 * Returns null if no valid top-level object is found.
 */
export function extractJsonFromResult(text: string): string | null {
  if (!text || text.trim() === "") return null;

  // Fast path: entire text is a single JSON object
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // Not valid JSON as-is (e.g. multiple objects) — fall through to brace scan
    }
  }

  // Collect all `{` positions that are not inside JSON strings.
  const openBraces: number[] = [];
  {
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === "\\") i++; // skip escaped char
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") openBraces.push(i);
    }
  }

  // Try each candidate first-to-last: for each `{`, do a depth-tracking scan
  // to find its matching `}`. Keep the last complete top-level block found.
  // When a block is found, skip candidates nested inside it.
  let lastBlock: string | null = null;

  for (let c = 0; c < openBraces.length; c++) {
    const start = openBraces[c];
    let depth = 0;
    let inString = false;
    let blockEnd = -1;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++; // skip escaped char
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          blockEnd = i;
          break;
        }
      }
    }

    if (blockEnd !== -1) {
      lastBlock = text.slice(start, blockEnd + 1);
      // Skip candidates nested inside this block
      while (c + 1 < openBraces.length && openBraces[c + 1] <= blockEnd) {
        c++;
      }
    }
  }

  return lastBlock;
}
