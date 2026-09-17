/**
 * Search matching on whole tokens, so "ios" finds an iOS role and never "Axio Biosolutions".
 * Technology names keep the characters that carry their meaning: c++, c#, node.js, .net.
 */

/** Everything outside this set separates tokens, so "full-stack" and "full stack" agree. */
const SEPARATORS = /[^a-z0-9.+#]+/g;

/**
 * Word forms are reduced on both sides, because a candidate typing "engineer" means "Engineering" too.
 * A first version dropped only plurals, and a coverage panel measured the cost: of 598 results it removed,
 * roughly 42 were genuine false matches and the rest were real roles whose titles used another form.
 * Suffixes come off longest first, then a trailing "e", so engineer/engineering and develop/developer/development
 * all land on one stem. Technology names carrying + or # are never touched.
 */
const SUFFIXES = ["ment", "ing", "or", "er", "s"];
function stem(token: string): string {
  if (token.length < 4 || /[+#]/.test(token)) return token;
  let word = token;
  // Reduce repeatedly, or "engineering" stops at "engineer" while "engineer" goes on to "engine" and the two never meet.
  for (let pass = 0; pass < 3; pass += 1) {
    const before = word;
    for (const suffix of SUFFIXES) {
      if (word.length - suffix.length >= 4 && word.endsWith(suffix) && !(suffix === "s" && word.endsWith("ss"))) {
        word = word.slice(0, -suffix.length);
        break;
      }
    }
    if (word === before) break;
  }
  return word.length > 4 && word.endsWith("e") ? word.slice(0, -1) : word;
}

/** Words written as one in some titles and two in others; the index carries both readings. */
const COMPOUNDS = [["full", "stack"], ["front", "end"], ["back", "end"], ["dev", "ops"], ["data", "base"], ["work", "flow"]].map(([left, right]) => ({ left: left!, right: right!, joined: `${left}${right}` }));

export function searchTokens(text: string): string[] {
  return text.toLocaleLowerCase().replace(SEPARATORS, " ").split(" ")
    .map((token) => token.replace(/^\.+/, "").replace(/\.+$/, ""))
    .filter(Boolean)
    .map(stem);
}

/** The text a job is matched against, padded so a term only matches a whole token. A dotted name is also
 * indexed by its parts, so "node" finds "Node.js" while "node.js" still does. */
export function searchHaystack(text: string): string {
  const tokens = searchTokens(text);
  const indexed = new Set<string>(tokens);
  for (const token of tokens) if (token.includes(".")) for (const part of token.split(".")) if (part) indexed.add(stem(part));
  // "Fullstack" and "Full Stack" are the same job: index each reading so either spelling finds both.
  for (const { left, right, joined } of COMPOUNDS) {
    const leftStem = stem(left); const rightStem = stem(right); const joinedStem = stem(joined);
    if (indexed.has(joinedStem)) { indexed.add(leftStem); indexed.add(rightStem); }
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      if (tokens[index] === leftStem && tokens[index + 1] === rightStem) indexed.add(joinedStem);
    }
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
