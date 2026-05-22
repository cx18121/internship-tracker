// Dev-curated specialization taxonomy. Each role bundles the scorer-config
// keywords (data/scoring-config.json roleTiers) that should "light up" the
// chip. Kept in code, not config, because changing it is a code review —
// surface-area choice, not a per-deploy setting.
//
// Multi-membership is intentional:
//   - "research scientist" → ai-ml AND research (AI research is a real cluster)
//   - "applied scientist"  → ai-ml AND research (same reason)
//   - "embedded"           → infra. Embedded systems live closer to the OS /
//     hardware-platform layer than to iOS/Android mobile apps. Same call for
//     "systems programming". Mobile is iOS/Android proper.
//
// Matching is case-insensitive substring overlap against the scorer's
// matchedKeywords tags (NOT free-text on the title), so the chip filter
// stays consistent with the existing keyword filter semantics.

export const ROLE_SPECIALIZATIONS = [
  {
    id: 'swe',
    label: 'Software',
    keywords: [
      'software engineer', 'swe intern', 'full stack', 'fullstack', 'full-stack',
      'backend', 'back end', 'back-end', 'frontend', 'front end', 'front-end',
      'platform engineer', 'systems engineer', 'product engineer', 'developer',
      'programmer', 'web developer', 'web engineer', 'api engineer',
      'engineer intern', 'intern engineer', 'software development',
      'software testing', 'test engineer', 'computer engineer',
    ],
  },
  {
    id: 'ai-ml',
    label: 'AI / ML',
    keywords: [
      'ai engineer', 'ai/ml', 'ml engineer', 'generative ai', 'llm',
      'applied ai', 'machine learning', 'ai intern', 'ai solutions',
      'ai developer', 'applied scientist', 'research scientist', 'nlp',
      'computer vision',
    ],
  },
  {
    id: 'data',
    label: 'Data',
    keywords: [
      'data engineer', 'data science', 'data analyst', 'analytics engineer',
    ],
  },
  {
    id: 'infra',
    label: 'Infra / DevOps',
    keywords: [
      'infrastructure', 'cloud engineer', 'devops', 'site reliability', 'sre',
      'distributed systems', 'build engineer', 'tooling', 'embedded',
      'systems programming',
    ],
  },
  {
    id: 'security',
    label: 'Security',
    keywords: [
      'security engineer', 'security intern', 'cybersecurity',
      'network security', 'reverse engineer',
    ],
  },
  {
    id: 'mobile',
    label: 'Mobile',
    keywords: ['mobile engineer'],
  },
  {
    id: 'quant',
    label: 'Quant',
    keywords: ['quantitative', 'quant'],
  },
  {
    id: 'research',
    label: 'Research',
    keywords: ['research engineer', 'research scientist', 'applied scientist'],
  },
  {
    id: 'blockchain',
    label: 'Blockchain',
    keywords: ['blockchain engineer'],
  },
] as const;

export type RoleId = typeof ROLE_SPECIALIZATIONS[number]['id'];

const ROLE_BY_ID: Record<string, readonly string[]> = Object.fromEntries(
  ROLE_SPECIALIZATIONS.map((r) => [r.id, r.keywords]),
);

export function isRoleId(s: string): s is RoleId {
  return s in ROLE_BY_ID;
}

/**
 * True iff any scorer-tag in `matched` overlaps with any keyword in the
 * role's bucket. Case-insensitive substring match in both directions:
 *   - "AI Engineer" tag matches "ai engineer" keyword
 *   - "Machine Learning Engineer" tag matches "machine learning" keyword
 * Matches FilterRail's "matchedKeywords includes" semantics but tolerant of
 * the (rare) case where the scorer stores a longer-than-keyword tag.
 */
export function postingMatchesRole(matched: string[], roleId: RoleId): boolean {
  const bucket = ROLE_BY_ID[roleId];
  if (!bucket || bucket.length === 0) return false;
  if (!matched || matched.length === 0) return false;
  const tags = matched.map((m) => m.toLowerCase());
  for (const kw of bucket) {
    const k = kw.toLowerCase();
    for (const tag of tags) {
      if (tag === k || tag.includes(k) || k.includes(tag)) return true;
    }
  }
  return false;
}

/**
 * OR-semantics: posting passes if it matches ANY of the selected roles.
 * Empty `roleIds` → no role gate (returns true).
 */
export function postingMatchesAnyRole(
  matched: string[],
  roleIds: readonly RoleId[],
): boolean {
  if (roleIds.length === 0) return true;
  return roleIds.some((id) => postingMatchesRole(matched, id));
}
