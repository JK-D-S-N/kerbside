"""
Build src/context.js from OpenStreetMap.

scripts/extract_frontage.py models the 800 m section itself. Beyond 95 m either
side of the centreline that scene stops dead, so there is nothing to place
yourself against. This pulls the wider setting into the same frame: the named
roads that meet or run near the corridor, the Stormont estate and its parkland,
Campbell College, the churches, and lower-detail massing for the townscape out
to 1.6 km.

It reuses the frame from src/frontage.js rather than recomputing it, because
the two files have to land on top of each other and the only way to guarantee
that is to read the anchor the frontage was actually built from.

Run:  python3 scripts/extract_context.py
Data: OpenStreetMap contributors, ODbL. Ground heights from Open-Meteo's
      Copernicus DEM GLO-90 service. Requires network access.
"""
import json, math, re, tempfile, time, urllib.request, urllib.parse, pathlib

# The main instance rate-limits and 504s under load, so fall through mirrors.
# Same pattern as extract_frontage.py; it is the one that survives a bad day.
OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]
ELEVATION = 'https://api.open-meteo.com/v1/elevation'

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Outside the repo on purpose. It runs to tens of megabytes and .gitignore has
# no entry for it.
CACHE = pathlib.Path(tempfile.gettempdir()) / 'kerbside-context-cache'

RANGE = 1600.0        # how far out to take roads, buildings and parkland
PLACE_RANGE = 2200.0  # settlement names reach further; they say which way you face
CORRIDOR = 95.0       # where extract_frontage.py stops, so where this starts
SECTION_HALF = 400.0  # half of SECTION_LENGTH in src/frontage.js
LEVEL_HEIGHT = 3.1
PARAPET = 0.8

# scene.js lays a 1400 m square of flat ground over the model. Real ground
# heights are held down under it and only allowed to show outside, or the
# terrain would burst up through the carriageway.
GROUND_HALF = 700.0
FLAT_HALF = 690.0
FEATHER = 320.0

TERRAIN_STEP = 100.0   # DEM sample spacing, metres
TERRAIN_HALF = 1800.0

# Roads worth drawing at distance. Residential closes are only drawn where they
# actually touch the corridor; a full suburban street plan is noise, not
# orientation.
CLASSED = ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified')
ROAD_WIDTH = {'motorway': 14.0, 'trunk': 12.0, 'primary': 11.0, 'secondary': 9.0,
              'tertiary': 7.5, 'unclassified': 6.5, 'residential': 5.5,
              'living_street': 5.0}
RESIDENTIAL_REACH = 340.0

# The side streets that meet the drawn 800 m are modelled by
# scripts/extract_frontage.py and drawn by scene.js, junction mouths and stop
# lines and all. Drawing them again here would double the geometry and fight
# over the labels, so this file starts where that one stops.
SECTION_OWNED = {'Rosepark', 'Rosemount Avenue', 'Summerhill Avenue'}
INNER = 120.0

# The places a driver on this road actually names. Everything else OSM knows
# about is real but does not help you say where you are, so it goes in at half
# weight and the renderer can drop it.
MAJOR = {
    'Parliament Buildings', 'Stormont Castle', 'Stormont House', 'Castle Buildings',
    'Campbell College', 'Stormont Hotel', "Saint Molua's", 'Ulster Hospital',
    "Carson's Statue", 'Stormont Estate', 'Knock', 'Dundonald', 'Ballyhackamore',
    'Stormont', 'Belmont', 'Gilnahirk', 'Ballyhackamore', 'Knock Presbyterian',
    'Department of Agriculture, Environment and Rural Affairs',
}
# Rooms inside Parliament Buildings, mapped as attractions. A label for each
# would sit on top of the building label and say nothing.
SKIP_NAMES = {'Assembly Chamber', 'Senate Chamber'}


