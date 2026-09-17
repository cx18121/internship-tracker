/** Source labels the ATS pollers write. */
export const ATS_SOURCES = ['Greenhouse', 'Lever', 'Ashby', 'Workday', 'iCIMS', 'SmartRecruiters', 'Rippling', 'Workable'] as const;

/** Sources whose boards are re-polled every cycle, so absence means the job closed. */
export const POLLED_SOURCES: ReadonlySet<string> = new Set([...ATS_SOURCES, 'YC WaaS']);
