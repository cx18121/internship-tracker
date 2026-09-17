import { classifyStructured } from './provider';

export type CompanyTier = 'elite' | 'top' | 'hot' | 'solid' | 'other';
export const COMPANY_TIERS: readonly CompanyTier[] = ['elite', 'top', 'hot', 'solid', 'other'];

export interface CompanyProfile {
  tier: CompanyTier;
  sector: string;
  /** True when the model recognized this specific company. */
  known: boolean;
  reason: string;
}

// Company judgment is the highest-leverage classification and runs once per
// company, so it gets the stronger model.
const MODEL = process.env.CLASSIFY_COMPANY_MODEL || 'claude-sonnet-4-6';

const SYSTEM = `You classify employers for an internship tracker used by strong US computer-science students. Judge the company from your own knowledge. Tiers:
- elite: the most sought-after software employers: FAANG-level tech, top quant and trading firms, frontier AI labs, top-tier prestige (Jane Street, Citadel, Stripe, Databricks, SpaceX, OpenAI, Anthropic).
- top: well-known strong tech employers or large public tech companies with respected engineering (Salesforce, Snowflake, Datadog, Uber, Airbnb, Cloudflare, Palantir, Roblox).
- hot: high-growth venture-backed startups with a strong engineering reputation, typically Series A to D or recent unicorns, especially AI, infra, fintech, robotics, devtools (Decagon, Anysphere, Harvey, Sierra, Cognition, Perplexity, Ramp, Vercel, Linear, Applied Intuition, Anduril-stage companies).
- solid: established companies with real software engineering that are not destination employers for top CS talent: banks, defense, insurers, Fortune 500 non-tech, mid-size or legacy tech.
- other: staffing agencies, universities, hospitals, small local businesses, non-tech employers, or companies you do not recognize.
Be consistent: the same company must always get the same tier. Do not guess a high tier for a name you do not recognize; unrecognized companies are 'other' unless the ATS hint below applies.
ATS hint: companies hiring through Ashby, Greenhouse, or Lever are usually startups or tech companies. If you do not recognize the company but it uses one of those, prefer 'solid' over 'other' when the sample title is a real engineering role. Workday, iCIMS, and SmartRecruiters skew toward large traditional employers.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    tier: { type: 'string', enum: COMPANY_TIERS },
    sector: { type: 'string', description: 'two or three words' },
    known: { type: 'boolean', description: 'true only if you recognize this specific company' },
    reason: { type: 'string', description: 'one short sentence' },
  },
  required: ['tier', 'sector', 'known', 'reason'],
};

export interface CompanyInput {
  company: string;
  /** Hostname of a posting link, e.g. jobs.ashbyhq.com. */
  atsHost?: string;
  sampleTitle?: string;
}

export function classifyCompany(input: CompanyInput): Promise<CompanyProfile> {
  const user = [
    `Company: ${input.company}`,
    input.atsHost ? `Hiring site host: ${input.atsHost}` : '',
    input.sampleTitle ? `Sample posting title: ${input.sampleTitle}` : '',
  ].filter(Boolean).join('\n');
  return classifyStructured<CompanyProfile>({ model: MODEL, system: SYSTEM, user, schema: SCHEMA, maxTokens: 300 });
}
