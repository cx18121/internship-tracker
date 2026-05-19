export interface FillField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'phone' | 'file' | 'textarea' | 'select' | 'checkbox' | 'url';
  required: boolean;
  value?: string;
  source: 'profile' | 'needs_human';
}

export interface FillReport {
  internshipId: string;
  company: string;
  title: string;
  provider: string;
  applyUrl: string;
  filledFields: FillField[];
  humanFields: FillField[];
  /** true only when zero required humanFields — means submit could be automated in future */
  canAutoSubmit: boolean;
  fetchedAt: string;
  error?: string;
}

export interface ApplicantProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  website: string;
  university: string;
  graduationYear: string;
  /** Hosted URL for resume (PDF) — used as a text field fallback */
  resumeUrl: string;
  /** Default cover letter template (plain text) */
  coverLetterTemplate: string;
}

export interface AutoApplySettings {
  enabled: boolean;
  /** fill = analyze + notify only; submit = actually POST the form (future) */
  mode: 'fill' | 'submit';
  minScore: number;
  minLabel: 'Excellent' | 'Strong' | 'Good';
  providers: string[];
  dailyLimit: number;
  requireReview: boolean;
}
