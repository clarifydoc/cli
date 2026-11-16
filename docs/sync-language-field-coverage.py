#!/usr/bin/env python3
"""Sync the language-field-coverage artifacts.

Source of truth: the six matrices in language-field-coverage-md/ (next to this
script). Targets (both next to this script):
  1. language-field-coverage-report.html (in place)
  2. language-field-coverage.md (the markdown doc)

The markdown doc keeps its own conventions (### Gaps — ... heading, per-section
field line, no `\\*` legend line); the HTML keeps its generated design. All
paths are relative to this script, so the folder is self-contained.

Idempotent: safe to re-run any time. The one-shot editorial edits (methodology
sentence, legend, summary coverage values, core-fields key finding, CSS, the
.sub sentence) are applied only if the new state is not already present, and in
that case the original state is asserted. Everything derived from the matrices
(tables, rows, gap panels/bullets) is re-derived on every run. On its first run
the script snapshots both targets into backup-sync/ (never overwriting an
existing snapshot).

Run:  python3 sync-language-field-coverage.py

Provenance: this is the sync step of the D/N classification pipeline (the
classification step itself is a one-off; the 16 validated false-negative flips
and the D-sets are already baked into the matrices).
"""
import os, re, shutil

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WS_MD = os.path.join(SCRIPT_DIR, "language-field-coverage-md")
HTML = os.path.join(SCRIPT_DIR, "language-field-coverage-report.html")
REPO_MD = os.path.join(SCRIPT_DIR, "language-field-coverage.md")
BAK = os.path.join(SCRIPT_DIR, "backup-sync")

MODELS = ["FunctionInfo", "ClassInfo", "ImportInfo", "ExportInfo", "RouteInfo", "PropertyInfo"]

CLASS_OF = {"\u2713": "w", "D": "d", "N": "n", "\u2717": "req-m"}


def load_md(path):
    lines = open(path, encoding="utf-8").read().split("\n")
    si = next(i for i, l in enumerate(lines) if l.startswith("|") and set(l) <= set("|-"))
    def cells(l):
        p = [x.strip() for x in l.split("|")]
        if p and p[0] == "": p = p[1:]
        if p and p[-1] == "": p = p[:-1]
        return p
    hdr = cells(lines[si - 1])
    rows = [cells(l) for l in lines[si + 1:] if l.startswith("|")]
    gi = next((i for i, l in enumerate(lines) if l.startswith("## Gaps")), None)
    bullets, i = [], gi + 1
    if i < len(lines) and lines[i] == "":  # blank line between heading and bullets
        i += 1
    while i < len(lines) and lines[i].startswith("- `"):
        bullets.append(lines[i]); i += 1
    assert bullets, path
    never = next((l for l in lines if l.startswith("_Never produces")), None)
    return {
        "title": lines[0], "fieldline": lines[2], "hdr": hdr, "fields": hdr[1:-1],
        "rows": rows, "table": lines[si - 1:si + 1 + len(rows)],
        "bullets": bullets, "never": never,
    }


def md_to_html_thead(hdr):
    """Rebuild the column header row from the matrix header, in the report's
    original format: one <th> per column (field name, with a required/optional
    tooltip) and `coverage` for the cov column.

    (The original one-shot sync dropped this row; deriving it from the matrix
    keeps the table a pure function of the source of truth.)"""
    out = ["<thead><tr><th>language</th>"]
    for f in hdr[1:-1]:
        star = f.endswith("*")
        name = f[:-1] if star else f
        out.append('<th title="%s: %s">%s</th>' % ("required" if star else "optional", name, name))
    out.append("<th>coverage</th></tr></thead>")
    return "".join(out)


def md_to_html_row(langcell, cells, cov):
    lang = langcell.split("`")[0].strip()
    tag = langcell.split("`")[1].strip("`") if "`" in langcell else ""
    out = ['<td class="lang">%s' % lang + ('<span class="tag">%s</span>' % tag if tag else "") + "</td>"]
    for v in cells:
        out.append('<td class="%s">%s</td>' % (CLASS_OF[v], v))
    out.append('<td class="cov">%s</td>' % cov)
    return "<tr>" + "".join(out) + "</tr>"


def gap_bullet_html(field, k, d, n):
    parts = []
    if d: parts.append('<span class="dd">D</span>: ' + ", ".join(d))
    if n: parts.append('<span class="nn">N</span>: ' + ", ".join(n))
    return "%s: missing in %d \u2192 %s" % (field, k, "; ".join(parts))


# ---------------------------------------------------------------- workspace data
data = {}
for m in MODELS:
    d = load_md(os.path.join(WS_MD, m + ".md"))
    data[m] = d
    producers = {r[0].split("`")[0].strip() for r in d["rows"] if "\u2713" in r[1:-1]}
    for r in d["rows"]:
        lang = r[0].split("`")[0].strip()
        for f, v in zip(d["fields"], r[1:-1]):
            if v == "\u00b7":
                raise SystemExit("workspace still has \u00b7 in %s/%s/%s (run the D/N classification first)" % (m, lang, f))
            if v not in CLASS_OF:
                raise SystemExit("unknown symbol %r in %s" % (v, m))
    # sanity: bullet counts
    for b in d["bullets"]:
        k = int(re.search(r"missing in (\d+)", b).group(1))
        listed = sum(len(re.findall(r"\b\w+\b", p)) for p in re.findall(r"\*\*[DN]\*\* ([^.]+?)(?=;|\Z)", b))
        if listed != k:
            raise SystemExit("bullet count drift in %s: %s" % (m, b[:80]))

