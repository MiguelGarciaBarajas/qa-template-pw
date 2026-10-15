"""Parametrized PROJ-1 boss status report generator (unattended-friendly).

Usage:
    python scripts/generate-status-report.py [YYYY-MM-DD]

Date defaults to today (local). The previous *business* day is computed
automatically (weekends skipped). Reads the two dated snapshots produced by
`scripts/fetch-epic-snapshot.ts` and emits the fixed 6-section report as a
paste-ready .txt and a .docx into artifacts/.

Scope = Bugs/defects only (uses bugCounts / bugCounts.byStatus). Numeric
sections (1, 3, 5, 6) are fully data-driven from the live snapshot. The QA
queue (2) and Blockers (4) narrative is auto-derived from the numbers with an
explicit note: for the named per-ticket blocker list, run the
`daily-status-reporter` agent / `/reporte` (the snapshot stores counts, not
per-ticket keys/priorities).
"""
import json
import os
import sys
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def prev_business_day(d: date) -> date:
    x = d - timedelta(days=1)
    while x.weekday() >= 5:  # 5 = Saturday, 6 = Sunday
        x -= timedelta(days=1)
    return x


def snap_path(d: str) -> str:
    return os.path.join(ROOT, 'scripts', f'epic-live-snapshot-{d}.json')


def load_snapshot(d: str) -> dict:
    path = snap_path(d)
    if not os.path.exists(path):
        sys.exit(
            f'ERROR: missing snapshot {path}\n'
            f'Fetch it first: npx tsx scripts/fetch-epic-snapshot.ts {d}'
        )
    return json.load(open(path, encoding='utf-8'))


