import { classifyStructured } from './provider';
import { askJev, jevConfigured, type ChoiceAnswer, type NoulAnswer } from './jev';

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

// Postings are judged by Jev (TypeSafe System One): one call, typed answers,
// about 30x cheaper and 10x faster than Haiku with equal or better agreement
// with a Sonnet judge on our labels (pilot, 2026-09-19). Haiku remains the
// fallback when Jev is unconfigured, fails, or is unsure about the role.
const FALLBACK_MODEL = process.env.CLASSIFY_POSTING_MODEL || 'claude-haiku-4-5-20251001';
const MIN_ROLE_CONFIDENCE = 0.5;
const MAX_DESCRIPTION_CHARS = 5000;

const ROLE_CRITERIA: Record<RoleType, string> = {
  swe: 'building software: backend, frontend, full-stack, mobile, embedded, firmware, platform, infrastructure, devops, systems programming, security engineering where the intern writes code',
  ml_ai: 'machine learning, AI, data science, applied science, research engineer',
  data: 'data engineering, analytics engineering, BI with real technical work',
  quant: 'quantitative research, trading, quant developer',
  it_security: 'security analyst, SOC, GRC, cybersecurity programs, IT support, help desk, sysadmin, QA/manual testing, product support, bank technology analyst programs that are not clearly software development',
  hardware_ee: 'chip design, RF, electrical, mechanical, manufacturing, process engineering',
  product_pm: 'product or program management',
  research_science: 'non-engineering scientific research: biology, chemistry, physics',
  other: 'marketing, sales, HR, finance, operations, design, content, legal, generic business analytics',
};

type JevAnswers = {
  role: ChoiceAnswer<RoleType>;
  is_internship: NoulAnswer;
  us: ChoiceAnswer<'yes' | 'no' | 'unclear'>;
  bs: NoulAnswer;
  ms: NoulAnswer;
  phd: NoulAnswer;
};

/** Jev's judgment, or null when it is not confident about the role. */
async function classifyWithJev(input: PostingInput): Promise<PostingClassification | null> {
  const a = await askJev<JevAnswers>(
    { company: input.company, title: input.title, location: input.location || '(none)', description: (input.description || '(none)').slice(0, MAX_DESCRIPTION_CHARS) },
    {
      role: { type: 'choice', instructions: 'What kind of work would this intern do? Judge from `title` and `description`.', criteria: ROLE_CRITERIA },
      is_internship: { type: 'noul', instructions: 'Is this posting an internship or co-op for students?', criteria: { true: 'an internship or co-op for current students', false: 'a full-time job, contract role, professional fellowship, apprenticeship, or program for experienced hires' } },
      us: { type: 'choice', instructions: 'Can a candidate based in the United States hold this role?', criteria: { yes: 'the role is in the US or US-remote', no: 'the role is clearly outside the US or restricted to non-US candidates', unclear: 'the posting does not say' } },
      bs: { type: 'noul', instructions: "Can an undergraduate (bachelor's student) apply? Yes when undergraduates are named, when the posting says students or currently enrolled with no graduate requirement, or when the description gives no degree signal at all. No when a master's or PhD is required." },
      ms: { type: 'noul', instructions: "Can a master's student apply, as the posting states it? Yes when master's or graduate students are named as eligible." },
      phd: { type: 'noul', instructions: 'Can a PhD student apply, as the posting states it? Yes when PhD students are named as eligible or the role is a PhD research internship.' },
    },
  );
  if (a.role.confidence < MIN_ROLE_CONFIDENCE) return null;
  const yes = (n: NoulAnswer) => n.noul >= 0.5;
  return {
    roleType: ROLE_TYPES.includes(a.role.choice) ? a.role.choice : 'other',
    degrees: DEGREES.filter(d => yes(a[d])),
    isInternship: yes(a.is_internship),
    usEligible: a.us.choice,
  };
}

const SYSTEM = `You classify internship postings for a tracker used by US computer-science students at bachelor's, master's, and PhD level. Read the title and description and record:
- role: swe (building software: backend, frontend, full-stack, mobile, embedded, firmware, platform, infrastructure, devops, systems programming, security *engineering* where the intern writes code), ml_ai (machine learning, AI, data science, applied science, research engineer), data (data engineering, analytics engineering, BI with real technical work), quant (quant research, trading, quant dev), it_security (security analyst, SOC, phishing, GRC, cybersecurity programs, IT support, help desk, sysadmin, QA/manual testing, product support, technology analyst programs at banks where the work is not clearly software development), hardware_ee (chip design, RF, electrical, mechanical, manufacturing, process engineering), product_pm (product or program management), research_science (non-engineering scientific research: biology, chemistry, physics), other (marketing, sales, HR, finance, operations, design, content, legal, generic business analytics).
- degrees: the degree levels that can apply, as the posting states them. bs = undergraduates can apply (stated, or the posting says "students"/"currently enrolled" with no graduate requirement). ms = master's or graduate students can apply. phd = PhD students can apply. When a posting REQUIRES a graduate degree or says "currently pursuing a Master's or PhD" as the qualification, omit bs. "PhD preferred" with undergraduates still eligible keeps bs. When the description is missing or gives no degree signal, return ["bs"]: an internship with no stated graduate requirement is open to undergraduates.
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

export async function classifyPosting(input: PostingInput): Promise<PostingClassification> {
  if (jevConfigured()) {
    const jev = await classifyWithJev(input).catch(e => { console.warn(`[classify] jev failed: ${e instanceof Error ? e.message : e}`); return null; });
    if (jev) return jev;
  }
  return classifyWithHaiku(input);
}

async function classifyWithHaiku(input: PostingInput): Promise<PostingClassification> {
  const user = [
    `Company: ${input.company}`,
    `Title: ${input.title}`,
    `Location: ${input.location || '(none)'}`,
    `Description:\n${(input.description || '(none)').slice(0, MAX_DESCRIPTION_CHARS)}`,
  ].join('\n');
  const r = await classifyStructured<{ role: RoleType; degrees: Degree[]; is_internship: boolean; us_eligible: 'yes' | 'no' | 'unclear' }>({
    model: FALLBACK_MODEL, system: SYSTEM, user, schema: SCHEMA, maxTokens: 200,
  });
  // The schema constrains the enum, but guard anyway: an off-schema value must not reach the DB.
  const roleType = ROLE_TYPES.includes(r.role) ? r.role : 'other';
  const degrees = [...new Set(r.degrees)].filter((d): d is Degree => DEGREES.includes(d));
  return { roleType, degrees, isInternship: r.is_internship, usEligible: r.us_eligible };
}
