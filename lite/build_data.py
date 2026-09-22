#!/usr/bin/env python3
"""Build js/data.js and commons.json from the Open Sport Commons in the main repo.

Usage (from the repo root):
    python3 lite/build_data.py            # reads config/commons/football next to lite/
    python3 lite/build_data.py <path>     # or any other commons folder
"""
import json
import pathlib
import sys

TRACKS = ["ball-mastery", "dribbling", "passing-first-touch", "weak-foot", "juggling-coordination"]


def main(src: str) -> None:
    src_dir = pathlib.Path(src)
    out_dir = pathlib.Path(__file__).parent

    graph = json.loads((src_dir / "skill-graph.json").read_text())
    tests = json.loads((src_dir / "tests.json").read_text())
    rubrics = json.loads((src_dir / "rubrics.json").read_text())

    nodes = graph["nodes"]
    tracks = []
    for slug in TRACKS:
        root = next(n for n in nodes if n["slug"] == slug)
        children = sorted((n for n in nodes if n["parent"] == slug), key=lambda n: n["order"])
        tracks.append({
            "slug": slug,
            "names": root["names"],
            "levels": root["levels"],
            "outcomes": root.get("outcomes", []),
            "nodes": [{"slug": c["slug"], "names": c["names"], "levels": c["levels"]} for c in children],
        })

    drills = []
    for slug in TRACKS:
        pack = json.loads((src_dir / "drills" / f"{slug}.json").read_text())
        for d in pack["drills"]:
            d = dict(d)
            d["track"] = slug
            d.setdefault("partner", False)
            d.setdefault("progressionSlugs", [])
            d.setdefault("regressionSlugs", [])
            drills.append(d)

    data = {
        "version": graph.get("version", "0.1.0"),
        "sport": "football",
        "tracks": tracks,
        "drills": drills,
        "tests": tests["tests"],
        "rubrics": [
            {"skill": r["skill"], "criteria": r["criteria"], "recordingTips": r.get("recordingTips", [])}
            for r in rubrics["rubrics"]
        ],
    }

    compact = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    (out_dir / "js" / "data.js").write_text(f"window.FC_DATA={compact};\n")
    (out_dir / "commons.json").write_text(json.dumps({
        "name": "Open Sport Commons",
        "license": "CC-BY-SA-4.0",
        "attribution": "FIRST COACH / Open Sport Commons, CC BY-SA 4.0",
        **data,
    }, ensure_ascii=False, indent=1))
    print(f"tracks={len(tracks)} drills={len(drills)} tests={len(data['tests'])} bytes={len(compact)}")


if __name__ == "__main__":
    here = pathlib.Path(__file__).resolve().parent
    main(sys.argv[1] if len(sys.argv) > 1 else str(here.parent / "config" / "commons" / "football"))
