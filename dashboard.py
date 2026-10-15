#!/usr/bin/env python
"""
dashboard.py — Live dashboard for QA Brain ticket processing.

Serves a self-refreshing web dashboard that reads
artifacts/run-state.json (written by scripts/ticket-flow.ts).

Usage:
    python dashboard.py              # http://127.0.0.1:7879
    python dashboard.py --port 8080
"""
from __future__ import annotations
import argparse, json, os, re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT         = Path(__file__).resolve().parent
ARTIFACTS    = ROOT / "artifacts"
STATE_FILE   = ARTIFACTS / "run-state.json"
BROWSER_FILE = ARTIFACTS / "_browser-health.json"
ENV_FILE     = ROOT / ".env"


def _jira_base() -> str:
    """Read JIRA_BASE_URL from .env, fallback to a placeholder URL."""
    try:
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*JIRA_BASE_URL\s*=\s*(.+)$", line)
            if m:
                return m.group(1).strip().rstrip("/")
    except Exception:
        pass
    return "https://jira.example.com"


JIRA_BASE = _jira_base()


def read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def read_state() -> dict:
    s = read_json(STATE_FILE)
    if not isinstance(s, dict):
        return {"state": "IDLE", "mode": "single", "queue": [], "processed": [],
                "counts": {}, "total": 0, "done": 0, "current": None,
                "started_at": None, "updated_at": None, "finished_at": None}
    s.setdefault("state", "IDLE")
    s.setdefault("queue", [])
    s.setdefault("processed", [])
    s.setdefault("counts", {})
    return s


def read_browser() -> dict:
    b = read_json(BROWSER_FILE)
    if not isinstance(b, dict):
        return {"state": "UNKNOWN"}
    b.setdefault("state", "UNKNOWN")
    return b


def build_status() -> dict:
    s = read_state()
    br = read_browser()
    counts = s.get("counts") or {}
    done = s.get("done", 0) or 0
    total = s.get("total", 0) or 0
    passed = counts.get("pass", 0) or 0
    failed = counts.get("fail", 0) or 0
    errors = counts.get("error", 0) or 0
    skipped = counts.get("skipped", 0) or 0
    blocked = counts.get("blocked", 0) or 0
    decided = passed + failed + errors
    pass_rate = round(passed / decided * 100, 1) if decided else 0.0

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "state":      s["state"],
        "mode":       s.get("mode", "single"),
        "started_at": s.get("started_at"),
        "updated_at": s.get("updated_at"),
        "finished_at":s.get("finished_at"),
        "current":    s.get("current"),
        "queue":      s.get("queue", []),
        "processed":  (s.get("processed") or [])[:50],
        "counts":     {"pass": passed, "fail": failed, "error": errors, "skipped": skipped, "blocked": blocked},
        "total":      total,
        "done":       done,
        "remaining":  max(total - done, 0),
        "pass_rate":  pass_rate,
        "browser":    br,
        "jira_base":  JIRA_BASE,
    }


# ── HTML ──────────────────────────────────────────────────────────────────────

HTML = r"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Brain · Live</title>
<style>
:root{
  --bg:#0b0f17;--panel:#131a26;--panel2:#0f1622;--line:#23304a;--txt:#e6edf6;--muted:#8aa0bd;
  --pass:#2ecc71;--fail:#ff5d5d;--error:#c084fc;--skip:#7d8aa3;--accent:#3aa0ff;--warn:#f5a623;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,#16243b 0,var(--bg) 55%);
  color:var(--txt);font:14px/1.45 'Segoe UI',system-ui,Arial}
