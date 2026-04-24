#!/usr/bin/env python3
"""
NYC Street Names Game - Data Pipeline
Fetches street data from OpenStreetMap via Overpass API,
filters and processes it into per-borough GeoJSON files.

Usage:
    python fetch.py           # fetch + process all boroughs
    python fetch.py --fresh   # ignore cached raw data and re-fetch
"""

import argparse
import json
import time
import requests
from pathlib import Path

# OSM relation IDs for each borough
BOROUGHS = {
    "manhattan":     8398124,
    "brooklyn":      369518,
    "queens":        369519,
    "bronx":         2552450,
    "staten_island": 962876,
}

# OSM highway types to include (named streets only, no highways/footpaths)
INCLUDE_HIGHWAY = "|".join([
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
    "residential",
    "unclassified",
    "living_street",
])

# Minimum number of OSM segments a street name must appear in to be included.
# Filters out single cul-de-sacs and dead-ends that nobody outside the block knows.
MIN_SEGMENTS: dict[str, int] = {
    "manhattan":     2,
    "brooklyn":      2,
    "queens":        2,
    "bronx":         2,
    "staten_island": 4,  # very suburban — needs stricter filter to stay playable
}

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
RAW_DIR = Path("data/raw")
OUT_DIR = Path("../data")   # web-accessible data folder at project root


BORO_NAME_TO_ID = {
    "Manhattan":     "manhattan",
    "Bronx":         "bronx",
    "Brooklyn":      "brooklyn",
    "Queens":        "queens",
    "Staten Island": "staten_island",
}

NYC_BOUNDARIES_URL = (
    "https://raw.githubusercontent.com/codeforgermany/click_that_hood"
    "/main/public/data/new-york-city-boroughs.geojson"
)


def fetch_boundaries() -> None:
    """Download NYC borough boundary polygons from NYC Open Data."""
    out_path = OUT_DIR / "boroughs.geojson"
    if out_path.exists():
        print("  boundaries: using cached boroughs.geojson")
        return

    print("  boundaries: downloading from NYC Open Data...")
    resp = requests.get(NYC_BOUNDARIES_URL, timeout=60)
    resp.raise_for_status()
    raw = resp.json()

    # Normalise: add borough_id property + sequential numeric id for MapLibre feature-state
    features = []
    for i, feature in enumerate(raw["features"]):
        boro_name = feature["properties"].get("name", "")
        boro_id = BORO_NAME_TO_ID.get(boro_name)
        if not boro_id:
            continue
        feature["id"] = i
        feature["properties"]["borough_id"] = boro_id
        features.append(feature)

    out = {"type": "FeatureCollection", "features": features}
    out_path.write_text(json.dumps(out))
    print(f"  boundaries: saved {len(features)} borough polygons")


def build_query(relation_id: int) -> str:
    area_id = 3600000000 + relation_id
    return f"""
[out:json][timeout:180];
area(id:{area_id})->.b;
way["highway"~"^({INCLUDE_HIGHWAY})$"]
   ["name"]
   ["bridge"!~"yes"]
   ["tunnel"!~"yes"]
   (area.b);
out geom;
"""


def fetch_borough(name: str, relation_id: int, fresh: bool = False) -> dict:
    raw_path = RAW_DIR / f"{name}.json"

    if raw_path.exists() and not fresh:
        print(f"  {name}: using cached raw data ({raw_path.stat().st_size // 1024}KB)")
        return json.loads(raw_path.read_text())

    print(f"  {name}: querying Overpass API...")
    resp = requests.post(
        OVERPASS_URL,
        data={"data": build_query(relation_id)},
        headers={"User-Agent": "nyc-street-names-game/1.0"},
        timeout=200,
    )
    resp.raise_for_status()
    data = resp.json()

    raw_path.write_text(json.dumps(data))
    print(f"  {name}: fetched {len(data['elements'])} ways, saved to {raw_path}")
    return data


import re

# Numbered street pattern: "East 42nd Street", "West 110th Street", etc.
_DIRECTIONAL_STREET = re.compile(
    r"^(?:East|West)\s+(\d+\w*\s+(?:Street|Avenue|Drive|Place|Road|Boulevard|Lane|Court|Way|Terrace))$",
    re.IGNORECASE,
)

