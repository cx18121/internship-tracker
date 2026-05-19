import { ApplicantProfile, FillField } from './types.js';

interface GhQuestion {
  label: string;
  required: boolean;
  fields: Array<{ name: string; type: string; values?: Array<{ label: string; value: string }> }>;
}

interface GhJobResponse {
  questions?: GhQuestion[];
}

function parseGreenhouseUrl(link: string): { slug: string; jobId: string } | null {
  // https://boards.greenhouse.io/{slug}/jobs/{id}
  // https://job-boards.greenhouse.io/{slug}/jobs/{id}
  const m = link.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
  if (!m) return null;
  return { slug: m[1], jobId: m[2] };
}

/** Fields that map directly from the applicant profile */
const STANDARD_FIELD_MAP: Record<string, (p: ApplicantProfile) => string | undefined> = {
  first_name:          p => p.firstName,
  last_name:           p => p.lastName,
  email:               p => p.email,
  phone:               p => p.phone || undefined,
  linkedin_url:        p => p.linkedin || undefined,
  linkedin_profile:    p => p.linkedin || undefined,
  github:              p => p.github || undefined,
  website:             p => p.website || undefined,
  cover_letter_text:   p => p.coverLetterTemplate || undefined,
};

function fieldTypeToFillType(ghType: string): FillField['type'] {
  switch (ghType) {
    case 'input_file': return 'file';
    case 'textarea':   return 'textarea';
    case 'input_url':  return 'url';
    case 'input_phone':return 'phone';
    case 'multi_value_single_select':
    case 'multi_value_multi_select': return 'select';
    default:           return 'text';
  }
}

export async function analyzeGreenhouseForm(
  link: string,
  profile: ApplicantProfile,
): Promise<{ applyUrl: string; filledFields: FillField[]; humanFields: FillField[] }> {
  const parsed = parseGreenhouseUrl(link);
  if (!parsed) throw new Error(`Cannot parse Greenhouse URL: ${link}`);

  const { slug, jobId } = parsed;
  const applyUrl = `https://boards.greenhouse.io/${slug}/jobs/${jobId}`;
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?questions=true`;

  let questions: GhQuestion[] = [];
  try {
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; openclaw-autofill/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json() as GhJobResponse;
      questions = data.questions ?? [];
    }
  } catch {
    // API unreachable or rate-limited — fall back to minimal field set
  }

  const filledFields: FillField[] = [];
  const humanFields: FillField[] = [];
  const seen = new Set<string>();

  for (const q of questions) {
    for (const field of q.fields ?? []) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);

      const ghType = field.type ?? 'input_text';
      const fillType = fieldTypeToFillType(ghType);

      // File uploads always need human (resume, cover letter file)
      if (fillType === 'file') {
        humanFields.push({ name: field.name, label: q.label, type: 'file', required: q.required, source: 'needs_human' });
        continue;
      }

      const autoFiller = STANDARD_FIELD_MAP[field.name];
      if (autoFiller) {
        const value = autoFiller(profile);
        if (value) {
          filledFields.push({ name: field.name, label: q.label, type: fillType, required: q.required, value, source: 'profile' });
        } else {
          humanFields.push({ name: field.name, label: q.label, type: fillType, required: q.required, source: 'needs_human' });
        }
      } else {
        // Unknown / custom question — needs human
        humanFields.push({ name: field.name, label: q.label, type: fillType, required: q.required, source: 'needs_human' });
      }
    }
  }

  // If API returned nothing, inject baseline standard fields
  if (questions.length === 0) {
    filledFields.push(
      { name: 'first_name', label: 'First Name', type: 'text', required: true, value: profile.firstName, source: 'profile' },
      { name: 'last_name',  label: 'Last Name',  type: 'text', required: true, value: profile.lastName,  source: 'profile' },
      { name: 'email',      label: 'Email',      type: 'email',required: true, value: profile.email,     source: 'profile' },
    );
    if (profile.phone) filledFields.push({ name: 'phone', label: 'Phone', type: 'phone', required: false, value: profile.phone, source: 'profile' });
    humanFields.push({ name: 'resume', label: 'Resume', type: 'file', required: true, source: 'needs_human' });
  }

  return { applyUrl, filledFields, humanFields };
}
