/**
 * LinkedIn Easy Apply analyzer and filler.
 *
 * LinkedIn Easy Apply forms are multi-step — each step is a separate page/section
 * within the same modal. We detect them by the `jobs-apply-button` class and fill
 * sequentially, clicking "Next" after each step until the final step.
 *
 * LinkedIn uses a mix of HTML input names and data-test attributes for form fields.
 */

import { ApplicantProfile, FillField } from './types.js';

// ── URL / form detection ────────────────────────────────────────────────────

function parseLinkedInJobId(url: string): string | null {
  // https://www.linkedin.com/jobs/view/<id>/apply
  const m = url.match(/linkedin\.com\/jobs\/view\/([^/?#]+)/);
  return m ? m[1] : null;
}

export function isLinkedInEasyApplyUrl(url: string): boolean {
  return /linkedin\.com\/jobs\/view\/[^/?#]+\/apply/.test(url);
}

// ── Field mapping ──────────────────────────────────────────────────────────

type FillFn = (page: any, profile: ApplicantProfile) => Promise<void>;

interface LinkedInField {
  name: string;           // form field name / identifier
  label: string;          // human-readable label
  type: FillField['type'];
  required: boolean;
  fill: FillFn;           // async fill action
}

/** Set of standard field names that need human review even if present */
const HUMAN_ONLY_FIELDS = new Set([
  'file(resume)', 'resume', 'attachment', 'cover letter',
]);

function phoneFill(page: any, profile: ApplicantProfile) {
  return page.fill('input[type="tel"], input[name="phoneNumber"], input[id="phoneNumber"]', profile.phone || '', { timeout: 5000 });
}

function linkedinFill(page: any, profile: ApplicantProfile) {
  return page.fill('input[name="linkedInUrl"], input[aria-label*="LinkedIn"]', profile.linkedin || '', { timeout: 5000 });
}

function githubFill(page: any, profile: ApplicantProfile) {
  return page.fill('input[name="githubUrl"], input[aria-label*="GitHub"]', profile.github || '', { timeout: 5000 });
}

function websiteFill(page: any, profile: ApplicantProfile) {
  return page.fill('input[name="websiteUrl"], input[aria-label*="website"]', profile.website || '', { timeout: 5000 });
}

function textFill(
  selector: string,
  value: string,
): FillFn {
  return async (page) => {
    await page.fill(selector, value, { timeout: 5000 });
  };
}

function selectFill(
  selector: string,
  value: string,
): FillFn {
  return async (page) => {
    await page.selectOption(selector, value, { timeout: 5000 });
  };
}

function checkboxFill(
  selector: string,
  value: string,
): FillFn {
  return async (page) => {
    await page.check(selector, { timeout: 5000 });
  };
}

function resumeFill(
  selector: string,
  resumePath: string,
): FillFn {
  return async (page) => {
    try {
      await page.setInputFiles(selector, resumePath, { timeout: 8000 });
    } catch {
      // Resume input may be hidden — try clicking then using setInputFiles
      const input = page.locator(selector).first();
      if (await input.isHidden()) {
        await input.setInputFiles(resumePath, { timeout: 8000 });
      }
    }
  };
}

// ── Step definitions ───────────────────────────────────────────────────────

/**
 * Returns ordered steps to fill for a LinkedIn Easy Apply form.
 * Each step has a fill action and optional "Next" button action.
 *
 * The function is called fresh for each page to handle dynamic form state.
 */
export interface LinkedInFormStep {
  name: string;
  label: string;
  fields: LinkedInField[];
  /** Selector for the "Next" button on this step (null on last step). */
  nextButton?: string;
}

export function buildLinkedInSteps(profile: ApplicantProfile, resumePath: string): LinkedInFormStep[] {
  return [
    {
      name: 'contact',
      label: 'Contact Info',
      fields: [
        {
          name: 'firstName',
          label: 'First Name',
          type: 'text',
          required: true,
          fill: textFill('input[name="firstName"]', profile.firstName),
        },
        {
          name: 'lastName',
          label: 'Last Name',
          type: 'text',
          required: true,
          fill: textFill('input[name="lastName"]', profile.lastName),
        },
        {
          name: 'email',
          label: 'Email',
          type: 'email',
          required: true,
          fill: textFill('input[name="email"]', profile.email),
        },
        {
          name: 'phone',
          label: 'Phone',
          type: 'phone',
          required: true,
          fill: phoneFill,
        },
        {
          name: 'linkedin',
          label: 'LinkedIn URL',
          type: 'url',
          required: false,
          fill: linkedinFill,
        },
        {
          name: 'github',
          label: 'GitHub URL',
          type: 'url',
          required: false,
          fill: githubFill,
        },
        {
          name: 'website',
          label: 'Website',
          type: 'url',
          required: false,
          fill: websiteFill,
        },
      ],
      nextButton: 'button[aria-label="Next"], button[type="submit"]:not([aria-label])',
    },
    {
      name: 'education',
      label: 'Education',
      fields: [
        {
          name: 'school',
          label: 'School',
          type: 'text',
          required: true,
          fill: textFill('input[name="school"]', profile.university),
        },
        {
          name: 'graduationYear',
          label: 'Graduation Year',
          type: 'text',
          required: true,
          fill: textFill('input[name=" graduationYear"], input[name="graduationYear"]', profile.graduationYear),
        },
      ],
      nextButton: 'button[aria-label="Next"], button[type="submit"]:not([aria-label])',
    },
    {
      name: 'resume',
      label: 'Resume',
      fields: [
        {
          name: 'resume',
          label: 'Resume (PDF)',
          type: 'file',
          required: true,
          fill: resumeFill('input[name="file(resume)"], input[type="file"]', resumePath),
        },
      ],
      nextButton: 'button[aria-label="Next"], button[type="submit"]:not([aria-label])',
    },
    {
      name: 'work_auth',
      label: 'Work Authorization',
      fields: [
        {
          name: 'workAuthorization',
          label: 'Are you authorized to work in the US?',
          type: 'select',
          required: true,
          fill: selectFill('select[name="workAuthorization"] option[value*="authorized"]', 'AUTHORIZED'),
        },
      ],
      nextButton: 'button[aria-label="Next"], button[type="submit"]:not([aria-label])',
    },
    {
      name: 'submit',
      label: 'Submit',
      fields: [
        // No auto-fillable fields on final step — just review
      ],
      // No Next button on final step
    },
  ];
}

// ── Fill a single step ─────────────────────────────────────────────────────

interface StepResult {
  name: string;
  filledFields: string[];
  skippedFields: string[];
  error?: string;
}

export async function fillLinkedInStep(
  page: any,
  step: LinkedInFormStep,
): Promise<StepResult> {
  const filledFields: string[] = [];
  const skippedFields: string[] = [];

  for (const field of step.fields) {
    try {
      await field.fill(page, page.__profile ?? {});
      filledFields.push(field.name);
    } catch {
      // Field not found or not interactable — skip
      skippedFields.push(field.name);
    }
  }

  return {
    name: step.name,
    filledFields,
    skippedFields,
  };
}

// ── Analyze only (no browser — pure API/fetch based) ─────────────────────

/**
 * LinkedIn job pages are heavily authenticated. For analyze mode (without browser),
 * we return the standard Easy Apply field list so the caller knows what to expect.
 *
 * For actual fill, use fillLinkedInForm() below.
 */
export async function analyzeLinkedInForm(
  _link: string,
  profile: ApplicantProfile,
): Promise<{ applyUrl: string; filledFields: FillField[]; humanFields: FillField[] }> {
  const jobId = parseLinkedInJobId(_link);
  const applyUrl = jobId
    ? `https://www.linkedin.com/jobs/view/${jobId}/apply`
    : _link;

  const filledFields: FillField[] = [
    { name: 'firstName',  label: 'First Name',         type: 'text',  required: true,  value: profile.firstName,         source: 'profile' },
    { name: 'lastName',   label: 'Last Name',            type: 'text',  required: true,  value: profile.lastName,          source: 'profile' },
    { name: 'email',      label: 'Email',               type: 'email', required: true,  value: profile.email,            source: 'profile' },
    { name: 'phone',      label: 'Phone',               type: 'phone', required: true,  value: profile.phone || undefined, source: 'profile' },
    { name: 'linkedin',   label: 'LinkedIn URL',        type: 'url',   required: false, value: profile.linkedin || undefined, source: 'profile' },
    { name: 'github',     label: 'GitHub URL',          type: 'url',   required: false, value: profile.github || undefined, source: 'profile' },
    { name: 'website',    label: 'Website',            type: 'url',   required: false, value: profile.website || undefined, source: 'profile' },
  ].filter(f => f.value) as FillField[];

  const humanFields: FillField[] = [
    { name: 'school',             label: 'School',                  type: 'text',   required: true,  source: 'needs_human' },
    { name: 'graduationYear',     label: 'Graduation Year',         type: 'text',   required: true,  source: 'needs_human' },
    { name: 'resume',             label: 'Resume (PDF)',            type: 'file',   required: true,  source: 'needs_human' },
    { name: 'workAuthorization', label: 'Work Authorization',      type: 'select', required: true,  source: 'needs_human' },
  ];

  return { applyUrl, filledFields, humanFields };
}

// ── Fill the full multi-step form ────────────────────────────────────────

export interface LinkedInFillResult {
  steps: StepResult[];
  completed: boolean;
  screenshotPath: string;
}

export async function fillLinkedInForm(
  page: any,
  profile: ApplicantProfile,
  resumePath: string,
): Promise<LinkedInFillResult> {
  page.__profile = profile;

  const steps = buildLinkedInSteps(profile, resumePath);
  const stepResults: StepResult[] = [];
  let completed = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Fill fields on this step
    const result = await fillLinkedInStep(page, step);
    stepResults.push(result);

    // Click Next if this isn't the final step
    if (step.nextButton) {
      try {
        const nextBtn = page.locator(step.nextButton).first();
        if (await nextBtn.isVisible({ timeout: 3000 })) {
          await nextBtn.click({ timeout: 8000 });
          // Wait for next step to load
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        }
      } catch {
        // Next button not found — this might be the final/submit step
      }
    } else {
      // No Next button → this is the last step (review / submit)
      completed = true;
    }
  }

  const ts = Date.now();
  const screenshotPath = `/tmp/auto-fill-linkedin-${ts}.png`;
  await page.screenshot({ path: screenshotPath });

  return { steps: stepResults, completed, screenshotPath };
}