# Names to exclude: bridges, tunnels, park roads, and non-street infrastructure
# that slipped through OSM tag filters
_EXCLUDE_SUFFIXES = (" Bridge", " Tunnel", " Transverse", " Viaduct", " Mall")
_EXCLUDE_PATTERNS = re.compile(
    r"("
    r"\b(Loop Road|Tunnel Approach|Tunnel Exit)\b|"     # park/tunnel access roads
    r"\b(Street|Avenue|Ave)\s+Loop$|"                   # FDR-style access ramps ("14th Street Loop")
    r"\bRoundabout\b|"                                  # traffic roundabout labels
    r"\b(State Route|State Highway)\b|"                 # route designations
    r"Bus.{0,2}Taxi|"                                   # bus/taxi infrastructure
    r"\bTerminal\b.*(Loop|Lane|Road)|"                  # airport/terminal service roads
    r"\bAviation (Road|Lane|Layne)\b|"                  # airport service roads
    r"\bReservation$|"                                  # park reservations
    r"Bronx State Hospital"                             # institution names mistakenly in OSM
    r")",
    re.IGNORECASE,
)


def normalize_name(name: str) -> str | None:
    """
    Normalize a street name for the game:
    - Strip 'East'/'West' prefix from numbered streets so 'West 72nd Street'
      and 'East 72nd Street' both become '72nd Street' (one answer).
    - Return None to exclude the street entirely (bridges, tunnels, park roads).
    """
    # Drop intersection labels (e.g. "East Tremont Avenue / Westchester Square")
    if "/" in name:
        return None

    # Drop bridges/tunnels/park roads/non-streets that OSM doesn't tag cleanly
    for suffix in _EXCLUDE_SUFFIXES:
        if name.endswith(suffix):
            return None
    if _EXCLUDE_PATTERNS.search(name):
        return None

    # Consolidate directional numbered streets
    m = _DIRECTIONAL_STREET.match(name)
    if m:
        return m.group(1)  # e.g. "72nd Street"

    return name


def process_borough(name: str, raw: dict, min_segments: int = 2) -> tuple[dict, list[str]]:
    """Convert raw Overpass response into a GeoJSON FeatureCollection + sorted names list."""
    features = []
    seen_names = set()

    for way in raw.get("elements", []):
        if way.get("type") != "way":
            continue

        tags = way.get("tags", {})
        raw_name = tags.get("name", "").strip()
        if not raw_name:
            continue

        # Strip OSM parenthetical annotations e.g. "West 155th Street (surface)"
        raw_name = re.sub(r"\s*\(.*?\)\s*$", "", raw_name).strip()

        street_name = normalize_name(raw_name)
        if not street_name:
            continue

        # Build LineString geometry from node positions
        coords = [
            [node["lon"], node["lat"]]
            for node in way.get("geometry", [])
        ]
        if len(coords) < 2:
            continue

        seen_names.add(street_name)
        features.append({
            "type": "Feature",
            "properties": {
                "name": street_name,
                "highway": tags.get("highway"),
            },
            "geometry": {
                "type": "LineString",
                "coordinates": coords,
            },
        })

    # Apply minimum segment filter — drop streets that only appear on one short block
    if min_segments > 1:
        from collections import Counter
        seg_counts = Counter(f["properties"]["name"] for f in features)
        features = [f for f in features if seg_counts[f["properties"]["name"]] >= min_segments]
        seen_names = {f["properties"]["name"] for f in features}

    geojson = {"type": "FeatureCollection", "features": features}
    names = sorted(seen_names, key=str.lower)
    return geojson, names


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fresh", action="store_true", help="Re-fetch even if cached data exists")
    args = parser.parse_args()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("\n── boundaries ──")
    fetch_boundaries()

    summary = {}

    for borough_name, relation_id in BOROUGHS.items():
        print(f"\n── {borough_name} ──")

        raw = fetch_borough(borough_name, relation_id, fresh=args.fresh)

        geojson, names = process_borough(borough_name, raw, min_segments=MIN_SEGMENTS[borough_name])
        print(f"  {len(names)} unique street names across {len(geojson['features'])} segments")

        (OUT_DIR / f"{borough_name}.geojson").write_text(json.dumps(geojson))
        (OUT_DIR / f"{borough_name}_names.json").write_text(json.dumps(names, indent=2))

        summary[borough_name] = {
            "street_count": len(names),
            "segment_count": len(geojson["features"]),
        }

        # Be polite to the Overpass API between borough queries
        time.sleep(2)

    (OUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2))

    print("\n── Summary ──")
    total = 0
    for borough, stats in summary.items():
        print(f"  {borough:15s} {stats['street_count']:>4} streets  ({stats['segment_count']} segments)")
        total += stats["street_count"]
    print(f"  {'TOTAL':15s} {total:>4} streets")
    print(f"\nOutput written to {OUT_DIR}/")


if __name__ == "__main__":
    main()