def overpass(query):
    body = urllib.parse.urlencode({'data': query}).encode()
    last = None
    for attempt in range(3):
        for endpoint in OVERPASS:
            # Overpass rejects the stock urllib agent with a 406.
            req = urllib.request.Request(endpoint, data=body,
                                         headers={'User-Agent': 'kerbside/0.1 (corridor model)'})
            try:
                with urllib.request.urlopen(req, timeout=240) as r:
                    return json.load(r)
            except Exception as e:                      # noqa: BLE001
                print(f'  {endpoint.split("/")[2]}: {e}')
                last = e
        time.sleep(12 * (attempt + 1))
    raise SystemExit(f'every Overpass mirror failed: {last}')


def query(name, q):
    """Overpass, cached on disk. The four queries here take minutes and the
    answers do not move, so a rerun to tweak the filtering should not pay for
    them again."""
    CACHE.mkdir(exist_ok=True)
    f = CACHE / f'{name}.json'
    if f.exists():
        return json.loads(f.read_text())['elements']
    print(f'querying {name} ...')
    data = overpass(q)
    f.write_text(json.dumps(data))
    return data['elements']


# ---- The frame ------------------------------------------------------------
# Copied from local_frame() in extract_frontage.py rather than imported: that
# script does its work at module scope, so importing it would fire off the
# frontage extraction as a side effect.

def read_anchor():
    src = (ROOT / 'src' / 'frontage.js').read_text()
    m = re.search(r'ANCHOR\s*=\s*\{\s*a:\s*\[([-\d.]+),\s*([-\d.]+)\],\s*'
                  r'b:\s*\[([-\d.]+),\s*([-\d.]+)\]\s*\}', src)
    if not m:
        raise SystemExit('no ANCHOR in src/frontage.js; run extract_frontage.py first')
    return ((float(m.group(1)), float(m.group(2))),
            (float(m.group(3)), float(m.group(4))))


def local_frame(a, b):
    """A metric frame centred between a and b, with +z running a -> b."""
    lat0 = (a[0] + b[0]) / 2
    lon0 = (a[1] + b[1]) / 2
    mlat = 111132.92 - 559.82 * math.cos(2 * math.radians(lat0))
    mlon = 111412.84 * math.cos(math.radians(lat0))

    def to_m(p):
        return ((p[1] - lon0) * mlon, (p[0] - lat0) * mlat)

    ax, ay = to_m(a)
    bx, by = to_m(b)
    theta = math.atan2(bx - ax, by - ay)   # bearing of the road, from +y
    cos, sin = math.cos(-theta), math.sin(-theta)

    def project(p):
        """lat/lon -> (x across the road, z along it)."""
        px, py = to_m(p)
        return (px * cos - py * sin, px * sin + py * cos)

    def unproject(q):
        """(x, z) -> lat/lon, for asking a DEM about a point in the frame."""
        px = q[0] * cos + q[1] * sin
        py = -q[0] * sin + q[1] * cos
        return (py / mlat + lat0, px / mlon + lon0)

    return project, unproject


# ---- Geometry -------------------------------------------------------------

def ring_of(el):
    """Outer ring of a way or multipolygon relation, as lat/lon pairs."""
    if el['type'] == 'way':
        return [(n['lat'], n['lon']) for n in el.get('geometry') or []]
    best = []
    for m in el.get('members') or []:
        if m.get('role') != 'outer':
            continue
        g = m.get('geometry') or []
        if len(g) > len(best):
            best = g
    return [(n['lat'], n['lon']) for n in best]


def centroid(pts):
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def area_of(ring):
    n = len(ring)
    return abs(sum(ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1]
                   for i in range(n))) / 2


def hull(pts):
    """Andrew's monotone chain. Feeds the minimum-area rectangle below."""
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts
    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and ((out[-1][0] - out[-2][0]) * (p[1] - out[-2][1])
                                     - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0])) <= 0:
                out.pop()
            out.append(p)
        return out[:-1]
    return half(pts) + half(reversed(pts))


