// Shared keyword matcher used by the scorer and the UI tier filter so the
// two never drift apart. Previous substring matching missed morphological
// variants: keyword "engineer intern" wouldn't match title "Engineering
// Intern" because the space in the keyword can't line up with "ing". We:
//   1. Split on any non-alphanumeric character (handles hyphens, slashes,
//      dots, emojis, whitespace uniformly)
//   2. Stem each word — strip trailing -ing or -s, but only on words longer
//      than 5 chars to avoid mangling short tech terms like "redis" or "aws"
//   3. Phrase-match the stemmed needle tokens as a contiguous subsequence
//      of the stemmed haystack tokens

function stemWord(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith('s'))   return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stemWord);
}

export function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Convenience wrapper — tokenize+stem both sides, then phrase match. */
export function matchesKeyword(text: string, keyword: string): boolean {
  return containsPhrase(tokenize(text), tokenize(keyword));
}
