import { ApplicantProfile, FillField } from './types';

function parseLeverUrl(link: string): { company: string; jobId: string } | null {
  // https://jobs.lever.co/{company}/{job-uuid}
  // https://jobs.lever.co/{company}/{job-uuid}/apply
  const m = link.match(/jobs\.lever\.co\/([^/?#]+)\/([a-f0-9-]{36})/);
  if (!m) return null;
  return { company: m[1], jobId: m[2] };
}

// Lever standard field names — skip these in custom question extraction
const LEVER_STANDARD_NAMES = new Set([
  'name', 'email', 'phone', 'org', 'resume', 'cover_letter',
  'linkedin', 'github', 'portfolio', 'website',
  'urls[LinkedIn]', 'urls[GitHub]', 'urls[Portfolio]',
]);

function extractLeverCustomQuestions(html: string): FillField[] {
  const customFields: FillField[] = [];

  // Lever custom questions live inside <div class="content"> after standard fields.
  // Each question block has an input/textarea with name="comments[question_text]" or similar.
  // We look for <li> elements with a textarea or input[type!=hidden] that has a data-qa or
  // name containing "comments" or "question".
  const questionBlocks = html.match(/<li[^>]*class="[^"]*form-field[^"]*"[^>]*>[\s\S]*?<\/li>/g) ?? [];

  for (const block of questionBlocks) {
    // Skip standard fields
    const nameMatch = block.match(/name="([^"]+)"/);
    const fieldName = nameMatch?.[1] ?? '';
    if (LEVER_STANDARD_NAMES.has(fieldName)) continue;
    if (!fieldName.startsWith('comments[') && !fieldName.startsWith('cards[')) continue;

    const labelMatch = block.match(/<label[^>]*>([\s\S]*?)<\/label>/);
    if (!labelMatch) continue;
    const label = labelMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().replace(/[✱*]+$/, '').trim();
    if (!label || label.length > 200) continue;

    const required = /required|aria-required="true"/.test(block);
    const type: FillField['type'] = /<textarea/.test(block) ? 'textarea' : 'text';

    customFields.push({
      name: fieldName || `custom_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`,
      label,
      type,
      required,
      source: 'needs_human',
    });
  }

  return customFields;
}

export async function analyzeLeverForm(
  link: string,
  profile: ApplicantProfile,
): Promise<{ applyUrl: string; filledFields: FillField[]; humanFields: FillField[] }> {
  const parsed = parseLeverUrl(link);
  if (!parsed) throw new Error(`Cannot parse Lever URL: ${link}`);

  const { company, jobId } = parsed;
  const applyUrl = `https://jobs.lever.co/${company}/${jobId}/apply`;

  // Standard Lever fields — these are always present
  const filledFields: FillField[] = [
    { name: 'name',            label: 'Full Name',      type: 'text',  required: true,  value: `${profile.firstName} ${profile.lastName}`.trim() || undefined, source: profile.firstName ? 'profile' : 'needs_human' },
    { name: 'email',           label: 'Email',          type: 'email', required: true,  value: profile.email || undefined, source: profile.email ? 'profile' : 'needs_human' },
    { name: 'phone',           label: 'Phone',          type: 'phone', required: false, value: profile.phone || undefined, source: profile.phone ? 'profile' : 'needs_human' },
    { name: 'org',             label: 'Current Company/School', type: 'text', required: false, value: profile.university || undefined, source: profile.university ? 'profile' : 'needs_human' },
    { name: 'urls[LinkedIn]',  label: 'LinkedIn URL',   type: 'url',   required: false, value: profile.linkedin || undefined, source: profile.linkedin ? 'profile' : 'needs_human' },
    { name: 'urls[GitHub]',    label: 'GitHub URL',     type: 'url',   required: false, value: profile.github || undefined, source: profile.github ? 'profile' : 'needs_human' },
    { name: 'urls[Portfolio]', label: 'Portfolio/Website', type: 'url', required: false, value: profile.website || undefined, source: profile.website ? 'profile' : 'needs_human' },
  ].filter(f => f.value || f.required) as FillField[];

  const humanFields: FillField[] = [
    { name: 'resume', label: 'Resume (PDF)', type: 'file', required: true, source: 'needs_human' },
  ];

  // Fetch apply page to extract custom questions
  try {
    const res = await fetch(applyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const html = await res.text();
      const custom = extractLeverCustomQuestions(html);
      humanFields.push(...custom);
    }
  } catch {
    // Network error or blocked — continue with standard fields only
  }

  return { applyUrl, filledFields, humanFields };
}