# ---------------------------------------------------------------- backups (first run only)
os.makedirs(BAK, exist_ok=True)
for src, name in [(REPO_MD, "repo-doc.md"), (HTML, "report.html")]:
    dst = os.path.join(BAK, name)
    if not os.path.exists(dst):
        shutil.copy2(src, dst)
print("backups -> " + BAK)

# ---------------------------------------------------------------- 1. repo doc
s = open(REPO_MD, encoding="utf-8").read()

# (a) methodology paragraph: append the D/N classification sentence (once)
dn_sentence = (" Not-written fields are then classified **D** (deliverable \u2014 the concept exists in that language and is "
               "extractable; a real gap) or **N** (no such concept in that language/framework; a legitimate absence).")
if dn_sentence not in s:
    old_method_tail = "Shared helpers in `plugins/shared/` are attributed to the languages that use them."
    assert old_method_tail in s
    s = s.replace(old_method_tail, old_method_tail + dn_sentence)

# (b) legend (replace whatever legend line is there)
new_legend = ("**Legend:** \u2713 = written \u00b7 `D` = deliverable (not written, but the concept exists and is extractable \u2014 a real gap) "
              "\u00b7 `N` = not deliverable (no such concept in that language/framework \u2014 a legitimate absence) "
              "\u00b7 \u2717 = a *required* field that is missing (a real gap) \u00b7 `ts`/`regex` = parsing strategy.")
old_legend = next((l for l in s.split("\n") if l.startswith("**Legend:**")), None)
if old_legend is not None and old_legend != new_legend:
    s = s.replace(old_legend, new_legend)
assert new_legend in s

# (c) summary table: avg coverage values (post-flip)
for old, new in [
    ("| FunctionInfo | 37 (9/28) | 80/80 | \u2705 yes | 14.7/37 |",
     "| FunctionInfo | 37 (9/28) | 80/80 | \u2705 yes | 14.8/37 |"),
    ("| RouteInfo | 42 (7/35) | 49/80 | \u2705 yes | 9.1/42 |",
     "| RouteInfo | 42 (7/35) | 49/80 | \u2705 yes | 9.2/42 |"),
]:
    if new not in s:
        assert old in s, old
        s = s.replace(old, new)

# (d) key findings: core-fields bullet (replace whatever is there)
new_core = ("- **Fields set by core, not plugins** (the static read can't see core post-passes, so they show as D in the tables; "
            "core applies them at runtime): `FunctionInfo.doc`/`ClassInfo.doc` (doc-comment pass \u2014 written wherever the language manifest "
            "declares `docComments`; the non-program languages that don't are N), `RouteInfo.redirectsTo`/`webhook`/`consumed`/`implementedBy`/"
            "`resolvedBy`/`basePath`/`testCoverage`/`pathUnresolved` (server-redirects, webhook-routes, client-proxies, route resolvers, "
            "template resolution, test-coverage join).")
old_core = next((l for l in s.split("\n") if l.startswith("- **Fields set by core")), None)
if old_core is not None and old_core != new_core:
    s = s.replace(old_core, new_core)
assert new_core in s

