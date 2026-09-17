/**
 * Search matching on whole tokens, so "ios" finds an iOS role and never "Axio Biosolutions".
 * Technology names keep the characters that carry their meaning: c++, c#, node.js, .net.
 */

/** Everything outside this set separates tokens, so "full-stack" and "full stack" agree. */
const SEPARATORS = /[^a-z0-9.+#]+/g;

/**
 * Word forms are reduced on both sides, because a candidate typing "engineer" means "Engineering" too.
 * Only plurals and "-ing" come off. A wider rule was measured and withdrawn: stripping "er" and "ment" merged
 * agent nouns with activity nouns, so "developer" reached 378 Business and Corporate Development titles and
 * "engineer" reached Search Engine Optimization. Word-form overlap helps retrieval, but these are different jobs.
 * Technology names carrying + or # are never touched.
 */
const SUFFIXES = ["ing", "s"];
function stem(token: string): string {
  if (token.length < 4 || /[+#]/.test(token)) return token;
  let word = token;
  // Reduce repeatedly, or "engineerings" stops one form short of "engineer".
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
  return word;
}

/** Words written as one in some titles and two in others; the index carries both readings. */
/** Written as one word, these are read as two as well, but never joined the other way: joining "Dev" and "Ops" in
 * "Clin Dev Ops" produced a DevOps match for Clinical Development Operations. */
const SPLIT_ONLY = [["dev", "ops"], ["web", "ops"], ["fin", "tech"]].map(([left, right]) => ({ left: left!, right: right!, joined: `${left}${right}` }));

const COMPOUNDS = [["full", "stack"], ["front", "end"], ["back", "end"], ["data", "base"], ["work", "flow"]].map(([left, right]) => ({ left: left!, right: right!, joined: `${left}${right}` }));

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
  // A word written as one is also read as two, which is always safe: the title really does contain both parts.
  for (const { left, right, joined } of SPLIT_ONLY) if (indexed.has(stem(joined))) { indexed.add(stem(left)); indexed.add(stem(right)); }
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
