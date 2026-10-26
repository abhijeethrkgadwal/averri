"""Render Averri's raster brand and site assets from the SVG sources with headless Chrome.

Usage: python scripts/brand/render_assets.py [path-to-chrome]
Writes PNG icons, favicon.ico, the Open Graph image and brand PNGs into site/.
"""
import os, subprocess, sys, tempfile, pathlib
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
SITE = ROOT / "site"
CHROME = sys.argv[1] if len(sys.argv) > 1 else r"C:\Program Files\Google\Chrome\Application\chrome.exe"
TMP = pathlib.Path(tempfile.mkdtemp(prefix="averri-render-"))
PROFILE = TMP / "profile"
FONT = (SITE / "assets/fonts/SpaceGrotesk.woff2").as_uri()
INTER = (SITE / "assets/fonts/Inter.woff2").as_uri()

def svg(name):
    return (SITE / "brand" / name).read_text(encoding="utf-8")

def shot(html, w, h, out, transparent=False):
    page = TMP / (pathlib.Path(out).stem + ".html")
    page.write_text(f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:SG;src:url({FONT}) format("woff2");font-weight:300 700}}
@font-face{{font-family:IN;src:url({INTER}) format("woff2");font-weight:100 900}}
html,body{{margin:0;width:{w}px;height:{h}px;overflow:hidden;background:{'transparent' if transparent else '#0b0f17'}}}
svg{{display:block}}</style></head><body>{html}</body></html>""", encoding="utf-8")
    args = [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
            "--force-device-scale-factor=1", f"--window-size={w},{h}", f"--user-data-dir={PROFILE}",
            f"--screenshot={out}", page.as_uri()]
    if transparent:
        args.insert(1, "--default-background-color=00000000")
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    out = pathlib.Path(out)
    print("wrote", out.relative_to(ROOT) if ROOT in out.parents else out.name)

def tile(size, mark_scale=0.72, radius=0.215, bleed=False):
    r = 0 if bleed else round(size * radius)
    m = round(size * mark_scale)
    return f"""<div style="width:{size}px;height:{size}px;border-radius:{r}px;display:grid;place-items:center;
      background:linear-gradient(135deg,#12324a,#0b0f17)"><div style="width:{m}px;height:{m}px">{svg('averri-mark.svg').replace('<svg ', f'<svg width="{m}" height="{m}" ')}</div></div>"""

# brand PNGs
shot(tile(1024, bleed=True), 1024, 1024, SITE / "brand/averri-avatar.png")            # profile pictures (platforms crop to a circle)
shot(svg("averri-mark.svg").replace("<svg ", '<svg width="1024" height="1024" '), 1024, 1024, SITE / "brand/averri-mark.png", transparent=True)
shot(svg("averri-logo-dark.svg").replace("<svg ", '<svg width="2000" height="602" '), 2000, 602, SITE / "brand/averri-logo-dark.png", transparent=True)
shot(svg("averri-logo-light.svg").replace("<svg ", '<svg width="2000" height="602" '), 2000, 602, SITE / "brand/averri-logo-light.png", transparent=True)

# site icons
shot(tile(180, mark_scale=0.74, bleed=True), 180, 180, SITE / "apple-touch-icon.png")
shot(tile(192, mark_scale=0.74), 192, 192, SITE / "icon-192.png", transparent=True)
shot(tile(512, mark_scale=0.74), 512, 512, SITE / "icon-512.png", transparent=True)
shot(tile(512, mark_scale=0.56, bleed=True), 512, 512, SITE / "icon-512-maskable.png")
fav = TMP / "fav-256.png"
shot((SITE / "favicon.svg").read_text(encoding="utf-8").replace("<svg ", '<svg width="256" height="256" '), 256, 256, fav, transparent=True)
Image.open(fav).save(SITE / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
print("wrote site/favicon.ico")

# Open Graph / social share card
og = f"""<div style="position:relative;width:1200px;height:630px;font-family:SG,sans-serif;color:#e9eef5;overflow:hidden;
  background:radial-gradient(700px 500px at 88% -10%,#12324a,transparent 60%),radial-gradient(600px 500px at -10% 120%,#1d1440,transparent 60%),#0b0f17">
  <svg width="1200" height="630" style="position:absolute;inset:0;opacity:.35">
    <g stroke="#5eead4" stroke-opacity=".35" stroke-width="1.2">
      <line x1="760" y1="90" x2="980" y2="210"/><line x1="980" y1="210" x2="1110" y2="120"/><line x1="980" y1="210" x2="1060" y2="420"/>
      <line x1="1060" y1="420" x2="880" y2="520"/><line x1="880" y1="520" x2="760" y2="380"/><line x1="760" y1="380" x2="980" y2="210"/>
    </g>
    <g fill="#5eead4"><circle cx="760" cy="90" r="5"/><circle cx="980" cy="210" r="7"/><circle cx="1110" cy="120" r="4"/>
      <circle cx="1060" cy="420" r="5"/><circle cx="880" cy="520" r="4"/><circle cx="760" cy="380" r="5"/></g>
  </svg>
  <div style="position:absolute;left:80px;top:76px">{svg('averri-logo-dark.svg').replace('<svg ', '<svg width="300" height="90" ')}</div>
  <div style="position:absolute;left:80px;top:220px;font-size:76px;font-weight:700;line-height:1.02;letter-spacing:-2.5px">
    AI writes the code.<br><span style="color:#5eead4">Averri knows the rules.</span></div>
  <div style="position:absolute;left:80px;bottom:70px;font-family:IN,sans-serif;font-size:26px;color:#b9c4d3">
    Free &amp; open source · Claude Code · Cursor · MCP · <span style="color:#e9eef5;font-weight:600">averri.org</span></div>
</div>"""
shot(og, 1200, 630, SITE / "og-image.png")
