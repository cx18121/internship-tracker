#!/usr/bin/env python3
"""
JobSpy runner — scrapes LinkedIn, Indeed, Glassdoor.
Reads search config from data/jobspy-config.json, outputs JSON to stdout.
Usage: python3 scripts/jobspy_runner.py [config_path]
"""
import sys
import json
import hashlib
import re
import traceback
from pathlib import Path

INTERN_TITLE_RE = re.compile(r'\bintern(ship)?\b', re.IGNORECASE)

# LinkedIn /jobs/view/<id> URLs go dead within days of a posting closing (301 to
# expired_jd_redirect). Rewriting to /jobs/search/?currentJobId=<id> stays valid
# even after the job closes — LinkedIn shows the title, company, and an honest
# "No longer accepting applications" notice instead of a broken redirect.
LINKEDIN_VIEW_RE = re.compile(r'^https?://(?:[a-z]+\.)?linkedin\.com/jobs/view/(\d+)(?:[/?#].*)?$', re.IGNORECASE)


def stabilize_linkedin_link(url: str) -> str:
    m = LINKEDIN_VIEW_RE.match(url or '')
    if not m:
        return url
    return f"https://www.linkedin.com/jobs/search/?currentJobId={m.group(1)}"

# Aggregator/job-board domains that do NOT host direct applications.
# These sites scrape and republish listings from company career pages.
AGGREGATOR_DOMAINS = {
    'trabajo.org', 'recruit.net', 'jooble.org', 'jooble.com',
    'indeed.co.uk', 'indeed.com.my', 'glassdoor.com.au',
    'simplyhired.com', 'ziprecruiter.com', 'careerbliss.com',
    'casalesadvantage.com', 'tarta.ai', 'talent.com', 'jobylon.com',
    'jobrapido.com', 'jobsite.co.uk', 'cvlibrary.co.uk', 'totaljobs.com',
    'monster.com', 'dice.com', 'careerbuilder.com', 'hotjobs.com',
    'beyond.com', 'employmentguide.com', 'jobs2careers.com', 'neuvoo.com',
    'careerjet.com', 'instahyre.com', 'workopolis.com', 'elut.ca',
    'trovit.com', 'kariera.gr', 'jobbol.com',
    'jobleads.com', 'learn4good.com',
}


def is_aggregator_link(url: str) -> bool:
    """Return True if this URL passes through an aggregator intermediary.
    Detects:
      1. Known aggregator domains (indeed.co.uk, trabajo.org, etc.)
      2. Redirect/click-tracking params: utm_source, ref=, redirect=, goto/
      3. Third-partyATS redirects (e.g. greenhouse.io/?gh_jid= via third-party domain)
    """
    if not url:
        return True
    # Parse once and inspect domain + query params directly. The previous version
    # did naive substring matching on the whole URL, which caught false positives
    # like ?url-shortener=... matching the `url=` pattern.
    try:
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(url)
        domain = parsed.netloc.lower().replace('www.', '').replace(':443', '').replace(':80', '')
        if any(agg in domain for agg in AGGREGATOR_DOMAINS):
            return True
        # Redirect/tracker params — match exact param names, not arbitrary substrings.
        REDIRECT_PARAMS = {'utm_source', 'ref', 'redirect', 'goto', 'url', 'target'}
        params = parse_qs(parsed.query, keep_blank_values=True)
        if any(p in params for p in REDIRECT_PARAMS):
            return True
        # `click?` is a path pattern (e.g. .../click?id=...) rather than a param.
        if 'click?' in url.lower():
            return True
    except Exception:
        pass
    return False


def is_ats_direct(url: str) -> bool:
    """Return True if this URL is a known direct ATS/career page."""
    if not url:
        return False
    try:
        from urllib.parse import urlparse
        domain = urlparse(url).netloc.lower().replace('www.', '').replace(':443', '')
        ats_domains = {
            'linkedin.com', 'indeed.com', 'glassdoor.com',
            'joinhandshake.com', 'myworkdayjobs.com',
            'greenhouse.io', 'boards.greenhouse.io', 'job-boards.greenhouse.io',
            'lever.co', 'ashbyhq.com', 'workday.com', 'taleo.net',
            'icims.com', 'smartrecruiters.com', 'bamboohr.com',
            'jobvite.com', 'workable.com', 'jobs2web.com', 'rippling.com',
            'amazon.jobs', 'databricks.com', 'bytedance.com',
        }
        return any(ats in domain for ats in ats_domains)
    except Exception:
        return False


def is_intern_posting(title: str, job_type: str) -> bool:
    """Return True only if the posting is clearly an internship, not a full-time role."""
    if INTERN_TITLE_RE.search(title):
        return True
    if job_type and job_type.lower().replace('-', '').replace(' ', '') == 'internship':
        return True
    return False


