/**
 * Search matching on whole tokens, so "ios" finds an iOS role and never "Axio Biosolutions".
 * Technology names keep the characters that carry their meaning: c++, c#, node.js, .net.
 */

/** Everything outside this set separates tokens, so "full-stack" and "full stack" agree. */
const SEPARATORS = /[^a-z0-9.+#]+/g;

/** A trailing plural "s" is dropped on both sides, so "engineers" and "engineer" meet in the middle. */
function stem(token: string): string {
  if (token.length < 4 || /[+#]/.test(token)) return token;
  return token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

export function searchTokens(text: string): string[] {
  return text.toLocaleLowerCase().replace(SEPARATORS, " ").split(" ")
    .map((token) => token.replace(/^\.+/, "").replace(/\.+$/, ""))
    .filter(Boolean)
    .map(stem);
}

/** The text a job is matched against, padded so a term only matches a whole token. A dotted name is also
 * indexed by its parts, so "node" finds "Node.js" while "node.js" still does. */
export function searchHaystack(text: string): string {
  const indexed = new Set<string>();
  for (const token of searchTokens(text)) {
    indexed.add(token);
    if (token.includes(".")) for (const part of token.split(".")) if (part) indexed.add(stem(part));
  }
  return ` ${[...indexed].join(" ")} `;
}

/** The terms of a query; an empty query matches everything. */
export function searchTerms(query: string | undefined, limit = 8): string[] {
  return searchTokens(query ?? "").slice(0, limit);
}

/** Every term must appear as a whole token. */
export function matchesSearchTerms(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(` ${term} `));
}
