"""Proves every $("id") the console reaches for exists in its markup.

curator.html is one hand-written file with no build step, so deleting a card
leaves the handler that referenced it behind — and `$("gone").addEventListener`
throws at load, taking the ENTIRE dashboard with it, not just that feature.
This found two such references on 2026-09-05 after the Library rewrite.

Run from the repo root:  python scripts/checks/check-console-ids.py
"""
import io, re, sys
s = io.open('curator.html', encoding='utf-8', newline='').read()
html_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', s))
# ids the script creates at runtime rather than declaring in markup
runtime_ids = {"lwUndoBar", "lwUndoBtn"}
used = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', s))
missing = sorted(used - html_ids - runtime_ids)
print("ids referenced:", len(used), "| declared:", len(html_ids))
if missing:
    print("MISSING FROM MARKUP:")
    for m in missing:
        for n, line in enumerate(s.split('\r\n'), 1):
            if '$("%s")' % m in line:
                print("  %-22s first used line %d" % (m, n)); break
    sys.exit(1)
print("every referenced id exists")
