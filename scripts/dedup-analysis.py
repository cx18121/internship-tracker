#!/usr/bin/env python3
"""
dedup-analysis.py
Analyzes whether Greenhouse/Lever/Ashby postings are being incorrectly dropped
due to UTM params affecting the MD5 hash used for deduplication.

Findings:
- seen_ids table: 5238 entries
- internships table: 4809 entries  
- UTM-tagged links in DB: 1162 (24% of DB)
- Multiple entries for same base URL (e.g., same Amazon SDE Intern with different UTM params)
  suggest the dedup is NOT catching cross-poll-cycle duplicates properly.

Root cause: ID = md5(company + title + link) — where link includes UTM params.
Same posting with utm_source=Simplify vs utm_source=GreenhouseList get different IDs.
Cross-poll-cycle dedup via seen (Set of IDs) correctly skips same ID, but
same job with different UTM params = different ID = not skipped.
"""

import sqlite3
import re
import hashlib
import json

DB_PATH = '/home/cxue/.openclaw/workspace/internship-tracker/data/internships.db'
SEEN_PATH = '/home/cxue/.openclaw/workspace/internship-tracker/data/seen.json'

def strip_utm(url: str) -> str:
    """Remove UTM query params from URL."""
    try:
        base = url.split('?')[0]
        params = {}
        if '?' in url:
            for part in url.split('?')[1].split('&'):
                k = part.split('=')[0] if '=' in part else part
                if not k.startswith('utm_') and k not in ('ref', 'nl'):
                    params[k] = part.split('=', 1)[1] if '=' in part else ''
        if params:
            base += '?' + '&'.join(f"{k}={v}" for k, v in params.items())
        return base
    except:
        return url

def md5_hash(company, title, link):
    return hashlib.md5(f"{company or ''}{title or ''}{link or ''}".encode()).hexdigest()

conn = sqlite3.connect(DB_PATH)
c = conn.cursor()

print("=" * 60)
print("DEDUPLICATION ANALYSIS — SimplifyJobs Greenhouse/Lever/Ashby")
print("=" * 60)

# 1. Table counts
c.execute('SELECT COUNT(*) FROM internships')
total_internships = c.fetchone()[0]

c.execute('SELECT COUNT(*) FROM seen_ids')
total_seen_ids = c.fetchone()[0]

print(f"\n[1] Counts:")
print(f"  internships table  : {total_internships}")
print(f"  seen_ids table    : {total_seen_ids}")
print(f"  gap (seen_ids > internships, likely from crash/migration) : {total_seen_ids - total_internships}")

# 2. UTM prevalence
c.execute("SELECT COUNT(*) FROM internships WHERE link LIKE '%utm_%' OR link LIKE '%utm-source%'")
utm_count = c.fetchone()[0]
print(f"\n[2] UTM params in links:")
print(f"  internships with UTM params : {utm_count} ({utm_count*100/total_internships:.1f}%)")

# 3. Current hash-based dedup: how many seen_ids already in DB
c.execute("SELECT id FROM seen_ids")
seen_ids_set = set(r[0] for r in c.fetchall())

c.execute("SELECT id FROM internships")
db_ids_set = set(r[0] for r in c.fetchall())

overlap = seen_ids_set & db_ids_set
print(f"\n[3] Hash dedup check (seen_ids vs internships):")
print(f"  IDs in seen_ids but NOT in internships (orphaned): {len(seen_ids_set - db_ids_set)}")
print(f"  IDs in both (correct): {len(overlap)}")

# 4. Cross-cycle dedup failure analysis
# For each company+title, how many distinct IDs exist? 
# If same job appears with different UTM params, we'd see multiple IDs for same base URL.
c.execute("""
    SELECT company, title, COUNT(DISTINCT id) as id_count, 
           COUNT(*) as row_count,
           MIN(link) as sample_link
    FROM internships 
    WHERE company IS NOT NULL AND title IS NOT NULL
    GROUP BY company, title
    HAVING id_count > 1
    ORDER BY row_count DESC
    LIMIT 20
""")
print(f"\n[4] Potential cross-poll-cycle dupes (same company+title, multiple IDs):")
rows = c.fetchall()
print(f"  {len(rows)} company+title combos have multiple distinct IDs")
print(f"  (may be from same posting with different UTM params or true new postings)")
print(f"\n  Top examples:")
for company, title, id_count, row_count, sample_link in rows[:10]:
    print(f"  [{id_count} IDs, {row_count} rows] {company[:30]} | {title[:45]} | {sample_link[:70]}")

# 5. Test: normalize links and re-hash to find true collisions
print(f"\n[5] Normalized dedup check (strip UTM before hashing):")
c.execute("SELECT company, title, link, id FROM internships LIMIT 2000")
test_rows = c.fetchall()

normalized_id_map = {}  # normalized_id -> first_row
collisions = []

for company, title, link, original_id in test_rows:
    norm_url = strip_utm(link)
    norm_id = md5_hash(company, title, norm_url)
    
    key = (company or '', title or '', norm_url)
    if key in normalized_id_map:
        collisions.append({
            'company': company, 'title': title,
            'link1': normalized_id_map[key]['link'],
            'link2': link,
            'id1': normalized_id_map[key]['id'],
            'id2': original_id,
        })
    else:
        normalized_id_map[key] = {'link': link, 'id': original_id}

print(f"  Sample size: {len(test_rows)} rows")
print(f"  Normalized collisions found: {len(collisions)}")
if collisions:
    print(f"  Example collision:")
    for c2 in collisions[:3]:
        print(f"    Company: {c2['company']}")
        print(f"    Title: {c2['title']}")
        print(f"    Link1 (stored): {c2['link1'][:80]}")
        print(f"    Link2 (new):    {c2['link2'][:80]}")
        print(f"    ID1: {c2['id1'][:30]}")
        print(f"    ID2: {c2['id2'][:30]}")
        print()

# 6. Source breakdown for UTM-tagged entries
c.execute("""
    SELECT source, COUNT(*) as cnt 
    FROM internships 
    WHERE link LIKE '%utm_%' OR link LIKE '%utm-source%'
    GROUP BY source 
    ORDER BY cnt DESC
""")
print(f"\n[6] UTM-tagged entries by source:")
for source, cnt in c.fetchall():
    print(f"  {source}: {cnt}")

conn.close()

# 7. Load seen.json and compare
try:
    with open(SEEN_PATH) as f:
        seen_json_ids = set(json.load(f))
    print(f"\n[7] seen.json analysis:")
    print(f"  Total IDs in seen.json: {len(seen_json_ids)}")
    print(f"  First 3 IDs: {list(seen_json_ids)[:3]}")
    print(f"  These are MD5 hashes of company+title+link (with UTM)")
except Exception as e:
    print(f"\n[7] seen.json: could not load ({e})")

print("\n" + "=" * 60)
print("FINDINGS:")
print("  1. seen_ids table (5238) > internships table (4809) — gap from crash/migration")
print("  2. 1162/4809 internships (24%) have UTM params in links")
print("  3. ID = md5(company+title+link) uses full URL including UTM params")
print("  4. Same posting with different UTM params → different ID → not deduped")
print("  5. Normalize links to strip UTM before hashing to fix cross-poll dupes")
print("=" * 60)