def min_area_box(pts):
    """Smallest enclosing rectangle, as (cx, cz, width, depth, rotation).

    Distant frontage is drawn as massing, not as facades, so a building is worth
    five numbers rather than a twenty-point ring. The minimum-area box keeps the
    thing a terrace does that an axis-aligned box does not: it stays parallel to
    its street.
    """
    h = hull(pts)
    if len(h) < 3:
        return None
    best = None
    for i in range(len(h)):
        ax, az = h[i]
        bx, bz = h[(i + 1) % len(h)]
        ex, ez = bx - ax, bz - az
        n = math.hypot(ex, ez)
        if n < 1e-6:
            continue
        ex, ez = ex / n, ez / n
        us = [(p[0] - ax) * ex + (p[1] - az) * ez for p in h]
        vs = [-(p[0] - ax) * ez + (p[1] - az) * ex for p in h]
        w, d = max(us) - min(us), max(vs) - min(vs)
        if best is None or w * d < best[0]:
            cu = (max(us) + min(us)) / 2
            cv = (max(vs) + min(vs)) / 2
            best = (w * d, ax + cu * ex - cv * ez, az + cu * ez + cv * ex, w, d,
                    math.atan2(ez, ex))
    if best is None:
        return None
    return best[1], best[2], best[3], best[4], best[5]


def height_of(tags):
    """Metres, preferring surveyed height, then storeys, then a sane default.
    Same table as extract_frontage.py so the near and far massing agree."""
    h = tags.get('height')
    if h:
        try:
            return float(str(h).replace('m', '').strip())
        except ValueError:
            pass
    lv = tags.get('building:levels')
    if lv:
        try:
            return float(lv) * LEVEL_HEIGHT + PARAPET
        except ValueError:
            pass
    kind = tags.get('building', 'yes')
    return {'house': 6.0, 'detached': 6.5, 'terrace': 7.2, 'semidetached_house': 6.5,
            'retail': 7.5, 'commercial': 8.5, 'church': 14.0, 'school': 9.0,
            'apartments': 11.0, 'garage': 3.2, 'garages': 3.2, 'shed': 2.8,
            'industrial': 8.0, 'warehouse': 8.0, 'hotel': 12.0}.get(kind, 7.0)


# ---- Ground heights -------------------------------------------------------

