import { Resend } from 'resend';
import type { Internship } from '../../lib/types';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scoreBadgeColor(label: string | null | undefined): string {
  if (label === 'A') return '#16a34a';
  if (label === 'B') return '#2563eb';
  return '#6b7280';
}

function buildHtml(postings: Internship[]): string {
  const rows = postings.map(p => {
    const company = escapeHtml(p.company || 'Unknown');
    const title = escapeHtml(p.title || 'Internship');
    const location = escapeHtml(p.location || 'Unknown');
    const source = escapeHtml(p.source || '');
    const salary = p.salaryText ? ` · ${escapeHtml(p.salaryText)}` : '';
    const badgeColor = scoreBadgeColor(p.scoreLabel);
    const badge = `<span style="background:${badgeColor};color:white;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap;">${escapeHtml(p.scoreLabel ?? 'C')} · ${p.score ?? 0}</span>`;
    const applyBtn = p.link
      ? `<a href="${escapeHtml(p.link)}" style="display:inline-block;background:#2563eb;color:white;padding:6px 14px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:500;">Apply</a>`
      : '';
    return `
      <div style="border:1px solid #e5e7eb;border-radius:6px;padding:14px 16px;margin-bottom:12px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td><strong style="font-size:15px;color:#111;">${company}</strong><div style="font-size:13px;color:#374151;margin-top:2px;">${title}</div></td>
          <td align="right" valign="top">${badge}</td>
        </tr></table>
        <div style="font-size:12px;color:#6b7280;margin:6px 0 10px;">${location} · ${source}${salary}</div>
        ${applyBtn}
      </div>`;
  }).join('');

  const count = postings.length;
  const heading = `${count} new internship match${count !== 1 ? 'es' : ''}`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;padding:20px;margin:0;">
  <div style="max-width:600px;margin:0 auto;background:white;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
    <div style="background:#0f172a;padding:20px 24px;">
      <h1 style="color:white;margin:0;font-size:18px;font-weight:600;">${heading}</h1>
    </div>
    <div style="padding:16px 24px;">${rows}</div>
    <div style="padding:12px 24px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
      Sent by Internship Tracker — adjust your filters in notification settings.
    </div>
  </div>
</body></html>`;
}

export async function sendEmailAlert(
  postings: Internship[],
  recipients: string[],
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[email] RESEND_API_KEY not set; skipping email');
    return false;
  }
  if (recipients.length === 0) {
    console.warn('[email] No email recipients configured; skipping');
    return false;
  }

  const from = process.env.RESEND_FROM || 'Internship Tracker <onboarding@resend.dev>';
  const count = postings.length;
  const subject = `[Tracker] ${count} new internship match${count !== 1 ? 'es' : ''}`;

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: recipients,
      subject,
      html: buildHtml(postings),
    });
    if (error) {
      console.error('[email] Resend error:', error);
      return false;
    }
    console.log(`[email] Sent to ${recipients.length} recipient(s)`);
    return true;
  } catch (err) {
    console.error('[email] send failed:', err);
    return false;
  }
}