try:
    from jobspy import scrape_jobs
    import pandas as pd
except ImportError as e:
    print(f"[jobspy] Import error: {e}", file=sys.stderr)
    print("[]")
    sys.exit(0)


def main():
    config_path = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).parent.parent / "data" / "jobspy-config.json")

    try:
        with open(config_path) as f:
            config = json.load(f)
    except Exception as e:
        print(f"[jobspy] Failed to read config {config_path}: {e}", file=sys.stderr)
        print("[]")
        sys.exit(0)

    sites = config.get("sites", ["linkedin", "indeed", "glassdoor"])
    searches = config.get("searches", [])
    all_jobs = []
    seen_keys = set()
    skipped_dead = 0

    for search in searches:
        keywords = search.get("keywords", "")
        location = search.get("location", "USA")
        results_wanted = search.get("results_wanted", 30)
        hours_old = search.get("hours_old", 72)
        is_remote = search.get("remote", False)
        use_sites = search.get("sites", sites)

        print(f"[jobspy] Searching: '{keywords}' in '{location}' on {use_sites}", file=sys.stderr)

        try:
            df = scrape_jobs(
                site_name=use_sites,
                search_term=keywords,
                location=location,
                results_wanted=results_wanted,
                hours_old=hours_old,
                country_indeed="USA",
                is_remote=is_remote,
                verbose=0,
                # Pull full descriptions for LinkedIn results. Adds one page-fetch per result,
                # so the LinkedIn portion of the cycle takes 3-5x longer. Trade-off accepted for
                # description-aware scoring.
                linkedin_fetch_description=True,
                # HTML, not markdown — JobSpy's markdown converter escapes
                # punctuation (`\$4,582\.93`, `\-`) and emits literal `**bold**`
                # / `### heading` markers that render as text in the UI's
                # plain-text view. The TS side strips HTML via stripHtml,
                # matching every other ATS poller's pipeline.
                description_format="html",
            )

            if df is None or df.empty:
                print(f"[jobspy] No results for '{keywords}'", file=sys.stderr)
                continue

            count = 0
            for _, row in df.iterrows():
                title = str(row.get("title") or "").strip()
                # `pd.NaN` is truthy in Python (NaN is a non-zero float), so the
                # earlier `or ""` fallback let NaN through and `str(NaN)` leaked
                # the literal string "nan" as the company name. Use pd.notna.
                company_val = row.get("company")
                company = str(company_val).strip() if pd.notna(company_val) else ""
                link = stabilize_linkedin_link(str(row.get("job_url") or "").strip())
                if not title or not link or not company:
                    continue

                # Skip aggregator/redirect links — they republish listings, not host applications
                if is_aggregator_link(link):
                    skipped_dead += 1
                    continue

                job_type_val = row.get("job_type")
                job_type = str(job_type_val).strip() if pd.notna(job_type_val) else ""
                if not is_intern_posting(title, job_type):
                    continue

                dedup_key = hashlib.md5(f"{company}{title}{link}".encode()).hexdigest()
                if dedup_key in seen_keys:
                    continue
                seen_keys.add(dedup_key)

                site_val = row.get("site")
                source = str(site_val).title() if pd.notna(site_val) else "JobSpy"

                location_val = row.get("location")
                loc = str(location_val).strip() if pd.notna(location_val) else ""

                date_val = row.get("date_posted")
                posted_at = ""
                if pd.notna(date_val):
                    try:
                        posted_at = pd.Timestamp(date_val).isoformat()
                    except Exception:
                        posted_at = str(date_val)

                desc_val = row.get("description")
                # Slice generously on the HTML side — tags inflate length 2-3x
                # over plain text. The TS poller strips HTML then re-slices to
                # 4000 chars of text, matching every other ATS description path.
                description = str(desc_val)[:20000].strip() if pd.notna(desc_val) else ""

                all_jobs.append({
                    "title": title,
                    "company": company,
                    "location": loc,
                    "link": link,
                    "description": description,
                    "source": source,
                    "postedAt": posted_at,
                })
                count += 1

            print(f"[jobspy] '{keywords}': {count} new jobs", file=sys.stderr)

        except Exception as e:
            print(f"[jobspy] Error for '{keywords}': {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            continue

    print(f"[jobspy] Total unique jobs: {len(all_jobs)}", file=sys.stderr)
    if skipped_dead > 0:
        print(f"[jobspy] Skipped {skipped_dead} dead links (HTTP 4xx/5xx)", file=sys.stderr)
    print(json.dumps(all_jobs))


if __name__ == "__main__":
    main()
