import * as fs from 'fs';
import * as path from 'path';
import { ApplicantProfile, AutoApplySettings } from './types.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const PROFILE_PATH = path.join(DATA_DIR, 'applicant-profile.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'auto-apply-settings.json');

const PROFILE_DEFAULTS: ApplicantProfile = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  linkedin: '',
  github: '',
  website: '',
  university: '',
  graduationYear: '',
  resumeUrl: '',
  coverLetterTemplate: '',
};

const SETTINGS_DEFAULTS: AutoApplySettings = {
  enabled: false,
  mode: 'fill',
  minScore: 70,
  minLabel: 'Strong',
  providers: ['greenhouse', 'lever', 'ashby'],
  dailyLimit: 20,
  requireReview: true,
};

export function loadProfile(): ApplicantProfile {
  try {
    return { ...PROFILE_DEFAULTS, ...JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8')) };
  } catch {
    return { ...PROFILE_DEFAULTS };
  }
}

export function saveProfile(profile: Partial<ApplicantProfile>): ApplicantProfile {
  const current = loadProfile();
  const updated = { ...current, ...profile };
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

export function loadSettings(): AutoApplySettings {
  try {
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

export function saveSettings(settings: Partial<AutoApplySettings>): AutoApplySettings {
  const current = loadSettings();
  const updated = { ...current, ...settings };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}