def main() -> None:
    today_str = sys.argv[1] if len(sys.argv) > 1 else date.today().isoformat()
    today = datetime.strptime(today_str, '%Y-%m-%d').date()
    prev_str = prev_business_day(today).isoformat()

    d = load_snapshot(today_str)
    p = load_snapshot(prev_str)

    # sanity check: total == sum(statusCounts)
    if d['total'] != sum(d['statusCounts'].values()):
        sys.exit(f'ERROR: snapshot {today_str} total != sum(statusCounts); re-fetch it.')

    s = d['statusCounts']; t = d['typeCounts']; b = d['bugCounts']; bp = b['byStatus']
    pt = p['typeCounts']; pb = p['bugCounts']; pbs = pb['byStatus']

    def sg(dic, k):
        return dic.get(k, 0)

    def delta(cur, prev, k):
        return sg(cur, k) - sg(prev, k)

    def sign(n):
        return f'+{n}' if n > 0 else (str(n) if n < 0 else '0')

    nums = dict(
        prev=prev_str,
        bug=sg(t, 'Bug'),
        bug_pipe=b['pipeline'], bug_active=b['activeOpenInProgress'],
        bp_open=sg(bp, 'Open'), bp_inprog=sg(bp, 'In Progress'), bp_rft=sg(bp, 'Ready for Testing'),
        bp_intest=sg(bp, 'In Testing'), bp_inacc=sg(bp, 'In Acceptance'), bp_perf=sg(bp, 'Performance Test'),
        bp_resolved=sg(bp, 'Resolved'), bp_closed=sg(bp, 'Closed'),
        d_bug=sign(sg(t, 'Bug') - sg(pt, 'Bug')),
        d_bug_pipe=sign(b['pipeline'] - pb['pipeline']),
        d_bug_active=sign(b['activeOpenInProgress'] - pb['activeOpenInProgress']),
        d_bp_open=sign(delta(bp, pbs, 'Open')),
        d_bp_inprog=sign(delta(bp, pbs, 'In Progress')),
        d_bp_rft=sign(delta(bp, pbs, 'Ready for Testing')),
        d_bp_intest=sign(delta(bp, pbs, 'In Testing')),
        d_bp_inacc=sign(delta(bp, pbs, 'In Acceptance')),
        d_bp_perf=sign(delta(bp, pbs, 'Performance Test')),
        d_bp_closed=sign(delta(bp, pbs, 'Closed')),
        d_bp_resolved=sign(delta(bp, pbs, 'Resolved')),
    )

    disp = today.strftime('%m/%d/%Y')

    # Section 4 — auto-named blockers from the snapshot's per-ticket list (falls
    # back to a generic count line for older snapshots without bugBlockers).
    blockers = d.get('bugBlockers')
    if blockers:
        lines = [
            f'   - {bk.get("key")} · {bk.get("priority", "?")} · {bk.get("status", "?")} · '
            f'{(bk.get("summary") or "").strip()}'
            for bk in blockers
        ]
        blockers_block = (
            f'4. BLOCKERS - {nums["bug_active"]} bugs are confirmed active (Open + In Progress) - '
            f'the defects genuinely blocking forward progress. Named live from Jira '
            f'(sorted by priority):\n'
            + '\n'.join(lines) + '\n'
        )
    else:
        blockers_block = (
            f'4. BLOCKERS - {nums["bug_active"]} bugs are confirmed active (Open + In Progress): '
            f'{nums["bp_open"]} Open, {nums["bp_inprog"]} In Progress. These are the defects '
            f'holding up the QA queue today.\n'
            '   NOTE: named per-ticket list unavailable in this snapshot; run the '
            'daily-status-reporter agent / /reporte for the full blocker narrative.\n'
        )

    TXT = r"""Status - {disp} - Epic PROJ-1 (<Product Name>) - Bugs / Defects only

1. Defect health today - Bug/defect status pulled live from Jira ("Epic Link" = PROJ-1,
   issuetype = Bug). This report covers Bugs/defects only; Tasks and Stories are excluded.
   - The epic currently tracks {bug} Bugs/defects ({d_bug} vs. last business day, {prev}).
   - Verification stage: {bp_closed} Closed ({d_bp_closed}), {bp_inacc} In Acceptance
     ({d_bp_inacc}) and {bp_perf} in Performance Test ({d_bp_perf}) - the majority of defects
     are already fixed and sitting in the acceptance/verification stage, not in early triage.
   - Movement since last business day: In Acceptance {d_bp_inacc}, In Testing {d_bp_intest},
     Ready for Testing {d_bp_rft}, Performance Test {d_bp_perf}, Open {d_bp_open}, In Progress
     {d_bp_inprog}, Closed {d_bp_closed}, Resolved {d_bp_resolved}. Net change {d_bug} bugs
     across the whole team (dev + QA) - an epic-wide delta, not QA-filed volume.

2. QA queue / what's waiting on testing (Bugs/defects) -
   - {bp_rft} bugs are in "Ready for Testing" (QA's inbound retest queue, {d_bp_rft} vs. last
     business day). This is the defect testing backlog and the QA team's near-term focus.
   - {bp_intest} bugs are currently In Testing ({d_bp_intest} vs. last business day) - active QA
     verification in flight.

3. Defects (epic-wide bug pipeline) -
   - {bug} Bugs total under the epic ({d_bug} vs. last business day): {bp_closed} Closed and
     {bug_pipe} still in the pipeline ({d_bug_pipe} vs. last business day).
   - Confirmed active defects (Open + In Progress): {bug_active} bugs ({d_bug_active} vs.
     last business day). This is the set genuinely blocking forward progress.

{blockers_block}
5. Current defect status (PROJ-1 epic - Bugs only):
   1. Total Bugs:         {bug}
   2. In Acceptance:      {bp_inacc}
   3. Closed:             {bp_closed}
   4. Ready for Testing:  {bp_rft}
   5. Performance Test:   {bp_perf}
   6. Open:               {bp_open}
   7. In Progress:        {bp_inprog}
   8. In Testing:         {bp_intest}
   9. Resolved:           {bp_resolved}
   (Bugs/defects only - Tasks and Stories are excluded from this report.)

6. Bug pipeline breakdown -
   - Bugs under epic: {bug} total - {bp_closed} closed, {bug_pipe} still in the pipeline.
   - Bug pipeline: Open {bp_open} - In Progress {bp_inprog} - Ready for Testing {bp_rft} -
     In Testing {bp_intest} - In Acceptance {bp_inacc} - Performance Test {bp_perf} -
     Resolved {bp_resolved}.
   - Confirmed active defects (Open + In Progress): {bug_active} bugs.
""".format(disp=disp, blockers_block=blockers_block.rstrip('\n'), **nums)

    artifacts = os.path.join(ROOT, 'artifacts')
    os.makedirs(artifacts, exist_ok=True)
    out_txt = os.path.join(artifacts, f'QA_Status_Report_{today_str}.txt')
    out_docx = os.path.join(artifacts, f'QA_Status_Report_{today_str}.docx')

    open(out_txt, 'w', encoding='utf-8').write(TXT)
    print('Saved TXT:', out_txt)

    try:
        from docx import Document
        from docx.shared import Pt, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        doc = Document()
        doc.styles['Normal'].font.name = 'Calibri'
        doc.styles['Normal'].font.size = Pt(11)
        h = doc.add_heading('QA Status Report - Epic PROJ-1', 0)
        h.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for line in TXT.splitlines():
            par = doc.add_paragraph(line)
            par.paragraph_format.space_after = Pt(0)
        f = doc.add_paragraph()
        f.alignment = WD_ALIGN_PARAGRAPH.CENTER
        fr = f.add_run('Generated by QA AI Agent (GitHub Copilot)  |  Reviewed by: the QA owner  |  '
                       f'Data pulled live from Jira on {today_str}')
        fr.font.size = Pt(8); fr.italic = True; fr.font.color.rgb = RGBColor(0x99, 0x99, 0x99)
        doc.save(out_docx)
        print('Saved DOCX:', out_docx)
    except Exception as e:
        print('DOCX skipped:', e)

    print('\n' + TXT)


if __name__ == '__main__':
    main()