def terrain_grid(unproject):
    """A DEM sample grid over the context, in metres above the model datum.

    Stormont sits about 60 m above the road and Parliament Buildings is at the
    top of a 1.2 km climb. Drawn flat it reads as a shed on the horizon, which
    is the opposite of orientation. Copernicus GLO-90 via Open-Meteo, which
    takes 100 points a call and needs no key.
    """
    n = int(TERRAIN_HALF * 2 / TERRAIN_STEP) + 1
    coords = []
    for j in range(n):
        for i in range(n):
            x = -TERRAIN_HALF + i * TERRAIN_STEP
            z = -TERRAIN_HALF + j * TERRAIN_STEP
            coords.append(unproject((x, z)))

    # Cached a chunk at a time. The service rate-limits hard and the grid takes
    # a while, so a run that trips a 429 halfway keeps what it already has.
    CACHE.mkdir(exist_ok=True)
    heights = []
    for k in range(0, len(coords), 100):
        chunk = coords[k:k + 100]
        f = CACHE / f'dem-{k:05d}.json'
        if f.exists():
            heights += json.loads(f.read_text())
            continue
        url = (f'{ELEVATION}?latitude=' + ','.join(f'{c[0]:.5f}' for c in chunk)
               + '&longitude=' + ','.join(f'{c[1]:.5f}' for c in chunk))
        for attempt in range(6):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    got = json.load(r)['elevation']
                f.write_text(json.dumps(got))
                heights += got
                break
            except Exception as e:                       # noqa: BLE001
                print(f'  elevation {k}: {e}')
                time.sleep(8 * (attempt + 1))
        else:
            print('  elevation unavailable, falling back to flat ground')
            return None, n
        time.sleep(3)

    datum = heights[len(heights) // 2]                  # the origin sample
    return [round(h - datum, 1) for h in heights], n


def make_sampler(grid, n):
    """Bilinear lookup into the DEM grid, flattened over the modelled section."""
    if grid is None:
        return lambda x, z: 0.0

    def raw(x, z):
        fi = (x + TERRAIN_HALF) / TERRAIN_STEP
        fj = (z + TERRAIN_HALF) / TERRAIN_STEP
        i = max(0, min(n - 2, int(fi)))
        j = max(0, min(n - 2, int(fj)))
        tu, tv = max(0.0, min(1.0, fi - i)), max(0.0, min(1.0, fj - j))
        h00 = grid[j * n + i]
        h10 = grid[j * n + i + 1]
        h01 = grid[(j + 1) * n + i]
        h11 = grid[(j + 1) * n + i + 1]
        return (h00 * (1 - tu) + h10 * tu) * (1 - tv) + (h01 * (1 - tu) + h11 * tu) * tv

    def sample(x, z):
        return raw(x, z) * blend(x, z)

    return sample


def blend(x, z):
    """0 under scene.js's flat ground square, 1 once clear of it."""
    d = max(abs(x), abs(z))
    t = (d - FLAT_HALF) / FEATHER
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


# ---- Main -----------------------------------------------------------------

def main():
    a, b = read_anchor()
    project, unproject = local_frame(a, b)
    lat0, lon0 = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    print(f'frame anchored on {a} -> {b}')

    around = f'(around:{RANGE:.0f},{lat0},{lon0})'
    roads = query('roads',
                  f'[out:json][timeout:240];'
                  f'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|'
                  f'unclassified|residential|living_street)(_link)?$"]["name"]{around};'
                  f'out geom;')
    builds = query('buildings',
                   f'[out:json][timeout:240];(way["building"]{around};'
                   f'relation["building"]{around};);out geom;')
    green = query('green',
                  f'[out:json][timeout:240];('
                  f'way["leisure"~"^(park|garden|pitch|golf_course|nature_reserve|common)$"]{around};'
                  f'relation["leisure"~"^(park|garden|golf_course|nature_reserve)$"]{around};'
                  f'way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|'
                  f'village_green|allotments|farmland)$"]{around};'
                  f'relation["landuse"~"^(forest|recreation_ground|cemetery|farmland)$"]{around};'
                  f'way["natural"~"^(wood|scrub|grassland|heath|water)$"]{around};'
                  f'relation["natural"~"^(wood|water)$"]{around};'
                  f');out geom;')
    pois = query('pois',
                 f'[out:json][timeout:240];('
                 f'nwr["amenity"~"^(school|college|university|place_of_worship|'
                 f'hospital|townhall|fire_station|library)$"]["name"]{around};'
                 f'nwr["historic"~"^(memorial|monument|castle|manor)$"]["name"]{around};'
                 f'nwr["tourism"~"^(attraction|museum|hotel)$"]["name"]{around};'
                 f'nwr["office"="government"]["name"]{around};'
                 f'nwr["leisure"~"^(sports_centre|stadium|golf_course)$"]["name"]{around};'
                 f'nwr["shop"~"^(supermarket|department_store)$"]["name"]{around};'
                 f');out geom;')
    places = query('places',
                   f'[out:json][timeout:120];'
                   f'node["place"~"^(city|town|village|suburb|neighbourhood|hamlet)$"]["name"]'
                   f'(around:{PLACE_RANGE:.0f},{lat0},{lon0});out;')
    estate = query('estate',
                   f'[out:json][timeout:120];('
                   f'nwr["name"="Stormont Estate"]{around};'
                   f'nwr["name"="Prince of Wales Avenue"]["highway"]{around};'
                   f');out geom;')
    print(f'{len(roads)} named road ways, {len(builds)} buildings, {len(green)} green areas, '
          f'{len(pois)} POIs, {len(places)} place names')

    grid, gn = terrain_grid(unproject)
    ground = make_sampler(grid, gn)
    print(f'DEM grid {gn}x{gn} at {TERRAIN_STEP:.0f} m'
          + ('' if grid else ' (unavailable, flat)'))

    # ---- Roads ------------------------------------------------------------
    # A classified road is drawn wherever it runs. A residential street is only
    # drawn if it reaches the corridor, because that is the only thing it can
    # tell you.
    road_out, junctions = [], {}
    for w in roads:
        t = w.get('tags', {})
        cls = t['highway'].replace('_link', '')
        name = t.get('name')
        if name in SECTION_OWNED:
            continue
        pts = [project(p) for p in [(n['lat'], n['lon']) for n in w.get('geometry') or []]]
        pts = [q for q in pts if math.hypot(q[0], q[1]) <= RANGE * 1.1]
        if len(pts) < 2:
            continue
        near = min(abs(q[0]) for q in pts)
        if cls not in CLASSED and near > RESIDENTIAL_REACH:
            continue
        # An unclassified street whose whole run is inside the modelled section
        # belongs to the frontage model, not to the context.
        if cls not in CLASSED and all(abs(q[1]) < SECTION_HALF and abs(q[0]) < INNER
                                      for q in pts):
            continue
        road_out.append({'name': name, 'ref': t.get('ref'), 'cls': cls,
                         'w': ROAD_WIDTH.get(cls, 6.0),
                         'path': [[round(x, 1), round(z, 1)] for x, z in pts]})

        # Where a named road actually crosses the corridor centreline. The
        # question the model kept failing was "is there a junction here", and
        # this is the answer to it.
        if name == 'Upper Newtownards Road':
            continue
        for x, z in pts:
            # Junctions inside the drawn section already have a stop line and a
            # street name from scene.js. Only the ones past the ends are ours.
            if abs(x) > 40 or abs(z) > RANGE or abs(z) < SECTION_HALF:
                continue
            prev = junctions.get(name)
            if prev is None or abs(x) < abs(prev['x']):
                junctions[name] = {'name': name, 'ref': t.get('ref'), 'cls': cls,
                                   'x': round(x, 1), 'z': round(z, 1),
                                   'rank': 1 if cls in CLASSED else 2}
    print(f'{len(road_out)} road runs, {len(junctions)} named junctions on the corridor')

    # ---- Massing ----------------------------------------------------------
    # Everything the frontage extractor left out: outside its 95 m band, or past
    # the ends of the 800 m section. Reduced to an oriented box each.
    mass, named_ids = [], set()
    for el in builds:
        ring_ll = ring_of(el)
        if len(ring_ll) < 4:
            continue
        pts = [project(p) for p in ring_ll]
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        if len(pts) < 3:
            continue
        cx = sum(p[0] for p in pts) / len(pts)
        cz = sum(p[1] for p in pts) / len(pts)
        r = math.hypot(cx, cz)
        if r > RANGE:
            continue
        # Leave the modelled frontage alone; scene.js already draws it in full.
        if abs(cx) <= CORRIDOR and abs(cz) <= SECTION_HALF:
            continue
        area = area_of(pts)
        floor = 25.0 if r < 400 else (60.0 if r < 900 else 110.0)
        if area < floor:
            continue
        box = min_area_box(pts)
        if box is None:
            continue
        bx, bz, w, d, rot = box
        tags = el.get('tags', {})
        mass.append({'x': round(bx, 1), 'z': round(bz, 1), 'w': round(w, 1),
                     'd': round(d, 1), 'r': round(rot, 3),
                     'h': round(height_of(tags), 1),
                     'b': round(ground(bx, bz), 1)})
        if tags.get('name'):
            named_ids.add((el['type'], el['id']))
    print(f'{len(mass)} massing blocks')

    # ---- Landmark buildings ----------------------------------------------
    # The handful worth their real outline and their real height: you can name
    # them, and their shape is part of how you recognise them.
    poi_by_key = {}
    for el in pois:
        poi_by_key[(el['type'], el['id'])] = el

    landmarks, spires, labels = [], [], []
    for el in pois:
        t = el.get('tags', {})
        name = t.get('name')
        if not name or name in SKIP_NAMES:
            continue
        if el['type'] == 'node':
            pts = [project((el['lat'], el['lon']))]
        else:
            ring_ll = ring_of(el)
            if len(ring_ll) < 3:
                continue
            pts = [project(p) for p in ring_ll]
        xs = [q[0] for q in pts]
        zs = [q[1] for q in pts]
        span = max(max(xs) - min(xs), max(zs) - min(zs))
        if 'boundary' in t or t.get('type') == 'boundary' or span > 1400:
            # Parish and registration-district lines are real but they are not
            # anything you can see from the road. Campus grounds are, and
            # Campbell College's are over a kilometre across, so the cut has to
            # be on what the thing is rather than on how big it is.
            continue
        cx, cz = sum(xs) / len(xs), sum(zs) / len(zs)
        if math.hypot(cx, cz) > RANGE:
            continue
        base = round(ground(cx, cz), 1)
        rank = 1 if name in MAJOR else 2
        labels.append({'name': name, 'x': round(cx, 1), 'z': round(cz, 1),
                       'y': base, 'rank': rank, 'kind': label_kind(t)})

        # Anything inside the frontage band is already drawn in full by
        # scene.js. Keep its name, drop the duplicate solid.
        inside = abs(cx) <= CORRIDOR and abs(cz) <= SECTION_HALF
        if len(pts) >= 4 and t.get('building') and span <= 400 and not inside:
            ring = [[round(x, 1), round(z, 1)] for x, z in pts]
            if ring[0] == ring[-1]:
                ring = ring[:-1]
            landmarks.append({'name': name, 'h': round(height_of(t), 1),
                              'b': base, 'ring': ring})
        if t.get('amenity') == 'place_of_worship' and not inside:
            # A spire is the one piece of skyline a suburb has. OSM does not
            # map them separately here, so this is a marker at the church
            # centroid, not a surveyed structure.
            spires.append({'name': name, 'x': round(cx, 1), 'z': round(cz, 1),
                           'b': base, 'h': round(height_of(t) + 12.0, 1)})

    # Settlement names. These reach further out than anything else, and they
    # are the fastest answer to "which way am I pointing".
    for el in places:
        t = el.get('tags', {})
        x, z = project((el['lat'], el['lon']))
        if math.hypot(x, z) > PLACE_RANGE:
            continue
        labels.append({'name': t['name'], 'x': round(x, 1), 'z': round(z, 1),
                       'y': round(ground(x, z), 1),
                       'rank': 1 if t['name'] in MAJOR else 2, 'kind': 'place'})
    labels.sort(key=lambda l: (l['rank'], -abs(l['z'])))
    print(f'{len(landmarks)} landmark outlines, {len(spires)} churches, {len(labels)} labels')

    # ---- Parkland ---------------------------------------------------------
    greens = []
    for el in green:
        ring_ll = ring_of(el)
        if len(ring_ll) < 4:
            continue
        pts = [project(p) for p in ring_ll]
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        if len(pts) < 3:
            continue
        cx = sum(p[0] for p in pts) / len(pts)
        cz = sum(p[1] for p in pts) / len(pts)
        if math.hypot(cx, cz) > RANGE * 1.3:
            continue
        if area_of(pts) < 900:
            continue
        t = el.get('tags', {})
        kind = ('water' if t.get('natural') == 'water' else
                'wood' if t.get('natural') in ('wood', 'scrub') or t.get('landuse') == 'forest'
                else 'grass')
        # Two decimal places is finer than any of this is surveyed and it
        # doubles the file. One is plenty at this distance.
        greens.append({'kind': kind,
                       'ring': [[round(x, 1), round(z, 1)] for x, z in pts]})
    print(f'{len(greens)} parkland areas')

    # ---- The avenue and the estate ---------------------------------------
    avenue, estate_ring = [], []
    for el in estate:
        t = el.get('tags', {})
        if t.get('highway'):
            pts = [project((n['lat'], n['lon'])) for n in el.get('geometry') or []]
            if len(pts) >= 2:
                avenue.append([[round(x, 1), round(z, 1)] for x, z in pts])
        elif t.get('name') == 'Stormont Estate':
            ring_ll = ring_of(el)
            if len(ring_ll) > len(estate_ring):
                estate_ring = ring_ll
    estate_out = [[round(x, 1), round(z, 1)] for x, z in
                  (project(p) for p in estate_ring)]
    print(f'{len(avenue)} avenue runs, estate ring {len(estate_out)} points')

    # Two labels that are not POIs but are the two things a local says first.
    # Both come out of geometry already extracted, not out of thin air.
    if estate_out:
        ex = sum(q[0] for q in estate_out) / len(estate_out)
        ez = sum(q[1] for q in estate_out) / len(estate_out)
        labels.append({'name': 'Stormont Estate', 'x': round(ex, 1), 'z': round(ez, 1),
                       'y': round(ground(ex, ez), 1), 'rank': 1, 'kind': 'estate'})
    gate = None
    for run in avenue:
        for x, z in run:
            if gate is None or abs(x) < abs(gate[0]):
                gate = (x, z)
    if gate:
        labels.append({'name': 'Stormont gates', 'x': round(gate[0], 1),
                       'z': round(gate[1], 1), 'y': 0, 'rank': 1, 'kind': 'gate'})
    labels.sort(key=lambda l: (l['rank'], -abs(l['z'])))

    write(ROOT / 'src' / 'context.js', dict(
        roads=road_out, junctions=sorted(junctions.values(), key=lambda j: j['z']),
        mass=mass, landmarks=landmarks, spires=spires, labels=labels,
        greens=greens, avenue=avenue, estate=estate_out,
        grid=grid, gn=gn))

    # ---- Verification ------------------------------------------------------
    # Four positions in this frame are known independently. If the projection
    # has drifted, everything else in the file is wrong too, so say so loudly.
    print('\nframe check')
    checks = [
        ('count point 918', (54.59478, -5.83513), (-29, 7)),
        ('count point 921', (54.59528, -5.83478), (29, -7)),
        ('Stormont gates', (54.5954312, -5.8402694), (-10, 349)),
        ('Parliament Buildings', (54.60500, -5.83210), (1125, -34)),
    ]
    for name, ll, want in checks:
        x, z = project(ll)
        ok = abs(x - want[0]) < 12 and abs(z - want[1]) < 12
        print(f'  {name:22s} {x:8.1f} {z:8.1f}   expected {want[0]:6} {want[1]:6}'
              f'   {"ok" if ok else "MISMATCH"}')


def label_kind(t):
    if t.get('amenity') == 'place_of_worship':
        return 'church'
    if t.get('amenity') in ('school', 'college', 'university'):
        return 'school'
    if t.get('amenity') == 'hospital':
        return 'hospital'
    if t.get('office') == 'government':
        return 'civic'
    if t.get('shop'):
        return 'shop'
    if t.get('historic'):
        return 'monument'
    return 'poi'


def write(path, d):
    n = lambda v: f'{v:g}'
    L = [
        '// GENERATED from OpenStreetMap by scripts/extract_context.py.',
        '// Do not hand-edit.',
        '//',
        '// The wider setting around the modelled 800 m of the Upper Newtownards',
        '// Road (A20), Belfast, in the same frame as src/frontage.js: x across the',
        '// road, z along it, origin at DfI count points 918 and 921.',
        '//',
        '// Everything here is surveyed data. Heights come from OSM where it has',
        '// them and from storey counts where it does not, so treat them as',
        '// indicative. Ground heights are a DEM sample, held flat under the',
        '// modelled section so the terrain cannot rise through the carriageway.',
        '//',
        '// (c) OpenStreetMap contributors, ODbL.',
        '// Ground heights: Copernicus DEM GLO-90 via Open-Meteo.',
        '',
        f'export const CONTEXT_RANGE = {RANGE:.0f};',
        f'export const GROUND_HALF = {GROUND_HALF:.0f};',
        '',
        '/** Named roads near the corridor. `w` is carriageway width in metres. */',
        'export const CONTEXT_ROADS = [',
    ]
    for r in d['roads']:
        ref = f', ref: {json.dumps(r["ref"])}' if r['ref'] else ''
        path_s = ','.join(f'[{n(x)},{n(z)}]' for x, z in r['path'])
        L.append(f'  {{ name: {json.dumps(r["name"])}{ref}, cls: {json.dumps(r["cls"])}, '
                 f'w: {r["w"]}, path: [{path_s}] }},')
    L += ['];', '']

    L.append('/** Where each named road meets the corridor centreline. */')
    L.append('export const CONTEXT_JUNCTIONS = [')
    for j in d['junctions']:
        ref = f', ref: {json.dumps(j["ref"])}' if j['ref'] else ''
        L.append(f'  {{ name: {json.dumps(j["name"])}{ref}, cls: {json.dumps(j["cls"])}, '
                 f'rank: {j["rank"]}, x: {n(j["x"])}, z: {n(j["z"])} }},')
    L += ['];', '']

    L.append('/** Distant massing: an oriented box each. x,z centre, w x d footprint,')
    L.append(' *  r rotation in radians, h height, b ground height at its centre. */')
    L.append('export const CONTEXT_MASSING = [')
    for m in d['mass']:
        L.append(f'  [{n(m["x"])},{n(m["z"])},{n(m["w"])},{n(m["d"])},{n(m["r"])},'
                 f'{n(m["h"])},{n(m["b"])}],')
    L += ['];', '']

    L.append('/** Buildings kept at full outline because you can name them. */')
    L.append('export const CONTEXT_LANDMARKS = [')
    for b in d['landmarks']:
        ring = ','.join(f'[{n(x)},{n(z)}]' for x, z in b['ring'])
        L.append(f'  {{ name: {json.dumps(b["name"])}, h: {n(b["h"])}, b: {n(b["b"])}, '
                 f'ring: [{ring}] }},')
    L += ['];', '']

    L.append('/** Churches, as a marker at the centroid. See the extractor: OSM does')
    L.append(' *  not map these spires, so the cone is a marker, not a survey. */')
    L.append('export const CONTEXT_SPIRES = [')
    for s in d['spires']:
        L.append(f'  {{ name: {json.dumps(s["name"])}, x: {n(s["x"])}, z: {n(s["z"])}, '
                 f'b: {n(s["b"])}, h: {n(s["h"])} }},')
    L += ['];', '']

    L.append('/** Named places. rank 1 is what a local says first. */')
    L.append('export const CONTEXT_LABELS = [')
    for l in d['labels']:
        L.append(f'  {{ name: {json.dumps(l["name"])}, x: {n(l["x"])}, z: {n(l["z"])}, '
                 f'y: {n(l["y"])}, rank: {l["rank"]}, kind: {json.dumps(l["kind"])} }},')
    L += ['];', '']

    L.append('/** Parkland, woodland and water. */')
    L.append('export const CONTEXT_GREEN = [')
    for g in d['greens']:
        ring = ','.join(f'[{n(x)},{n(z)}]' for x, z in g['ring'])
        L.append(f'  {{ kind: {json.dumps(g["kind"])}, ring: [{ring}] }},')
    L += ['];', '']

    L.append('/** Prince of Wales Avenue, the 1.2 km run from the gates to Stormont. */')
    L.append('export const CONTEXT_AVENUE = [')
    for run in d['avenue']:
        L.append('  [' + ','.join(f'[{n(x)},{n(z)}]' for x, z in run) + '],')
    L += ['];', '']

    L.append('/** The Stormont Estate boundary. */')
    L.append('export const CONTEXT_ESTATE = ['
             + ','.join(f'[{n(x)},{n(z)}]' for x, z in d['estate']) + '];')
    L.append('')

    L.append('/** Ground height above the model datum, on a square grid.')
    L.append(' *  Row-major from (-half, -half), stepping east then north in frame axes.')
    L.append(' *  Already faded to zero under the flat ground of the modelled section. */')
    L.append('export const CONTEXT_TERRAIN = {')
    L.append(f'  step: {TERRAIN_STEP:.0f}, n: {d["gn"]}, half: {TERRAIN_HALF:.0f},')
    if d['grid'] is None:
        L.append('  h: null,')
    else:
        flat = [round(h * blend(-TERRAIN_HALF + (i % d['gn']) * TERRAIN_STEP,
                                -TERRAIN_HALF + (i // d['gn']) * TERRAIN_STEP), 1)
                for i, h in enumerate(d['grid'])]
        L.append('  h: [' + ','.join(n(v) for v in flat) + '],')
    L += ['};', '']

    path.write_text('\n'.join(L))
    print(f'wrote {path} ({path.stat().st_size / 1024:.0f} kB)')


if __name__ == '__main__':
    main()
