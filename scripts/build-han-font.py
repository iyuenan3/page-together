"""Regenerate the bundled supplement with fonttools[woff]==4.60.1.

Input: the unmodified official BabelStone Han 16.0.3 WOFF2.
Only supplementary CJK mappings are retained; original font names are changed.
"""
import argparse
import hashlib
import json
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont

SOURCE_HASH = "4cedbfe15ece57ea2f85cfec331cf1a37ad9005cb44b1eb13e962030a27a7fa1"
parser = argparse.ArgumentParser()
parser.add_argument("input", type=Path)
args = parser.parse_args()
assert hashlib.sha256(args.input.read_bytes()).hexdigest() == SOURCE_HASH, "Review changed upstream font"
font = TTFont(args.input)
assert font["name"].getDebugName(5) == "Version 16.0.3"
points = sorted(cp for cp in font.getBestCmap() if 0x20000 <= cp <= 0x323AF)
assert 0x20000 in points
options = subset.Options()
options.name_IDs = ["*"]
options.name_legacy = True
options.name_languages = ["*"]
engine = subset.Subsetter(options=options)
engine.populate(unicodes=points)
engine.subset(font)
for record in font["name"].names:
    if record.nameID in (1, 3, 4, 6, 16, 18, 21):
        name = "PageTogetherHanSupplement" if record.nameID == 6 else "pageTogether Han Supplement"
        record.string = name.encode(record.getEncoding())
font.flavor = "woff2"
output = Path(__file__).resolve().parent.parent / "public" / "assets"
output.mkdir(parents=True, exist_ok=True)
path = output / "page-together-han-supplement.woff2"
font.save(path)
restored = TTFont(path)
assert sorted(restored.getBestCmap()) == points
assert restored["glyf"][restored.getBestCmap()[0x20000]].numberOfContours != 0
ranges = []
for point in points:
    if ranges and point == ranges[-1][1] + 1:
        ranges[-1][1] = point
    else:
        ranges.append([point, point])
manifest = {
    "source": "https://babelstone.co.uk/Fonts/WOFF/BabelStoneHan.woff2",
    "sourceVersion": "16.0.3", "sourceSha256": SOURCE_HASH,
    "family": "pageTogether Han Supplement", "license": "Arphic Public License (1999)",
    "characters": len(points), "ranges": ranges,
    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
}
(output / "han-coverage.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
print(json.dumps({"characters": len(points), "bytes": path.stat().st_size, "sha256": manifest["sha256"]}))
