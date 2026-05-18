import { ApplicantProfile, FillField } from './types.js';

function parseAshbyUrl(link: string): { company: string; jobId: string } | null {
  // https://jobs.ashbyhq.com/{company}/{uuid}
  // https://jobs.ashbyhq.com/{company}/{uuid}/application
  const m = link.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([a-f0-9-]{36})/);
  if (!m) return null;
  return { company: m[1], jobId: m[2] };
}

interface AshbyFormField {
  path?: string;
  id?: string;
  title?: string;
  label?: string;
  fieldType?: string;
  isRequired?: boolean;
  isSystemField?: boolean;
}

interface AshbyNextData {
  props?: {
    pageProps?: {
      applicationForm?: {
        formFields?: AshbyFormField[];
      };
    };
  };
}

function parseAshbyNextData(html: string): AshbyFormField[] {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  try {
    const nextData = JSON.parse(m[1]) as AshbyNextData;
    return nextData?.props?.pageProps?.applicationForm?.formFields ?? [];
  } catch {
    return [];
  }
}

export async function analyzeAshbyForm(
  link: string,
  profile: ApplicantProfile,
): Promise<{ applyUrl: string; filledFields: FillField[]; humanFields: FillField[] }> {
  const parsed = parseAshbyUrl(link);
  if (!parsed) throw new Error(`Cannot parse Ashby URL: ${link}`);

  const { company, jobId } = parsed;
  const applyUrl = link.includes('/application')
    ? link.split('?')[0]
    : `https://jobs.ashbyhq.com/${company}/${jobId}/application`;

  // Ashby standard system fields (always present)
  const filledFields: FillField[] = [
    { name: '_systemfield_name',     label: 'Full Name', type: 'text',  required: true,  value: `${profile.firstName} ${profile.lastName}`.trim() || undefined, source: profile.firstName ? 'profile' : 'needs_human' },
    { name: '_systemfield_email',    label: 'Email',     type: 'email', required: true,  value: profile.email || undefined, source: profile.email ? 'profile' : 'needs_human' },
    { name: '_systemfield_phone',    label: 'Phone',     type: 'phone', required: false, value: profile.phone || undefined, source: profile.phone ? 'profile' : 'needs_human' },
    { name: '_systemfield_linkedin', label: 'LinkedIn',  type: 'url',   required: false, value: profile.linkedin || undefined, source: profile.linkedin ? 'profile' : 'needs_human' },
    { name: '_systemfield_github',   label: 'GitHub',    type: 'url',   required: false, value: profile.github || undefined, source: profile.github ? 'profile' : 'needs_human' },
    { name: '_systemfield_website',  label: 'Website',   type: 'url',   required: false, value: profile.website || undefined, source: profile.website ? 'profile' : 'needs_human' },
  ].filter(f => f.value || f.required) as FillField[];

  const humanFields: FillField[] = [
    { name: '_systemfield_resume', label: 'Resume (PDF)', type: 'file', required: true, source: 'needs_human' },
  ];

  // Fetch application page to extract custom fields from __NEXT_DATA__
  try {
    const res = await fetch(applyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const html = await res.text();
      const fields = parseAshbyNextData(html);
      for (const field of fields) {
        if (field.isSystemField) continue; // already handled above
        const name = field.path ?? field.id ?? 'custom';
        const label = field.title ?? field.label ?? name;
        const type: FillField['type'] = field.fieldType === 'LongText' ? 'textarea' : 'text';
        humanFields.push({ name, label, type, required: field.isRequired ?? false, source: 'needs_human' });
      }
    }
  } catch {
    // Ashby may block headless fetches — continue with standard fields
  }

  return { applyUrl, filledFields, humanFields };
}