a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
.wrap{max-width:1200px;margin:0 auto;padding:22px}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
h1{font-size:22px;margin:0;letter-spacing:.3px}
.sub{color:var(--muted);font-size:13px}
.badge{padding:6px 14px;border-radius:999px;font-weight:700;font-size:12px;letter-spacing:.6px;border:1px solid var(--line)}
.b-RUNNING{background:rgba(46,204,113,.14);color:var(--pass);border-color:rgba(46,204,113,.5);animation:pulse 1.6s infinite}
.b-FINISHED{background:rgba(58,160,255,.14);color:var(--accent);border-color:rgba(58,160,255,.5)}
.b-ERROR{background:rgba(255,93,93,.14);color:var(--fail);border-color:rgba(255,93,93,.5)}
.b-IDLE{background:rgba(125,138,163,.14);color:var(--skip);border-color:var(--line)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
/* stat cards */
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:16px}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.card .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.7px}
.card .v{font-size:28px;font-weight:800;margin-top:6px}
.span2{grid-column:span 2}
.c-pass{color:var(--pass)} .c-fail{color:var(--fail)} .c-error{color:var(--error)} .c-skip{color:var(--skip)} .c-warn{color:var(--warn)}
.bar{height:16px;border-radius:8px;background:#0d1422;border:1px solid var(--line);overflow:hidden;display:flex}
.bar>span{display:block;height:100%}
.s-pass{background:var(--pass)} .s-fail{background:var(--fail)} .s-error{background:var(--error)} .s-skip{background:var(--skip)}
/* panels */
.panel{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:16px}
.panel h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin:0 0 12px}
/* current ticket */
.current-box{background:rgba(46,204,113,.07);border:1px solid rgba(46,204,113,.35);border-radius:12px;padding:14px 16px;margin-bottom:16px}
.current-box .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px}
.current-box .key{font-size:22px;font-weight:800;color:var(--pass)}
.current-box .summary{color:var(--txt);margin-top:4px}
.current-box .timer{color:var(--muted);font-size:13px;margin-top:6px}
/* queue */
.queue-list{display:flex;flex-wrap:wrap;gap:8px}
.q-chip{background:#0d1422;border:1px solid var(--line);border-radius:8px;padding:5px 12px;font-size:13px;font-weight:700;color:var(--accent)}
.q-chip:hover{border-color:var(--accent)}
/* table */
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #1b2740}
th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
tr:hover td{background:#0e1626}
.pill{padding:3px 10px;border-radius:999px;font-weight:700;font-size:11px;letter-spacing:.4px}
.p-pass{background:rgba(46,204,113,.16);color:var(--pass)}
.p-fail{background:rgba(255,93,93,.16);color:var(--fail)}
.p-error{background:rgba(192,132,252,.16);color:var(--error)}
.p-skipped{background:rgba(125,138,163,.16);color:var(--skip)}
.reason{color:var(--muted);max-width:440px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* browser */
.browser-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.bf{background:#0d1422;border:1px solid var(--line);border-radius:10px;padding:10px}
.bf .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.bf .v{margin-top:5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-OK{background:rgba(46,204,113,.16);color:var(--pass);border:1px solid rgba(46,204,113,.5)}
.bp-DEGRADED,.bp-NEEDS_SIGNIN{background:rgba(245,166,35,.16);color:var(--warn);border:1px solid rgba(245,166,35,.5)}
.bp-DOWN,.bp-UNKNOWN{background:rgba(125,138,163,.16);color:var(--skip);border:1px solid var(--line)}
/* misc */
.banner{border-radius:12px;padding:12px 16px;margin-bottom:16px;font-weight:600}
.banner.done{background:rgba(58,160,255,.12);border:1px solid rgba(58,160,255,.5);color:#bfe0ff}
.banner.error{background:rgba(255,93,93,.12);border:1px solid rgba(255,93,93,.5);color:#ffd1d1}
.muted{color:var(--muted)} code{background:#0d1422;padding:2px 7px;border-radius:6px;border:1px solid var(--line)}
.foot{color:var(--muted);font-size:12px;text-align:center;margin-top:8px}
</style></head>
<body><div class="wrap">
<header>
  <h1>🧠 QA Brain · Live</h1>
  <span id="badge" class="badge b-IDLE">IDLE</span>
  <span id="mode" class="sub"></span>
  <span class="sub" style="margin-left:auto" id="clock"></span>
</header>

<div id="banner"></div>
<div id="current-box"></div>

<!-- Stats -->
<div class="grid">
  <div class="card span2">
    <div class="k">Progress</div>
    <div class="v"><span id="done">0</span><span class="muted" style="font-size:18px">/<span id="total">0</span></span></div>
    <div class="bar" id="pbar" style="margin-top:10px"></div>
    <div class="sub" style="margin-top:6px"><span id="pct">0</span>% · <span id="remaining">0</span> remaining</div>
  </div>
  <div class="card"><div class="k">Passed</div><div class="v c-pass" id="passed">0</div><div class="sub" id="passrate">—</div></div>
  <div class="card"><div class="k">Failed</div><div class="v c-fail" id="failed">0</div></div>
  <div class="card"><div class="k">Error</div><div class="v c-error" id="errors">0</div></div>
  <div class="card"><div class="k">Skipped</div><div class="v c-skip" id="skipped">0</div></div>
</div>

<!-- Queue -->
<div class="panel" id="queue-panel">
  <h2>Queue (<span id="queue-count">0</span>)</h2>
  <div class="queue-list" id="queue-list"><span class="muted">empty</span></div>
</div>

<!-- Processed tickets -->
<div class="panel">
  <h2>Processed Tickets</h2>
  <table>
    <thead><tr><th>Ticket</th><th>Summary</th><th>Verdict</th><th>Transition</th><th>Duration</th><th>Time</th></tr></thead>
    <tbody id="rows"><tr><td colspan="6" class="muted">no results yet</td></tr></tbody>
  </table>
</div>

<!-- Browser health -->
<div class="panel">
  <h2>Browser Session (CDP)</h2>
  <div class="browser-grid">
    <div class="bf"><div class="k">Status</div><div class="v" id="br-state"><span class="pill bp-UNKNOWN">UNKNOWN</span></div></div>
    <div class="bf"><div class="k">Port up</div><div class="v" id="br-port">—</div></div>
    <div class="bf"><div class="k">Authed</div><div class="v" id="br-auth">—</div></div>
    <div class="bf"><div class="k">Last check</div><div class="v" id="br-ts">—</div></div>
  </div>
</div>

<div class="foot">auto-refresh every 3 s · <a id="jira-link" href="" target="_blank">Open Jira Board ↗</a> · <span id="updated"></span></div>
</div>

<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=t=>t?new Date(t).toLocaleTimeString():'—';
const yn=v=>v===true?'yes':v===false?'no':'—';
const fmtMs=ms=>{ms=Number(ms);if(!ms||ms<0)return'—';const s=Math.round(ms/1000);return s<90?s+'s':Math.floor(s/60)+'m'+(s%60)+'s'};

let jiraBase='https://jira.example.com';
let currentStarted=null;
let timerInterval=null;

function tickTimer(){
  if(!currentStarted)return;
  const sec=Math.round((Date.now()-new Date(currentStarted).getTime())/1000);
  const el=$('current-timer');
  if(el) el.textContent='Running for '+fmtMs(sec*1000);
}

async function tick(){
  let d;
  try{ d=await (await fetch('/api/status',{cache:'no-store'})).json(); }catch(e){ return; }

  jiraBase=d.jira_base||jiraBase;

  // Badge
  const badge=$('badge');
  badge.className='badge b-'+d.state;
  badge.textContent={RUNNING:'● RUNNING',FINISHED:'✓ FINISHED',ERROR:'✗ ERROR',IDLE:'IDLE'}[d.state]||d.state;

  $('mode').textContent=d.mode==='batch'?'batch mode':'single mode';
  $('clock').textContent='updated '+time(d.generated_at);
  $('updated').textContent='last update '+time(d.updated_at);

  // Jira board link
  $('jira-link').href=jiraBase+'/jira/secure/RapidBoard.jspa?rapidView=20001';

  // Progress
  const done=d.done||0, total=d.total||0;
  $('done').textContent=done; $('total').textContent=total;
  const pct=total?Math.round(done/total*100):0; $('pct').textContent=pct;
  $('remaining').textContent=d.remaining||0;
  const c=d.counts||{};
  $('passed').textContent=c.pass||0; $('failed').textContent=c.fail||0;
  $('errors').textContent=c.error||0; $('skipped').textContent=c.skipped||0;
  $('passrate').textContent=(d.pass_rate??0)+'% of decided';

  // Progress bar
  const seg=(k,cl)=>{const n=c[k]||0;return n&&total?`<span class="${cl}" style="width:${n/total*100}%"></span>`:''};
  $('pbar').innerHTML=total?(seg('pass','s-pass')+seg('fail','s-fail')+seg('error','s-error')+seg('skipped','s-skip')):'';

  // Banner
  let bn='';
  if(d.state==='FINISHED') bn=`<div class="banner done">✓ <b>Run finished.</b> ${done}/${total} processed — ${c.pass||0} passed · ${c.fail||0} failed · ${c.error||0} errors.</div>`;
  else if(d.state==='ERROR') bn=`<div class="banner error">✗ <b>Run aborted with error.</b> Check the terminal for details.</div>`;
  $('banner').innerHTML=bn;

  // Current ticket
  if(d.current){
    const cur=d.current;
    if(currentStarted!==cur.started_at){
      currentStarted=cur.started_at;
      if(timerInterval) clearInterval(timerInterval);
      timerInterval=setInterval(tickTimer,1000);
    }
    const jiraUrl=jiraBase+'/jira/browse/'+esc(cur.key);
    $('current-box').innerHTML=`<div class="current-box">
      <div class="label">▶ Currently testing</div>
      <div class="key"><a href="${esc(jiraUrl)}" target="_blank">${esc(cur.key)}</a></div>
      <div class="summary">${esc(cur.summary)}</div>
      <div class="timer" id="current-timer">Started ${time(cur.started_at)}</div>
    </div>`;
    tickTimer();
  } else {
    currentStarted=null;
    if(timerInterval){ clearInterval(timerInterval); timerInterval=null; }
    $('current-box').innerHTML='';
  }

  // Queue
  const queue=d.queue||[];
  $('queue-count').textContent=queue.length;
  if(queue.length){
    $('queue-list').innerHTML=queue.map(k=>{
      const url=jiraBase+'/jira/browse/'+esc(k);
      return `<a class="q-chip" href="${esc(url)}" target="_blank">${esc(k)}</a>`;
    }).join('');
  } else {
    $('queue-list').innerHTML='<span class="muted">'+(d.state==='IDLE'?'idle — run a ticket to start':'empty')+'</span>';
  }

  // Processed table
  const rows=d.processed||[];
  $('rows').innerHTML=rows.length?rows.map(r=>{
    const v=r.verdict||'';
    const jiraUrl=jiraBase+'/jira/browse/'+esc(r.key);
    const err=r.error?`<span title="${esc(r.error.slice(0,200))}" style="cursor:help">ⓘ</span>`:'';
    return `<tr>
      <td><b><a href="${esc(jiraUrl)}" target="_blank">${esc(r.key)}</a></b></td>
      <td class="reason" title="${esc(r.summary)}">${esc(r.summary)}</td>
      <td><span class="pill p-${esc(v)}">${v.toUpperCase()}</span> ${err}</td>
      <td class="muted">${esc(r.transition||'—')}</td>
      <td>${fmtMs(r.duration_ms)}</td>
      <td class="muted">${time(r.timestamp)}</td>
    </tr>`;
  }).join(''):'<tr><td colspan="6" class="muted">no results yet</td></tr>';

  // Browser health
  const br=d.browser||{};
  const bs=br.state||'UNKNOWN';
  $('br-state').innerHTML=`<span class="pill bp-${esc(bs)}">${esc(bs)}</span>`;
  $('br-port').textContent=yn(br.port_up);
  $('br-auth').textContent=yn(br.authed);
  $('br-ts').textContent=time(br.ts);
}

tick();
setInterval(tick,3000);
</script>
</body></html>"""


# ── HTTP handler ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # suppress per-request noise

    def _send(self, code: int, body, ctype: str):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/status"):
            self._send(200, json.dumps(build_status()), "application/json")
        elif self.path in ("/", "/index.html"):
            self._send(200, HTML, "text/html; charset=utf-8")
        else:
            self._send(404, "not found", "text/plain")


def main():
    ap = argparse.ArgumentParser(description="QA Brain live dashboard")
    ap.add_argument("--port", type=int, default=7879)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    print(f"QA Brain Dashboard: {url}  (Ctrl+C to stop)")
    print(f"Reading state from:  {STATE_FILE}")
    if not STATE_FILE.exists():
        print("  [!] run-state.json not found yet -- start a ticket run to populate it.")

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
