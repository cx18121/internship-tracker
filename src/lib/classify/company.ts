import { classifyStructured } from './provider';

export type CompanyTier = 'elite' | 'top' | 'hot' | 'startup' | 'solid' | 'other';
export const COMPANY_TIERS: readonly CompanyTier[] = ['elite', 'top', 'hot', 'startup', 'solid', 'other'];

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
- startup: a young software, AI, robotics, or hardware startup you do not recognize or know little about, but whose evidence says it is a real venture-scale engineering company: hires through Ashby, Greenhouse, or Lever; the posting is a genuine engineering role; the description reads like a funded startup (mentions a round, YC, investors, a product, a small team). Most seed-to-Series-B companies founded recently land here because you cannot know them yet.
- solid: established companies with real software engineering that are not destination employers for top CS talent: banks, insurers, defense, Fortune 500 non-tech, consultancies, mid-size or legacy tech.
- other: staffing agencies, universities, hospitals, government, small local businesses, non-tech employers, or a company with no evidence of being a software or hardware engineering employer.
Be consistent: the same company must always get the same tier. Not recognizing a name is not evidence against it; judge the evidence given. A company on Workday, iCIMS, SmartRecruiters, or a bank/insurer/consultancy career site is solid or other, never startup.`;

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
  /** Opening of a posting's description; usually where a startup describes itself. */
  sampleDescription?: string;
}

export function classifyCompany(input: CompanyInput): Promise<CompanyProfile> {
  const user = [
    `Company: ${input.company}`,
    input.atsHost ? `Hiring site host: ${input.atsHost}` : '',
    input.sampleTitle ? `Sample posting title: ${input.sampleTitle}` : '',
    input.sampleDescription ? `Sample posting opening:\n${input.sampleDescription.slice(0, 700)}` : '',
  ].filter(Boolean).join('\n');
  return classifyStructured<CompanyProfile>({ model: MODEL, system: SYSTEM, user, schema: SCHEMA, maxTokens: 300 });
}
