import re
from datetime import datetime

LOG = "/private/tmp/generative-radio-acestep.log"
ts_re = re.compile(r"^(2026-06-12 \d\d:\d\d:\d\d\.\d+)")
def ts(line):
    m = ts_re.match(line)
    return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S.%f") if m else None

tracks = []
cur = None
for line in open(LOG, errors="replace"):
    t = ts(line)
    if t is None: continue
    if "LLM usage decision" in line and "use_cot_caption=True" in line:
        cur = {"start": t}   # full pipeline runs only (skip metas-only retries)
    if cur is None: continue
    if "Phase 1 completed in" in line:
        cur["p1"] = float(re.search(r"in ([\d.]+)s", line).group(1))
    elif "Phase 2 completed in" in line:
        m = re.search(r"in ([\d.]+)s\. Generated (\d+) audio codes", line)
        cur["p2"], cur["codes"] = float(m.group(1)), int(m.group(2))
    elif "diffusion_time_cost" in line:
        cur["dit"] = float(re.search(r"'diffusion_time_cost': ([\d.]+)", line).group(1))
        cur["offload"] = float(re.search(r"'offload_time_cost': ([\d.]+)", line).group(1))
    elif "Decoding latents with VAE" in line:
        cur["vae_start"] = t
    elif "VAE decode completed" in line and "vae_start" in cur:
        cur["vae"] = (t - cur["vae_start"]).total_seconds()
    elif "Done! Generated" in line:
        cur["total"] = (t - cur["start"]).total_seconds()
        if "p2" in cur:
            tracks.append(cur)
        cur = None

print(f"{'time':>8} {'P1 s':>6} {'P2 s':>6} {'codes':>5} {'P2 tok/s':>8} {'DiT s':>6} {'VAE s':>6} {'total s':>7} {'offl':>5}")
for tr in tracks:
    print(f"{tr['start'].strftime('%H:%M:%S'):>8} {tr.get('p1',0):>6.1f} {tr['p2']:>6.1f} {tr['codes']:>5} "
          f"{tr['codes']/tr['p2']:>8.1f} {tr.get('dit',0):>6.1f} {tr.get('vae',0):>6.1f} {tr.get('total',0):>7.1f} {tr.get('offload',0):>5.1f}")

import statistics as st
if len(tracks) > 1:
    sub = tracks[1:]  # discard T1 per methodology
    for k, fn in [("P1", lambda t: t.get("p1",0)), ("P2", lambda t: t["p2"]),
                  ("P2 tok/s", lambda t: t["codes"]/t["p2"]), ("DiT", lambda t: t.get("dit",0)),
                  ("VAE", lambda t: t.get("vae",0)), ("total", lambda t: t.get("total",0))]:
        vals = [fn(t) for t in sub]
        print(f"median {k}: {st.median(vals):.1f}  (mean {st.mean(vals):.1f}, n={len(vals)})")

print("\n=== Full-length cohort (codes >= 900), T1 discarded ===")
full = [t for t in tracks[1:] if t["codes"] >= 900]
for k, fn in [("P1 s", lambda t: t.get("p1",0)), ("P2 s", lambda t: t["p2"]),
              ("P2 tok/s", lambda t: t["codes"]/t["p2"]), ("DiT s", lambda t: t.get("dit",0)),
              ("DiT s/100codes", lambda t: t.get("dit",0)/t["codes"]*100),
              ("VAE s", lambda t: t.get("vae",0)),
              ("VAE s/100codes", lambda t: t.get("vae",0)/t["codes"]*100),
              ("total s", lambda t: t.get("total",0))]:
    vals = sorted(fn(t) for t in full)
    print(f"{k:>15}: median {st.median(vals):6.1f}   p25 {vals[len(vals)//4]:6.1f}   p75 {vals[3*len(vals)//4]:6.1f}   n={len(vals)}")
