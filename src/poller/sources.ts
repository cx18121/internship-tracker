import { ATS_SOURCES } from './ats';

export { ATS_SOURCES };

/** Sources whose boards are re-polled every cycle, so absence means the job closed. */
export const POLLED_SOURCES: ReadonlySet<string> = new Set([...ATS_SOURCES, 'YC WaaS']);