# (e) per-model sections: swap in the workspace tables + D/N-split gap bullets
lines = s.split("\n")
for m in MODELS:
    hi = next(i for i, l in enumerate(lines) if l == "## %s" % m)
    # next '## ' heading AFTER hi (computed fresh: earlier replacements may shift lines)
    hnext = next((i for i in range(hi + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    sec = lines[hi:hnext]
    # table block: header row .. last row
    ti = sec.index(next(l for l in sec if l.startswith("| language |")))
    t_end = ti + 1
    while t_end < len(sec) and sec[t_end].startswith("|"):
        t_end += 1
    tbl = data[m]["table"]
    assert len(tbl) == t_end - ti, (m, len(tbl), t_end - ti)
    sec[ti:t_end] = tbl
    # gaps bullets: from the gap heading to the end of the section (footer last)
    gi = next(i for i, l in enumerate(sec) if l.startswith("### Gaps"))
    fb = gi + 1
    if fb < len(sec) and sec[fb] == "":
        fb += 1
    bullets = data[m]["bullets"]
    j = fb
    while j < len(sec) and sec[j].startswith("- `"):
        j += 1
    tail = sec[j:]  # blank line + never footer (or blanks)
    sec = sec[:fb] + bullets + tail
    lines[hi:hnext] = sec
s = "\n".join(lines)
open(REPO_MD, "w", encoding="utf-8").write(s)
print("repo doc synced: %d lines" % len(s.split(chr(10))))

# ---------------------------------------------------------------- 2. html report
h = open(HTML, encoding="utf-8").read()

# CSS: the unused td.m rule becomes d/n + gap label rules (once)
old_m = "td.m{background:#e6edf3;color:#8b949e;}"
new_m = ("td.d{background:#aceebb;color:#1a7f37;font-weight:600;} td.n{background:#e6edf3;color:#8b949e;}"
         " .gap .dd{color:#1a7f37;font-weight:700;} .gap .nn{color:#8b949e;font-weight:700;}")
if old_m in h:
    h = h.replace(old_m, new_m)
assert "td.d{" in h

# .sub: one sentence on the D/N overlay (once)
old_sub_tail = "Generated from the TypeScript compiler API.</div>"
new_sub_tail = ("Generated from the TypeScript compiler API. Unwritten fields are then classified <b>D</b> (deliverable \u2014 the concept exists and is "
                "extractable; a real gap) or <b>N</b> (no such concept in that language/framework; a legitimate absence); core-pass fields (doc comments, "
                "route redirects, \u2026) count as D for every language that produces the model.</div>")
if old_sub_tail in h:
    h = h.replace(old_sub_tail, new_sub_tail)
assert new_sub_tail in h

# legend: four swatches (replace whatever legend div is there)
old_legend = re.search(r'<div class="legend">.*?</div>', h).group(0)
new_legend = ('<div class="legend">'
    '<span><span class="sw" style="background:#1a7f37"></span>written</span>'
    '<span><span class="sw" style="background:#aceebb;border:1px solid #d0d5da"></span>deliverable (real gap)</span>'
    '<span><span class="sw" style="background:#e6edf3;border:1px solid #d0d5da"></span>not deliverable (no such concept)</span>'
    '<span><span class="sw" style="background:#cf222e"></span>required field missing (real gap)</span></div>')
if old_legend != new_legend:
    h = h.replace(old_legend, new_legend)

# per-model sections: table rows + gap div, re-derived from the matrices
h2s = [m_ for m_ in re.finditer(r'<h2>(\w+)</h2>', h)]
heads = [(m_.group(1), m_.start()) for m_ in h2s]
# process in REVERSE document order: gap-div lengths change, so offsets of
# earlier sections must not be invalidated
for idx in range(len(heads) - 1, -1, -1):
    name, pos = heads[idx]
    if name == "Summary":
        continue
    assert name in MODELS, name
    end = heads[idx + 1][1] if idx + 1 < len(heads) else len(h)
    sec = h[pos:end]
    # table
    ts, te = sec.index("<table>"), sec.index("</table>") + len("</table>")
    table = sec[ts:te]
    rows = re.findall(r'<tr><td class="lang">.*?</tr>', table)
    d = data[name]
    assert len(rows) == 80, (name, len(rows))
    newrows = []
    for oldrow, row in zip(rows, d["rows"]):
        lc, cells, cov = row[0], row[1:-1], row[-1]
        lang_in_row = re.search(r'<td class="lang">([^<]*)', oldrow).group(1)
        assert lang_in_row == lc.split("`")[0].strip(), (name, lang_in_row, lc)
        assert oldrow.rsplit('<td class="', 1)[1].startswith('cov">'), (name, lc)
        newrows.append(md_to_html_row(lc, cells, cov))
    newtable = "<table>" + md_to_html_thead(d["hdr"]) + "<tbody>" + "".join(newrows) + "</tbody></table>"
    sec = sec[:ts] + newtable + sec[te:]
    # gap div
    gs = sec.index('<div class="gap">')
    ge = sec.index("</div>", gs)
    old_gap = sec[gs:ge + len("</div>")]
    producers = {r[0].split("`")[0].strip() for r in d["rows"] if "\u2713" in r[1:-1]}
    never = [r[0].split("`")[0].strip() for r in d["rows"] if "\u2713" not in r[1:-1]]
    parts = ['<div class="gap"><b>%s \u2014 fields not written by every producing language:</b><br><br>' % name]
    for i, f in enumerate(d["fields"]):
        if f.endswith("*"):
            continue
        miss = [(r[0].split("`")[0].strip(), r[i + 1]) for r in d["rows"]
                if r[0].split("`")[0].strip() in producers and r[i + 1] != "\u2713"]
        if not miss:
            continue
        dd = [l for l, v in miss if v == "D"]
        nn = [l for l, v in miss if v == "N"]
        parts.append(gap_bullet_html(f, len(miss), dd, nn) + "<br>")
    if never:
        parts.append("<br><i>Never produces %s at all:</i> %s" % (name, ", ".join(never)))
    parts.append("</div>")
    new_gap = "".join(parts)
    sec = sec[:gs] + new_gap + sec[ge + len("</div>"):]
    h = h[:pos] + sec + h[end:]
    print("html %s: d=%d n=%d \u2713=%d" % (
        name,
        sum(1 for r in d["rows"] for c in r[1:-1] if c == "D"),
        sum(1 for r in d["rows"] for c in r[1:-1] if c == "N"),
        sum(1 for r in d["rows"] for c in r[1:-1] if c == "\u2713")))

open(HTML, "w", encoding="utf-8").write(h)
print("html synced: %d bytes" % len(h))
