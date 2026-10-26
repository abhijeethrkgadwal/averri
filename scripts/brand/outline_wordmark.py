"""Outline the 'averri' wordmark from Space Grotesk (OFL) at weight 700 into SVG paths.

Usage: python outline_wordmark.py <fonttools-dir> <SpaceGrotesk[wght].ttf> <out.json>
Writes {"aver": d, "ri": d, "width": w, "ascent": a, "descent": d} in font units, so the
logo renders identically without the font installed.
"""
import json, sys
sys.path.insert(0, sys.argv[1])
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

font = instantiateVariableFont(TTFont(sys.argv[2]), {"wght": 700})
gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font["hmtx"]
kern = {}
TRACK = -40  # tighten letter spacing slightly, in font units (upm 1000)

def run(text, x0):
    pen = SVGPathPen(gs)
    x = x0
    for ch in text:
        g = cmap[ord(ch)]
        gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))  # flip y for SVG
        x += hmtx[g][0] + TRACK
    return pen.getCommands(), x

aver, x = run("aver", 0)
ri, x = run("ri", x)
os2 = font["OS/2"]
json.dump({"aver": aver, "ri": ri, "width": x - TRACK, "ascent": os2.sTypoAscender, "descent": os2.sTypoDescender,
           "xHeight": getattr(os2, "sxHeight", 500), "upm": font["head"].unitsPerEm}, open(sys.argv[3], "w"))
print("width", x - TRACK, "upm", font["head"].unitsPerEm, "xHeight", getattr(os2, "sxHeight", None))
