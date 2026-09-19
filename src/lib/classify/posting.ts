import { classifyStructured } from './provider';

export type RoleType = 'swe' | 'ml_ai' | 'data' | 'quant' | 'it_security' | 'hardware_ee' | 'product_pm' | 'research_science' | 'other';
export const ROLE_TYPES: readonly RoleType[] = ['swe', 'ml_ai', 'data', 'quant', 'it_security', 'hardware_ee', 'product_pm', 'research_science', 'other'];
/** Role types a CS-student tracker keeps. The rest are archived at re-evaluation. */
export const TECHNICAL_ROLE_TYPES: readonly RoleType[] = ['swe', 'ml_ai', 'data', 'quant', 'it_security', 'hardware_ee', 'research_science'];

export type Degree = 'bs' | 'ms' | 'phd';
export const DEGREES: readonly Degree[] = ['bs', 'ms', 'phd'];

export interface PostingClassification {
  roleType: RoleType;
  /** Eligible degree levels. Empty when the posting gives no signal. */
  degrees: Degree[];
  isInternship: boolean;
  usEligible: 'yes' | 'no' | 'unclear';
}

const MODEL = process.env.CLASSIFY_POSTING_MODEL || 'claude-haiku-4-5-20251001';

const SYSTEM = `You classify internship postings for a tracker used by US computer-science students at bachelor's, master's, and PhD level. Read the title and description and record:
- role: swe (building software: backend, frontend, full-stack, mobile, embedded, firmware, platform, infrastructure, devops, systems programming, security *engineering* where the intern writes code), ml_ai (machine learning, AI, data science, applied science, research engineer), data (data engineering, analytics engineering, BI with real technical work), quant (quant research, trading, quant dev), it_security (security analyst, SOC, phishing, GRC, cybersecurity programs, IT support, help desk, sysadmin, QA/manual testing, product support, technology analyst programs at banks where the work is not clearly software development), hardware_ee (chip design, RF, electrical, mechanical, manufacturing, process engineering), product_pm (product or program management), research_science (non-engineering scientific research: biology, chemistry, physics), other (marketing, sales, HR, finance, operations, design, content, legal, generic business analytics).
- degrees: the degree levels that can apply, as the posting states them. bs = undergraduates can apply (stated, or the posting says "students"/"currently enrolled" with no graduate requirement). ms = master's or graduate students can apply. phd = PhD students can apply. When a posting REQUIRES a graduate degree or says "currently pursuing a Master's or PhD" as the qualification, omit bs. "PhD preferred" with undergraduates still eligible keeps bs. When the description is missing or gives no degree signal at all, return an empty array; do not assume bs.
- is_internship: false when the posting is actually full-time, a contract role, a professional fellowship, an apprenticeship, or a program for experienced hires.
- us_eligible: yes when the role is in the US or US-remote; no when it is clearly outside the US or restricted to non-US candidates; unclear otherwise.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    role: { type: 'string', enum: ROLE_TYPES },
    degrees: { type: 'array', items: { type: 'string', enum: DEGREES } },
    is_internship: { type: 'boolean' },
    us_eligible: { type: 'string', enum: ['yes', 'no', 'unclear'] },
  },
  required: ['role', 'degrees', 'is_internship', 'us_eligible'],
};

export interface PostingInput {
  title: string;
  company: string;
  location: string;
  description?: string;
}

const MAX_DESCRIPTION_CHARS = 5000;

export async function classifyPosting(input: PostingInput): Promise<PostingClassification> {
  const user = [
    `Company: ${input.company}`,
    `Title: ${input.title}`,
    `Location: ${input.location || '(none)'}`,
    `Description:\n${(input.description || '(none)').slice(0, MAX_DESCRIPTION_CHARS)}`,
  ].join('\n');
  const r = await classifyStructured<{ role: RoleType; degrees: Degree[]; is_internship: boolean; us_eligible: 'yes' | 'no' | 'unclear' }>({
    model: MODEL, system: SYSTEM, user, schema: SCHEMA, maxTokens: 200,
  });
  // The schema constrains the enum, but guard anyway: an off-schema value must not reach the DB.
  const roleType = ROLE_TYPES.includes(r.role) ? r.role : 'other';
  const degrees = [...new Set(r.degrees)].filter((d): d is Degree => DEGREES.includes(d));
  return { roleType, degrees, isInternship: r.is_internship, usEligible: r.us_eligible };
}
