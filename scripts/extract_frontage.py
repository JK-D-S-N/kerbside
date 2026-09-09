"""
Build src/frontage.js from OpenStreetMap.

Takes the real Upper Newtownards Road centreline, picks the 400 m section that
carries the tagged bus lane, and projects the building footprints either side of
it into the scene's local frame: +z along the road, x across it, origin at the
middle of the section.

Run:  python3 scripts/extract_frontage.py
Data: OpenStreetMap contributors, ODbL. Requires network access.
"""
import json, math, time, urllib.request, urllib.parse, pathlib

# The main instance rate-limits and 504s under load, so fall through mirrors.
OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]
SECTION_LEN = 800.0      # metres of road to model, matching ROAD_LEN in scene.js
CORRIDOR = 95.0          # how far back from the centreline to take frontage
MIN_SETBACK = 7.0        # ignore anything sitting on the carriageway
LEVEL_HEIGHT = 3.1       # metres per storey
PARAPET = 0.8            # allowance above the top floor

ROAD_NAME = 'Upper Newtownards Road'
ROAD_BBOX = '54.55,-5.95,54.63,-5.75'

# The model runs on DfI count points 918 and 921. Both sit on the Upper
# Newtownards Road within 60 m of each other. The scene is built around them
# rather than around whichever stretch happens to look busiest: a picture of a
# different piece of road corroborates nothing.
# Places a local uses to say where they are on this road.
LANDMARKS = {
    'Holywood Arches': (54.59896, -5.88866),
    'Ballyhackamore': (54.59514, -5.86681),
    'Knock': (54.59470, -5.85530),
    # The junction node where Prince of Wales Avenue meets the A20, not
    # count point 921. They are 349 m apart and this one is the gates.
    'Stormont gates': (54.5954309, -5.8402692),
    'Dundonald': (54.59394, -5.77215),
}

COUNT_POINTS = {
    '918': (54.59478, -5.83513),   # outbound, opposite Summerhill Avenue
    '921': (54.59528, -5.83478),   # inbound, Stormont estate entrance
}


def overpass(query):
    body = urllib.parse.urlencode({'data': query}).encode()
    last = None
    for attempt in range(3):
        for endpoint in OVERPASS:
            # Overpass rejects the stock urllib agent with a 406.
            req = urllib.request.Request(endpoint, data=body,
                                         headers={'User-Agent': 'kerbside/0.1 (corridor model)'})
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    return json.load(r)
            except Exception as e:                      # noqa: BLE001
                print(f'  {endpoint.split("/")[2]}: {e}')
                last = e
        time.sleep(12 * (attempt + 1))
    raise SystemExit(f'every Overpass mirror failed: {last}')


def haversine(a, b):
    r = 6371000.0
    dla, dlo = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    h = (math.sin(dla / 2) ** 2
         + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(dlo / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(h))


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

    return project


def height_of(tags):
    """Metres, preferring surveyed height, then storeys, then a sane default."""
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
            'apartments': 11.0, 'garage': 3.2, 'garages': 3.2, 'shed': 2.8}.get(kind, 7.0)


def footprints(elements, project, half):
    """Buildings that fall inside the modelled section, in the local frame."""
    out = []
    for el in elements:
        geom = el.get('geometry') or []
        if len(geom) < 4:
            continue
        pts = [project((n['lat'], n['lon'])) for n in geom]
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        if len(pts) < 3:
            continue

        cx = sum(p[0] for p in pts) / len(pts)
        cz = sum(p[1] for p in pts) / len(pts)
        if abs(cz) > half or abs(cx) > CORRIDOR or abs(cx) < MIN_SETBACK:
            continue

        # Drop the footprint to the nearest 5 cm; it keeps the file small and no
        # facade is surveyed anywhere near that finely.
        ring = [[round(x, 2), round(z, 2)] for x, z in pts]
        area = abs(sum(ring[i][0] * ring[(i + 1) % len(ring)][1]
                       - ring[(i + 1) % len(ring)][0] * ring[i][1]
                       for i in range(len(ring)))) / 2
        if area < 12:
            continue

        tags = el.get('tags', {})
        out.append({
            'id': el['id'],
            'side': -1 if cx < 0 else 1,
            'height': round(height_of(tags), 1),
            'name': tags.get('name'),
            'ring': ring,
        })

    out.sort(key=lambda b: (b['side'], b['ring'][0][1]))
    return out


# Parliament Buildings is a multipolygon relation, not a way, and it sits about
# a kilometre up Prince of Wales Avenue rather than beside the carriageway. The
# earlier query asked for ways inside a box that stopped short of it on both
# counts, which is why PARLIAMENT came out empty. It is asked for by name here,
# and by relation as well as way, so neither mistake can recur silently.
PARLIAMENT_BBOX = '54.598,-5.845,54.612,-5.820'


def outer_rings(el):
    """Closed rings for a way or for the outer members of a multipolygon."""
    if el['type'] == 'way':
        return [el.get('geometry') or []]
    return [m.get('geometry') or [] for m in el.get('members', [])
            if m.get('role') == 'outer']


def ground_height(points):
    """
    Metres above sea level for each lat/lon, from the Copernicus 30 m DEM.

    Stormont is on a rise and the model has no terrain, so the height the
    building sits at has to come from somewhere. Falling back to a flat plain
    would put Parliament Buildings in a hollow, which is the one thing anyone
    who has driven up that avenue would notice.
    """
    lat = ','.join(f'{p[0]:.6f}' for p in points)
    lon = ','.join(f'{p[1]:.6f}' for p in points)
    url = f'https://api.open-meteo.com/v1/elevation?latitude={lat}&longitude={lon}'
    req = urllib.request.Request(url, headers={'User-Agent': 'kerbside/0.1 (corridor model)'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)['elevation']


# How far a side road is carried away from the corridor. Past about 100 m it is
# behind the frontage and doing no work, and the point of drawing it at all is
# that a set of lights on an unbroken carriageway reads as arbitrary.
STREET_REACH = 110.0
DEFAULT_STREET_WIDTH = 6.0    # assumption: a Belfast residential side street


def side_street_legs(project, half, streets):
    """
    Centreline for each street that meets the corridor, in the scene frame.

    Every way carrying the name is taken, not just the one holding the junction
    node, because OSM splits a street at every change of tagging.
    """
    if not streets:
        return {}
    names = '|'.join(sorted(streets))
    els = overpass(
        f'[out:json][timeout:120];'
        f'way["highway"]["name"~"^({names})$"]({ROAD_BBOX});out geom tags;')['elements']

    pool = {name: [] for name in streets}
    for el in els:
        name = el.get('tags', {}).get('name')
        if name not in pool:
            continue
        jx, jz = streets[name]
        pts = [project((n['lat'], n['lon'])) for n in el.get('geometry') or []]
        # Shift onto the drawn centreline before clipping, or the reach is
        # measured from the wrong place.
        pts = [(x - jx, z) for x, z in pts
               if abs(x - jx) <= STREET_REACH and abs(z) <= half]
        if len(pts) < 2:
            continue
        # Node order within a way is the real geometry, so keep it and only
        # decide which end is the junction.
        if math.hypot(*(pts[0][0], pts[0][1] - jz)) > math.hypot(*(pts[-1][0], pts[-1][1] - jz)):
            pts.reverse()
        pool[name].append(pts)

    out = {}
    for name, runs in pool.items():
        if not runs:
            continue
        jx, jz = streets[name]
        runs.sort(key=lambda r: math.hypot(r[0][0], r[0][1] - jz))
        run, last = [], None
        for r in runs:
            for x, z in r:
                if last is not None and math.hypot(x - last[0], z - last[1]) < 1.5:
                    continue
                run.append([round(x, 1), round(z, 1)])
                last = (x, z)
        if len(run) < 2:
            continue
        out[name] = run
        print(f'  {name}: {len(run)} centreline points, reaching '
              f'{max(abs(p[0]) for p in run):.0f} m from the corridor')
    return out


def parliament_buildings(project):
    """The real footprint, its height, and how far it stands above the road."""
    els = overpass(
        f'[out:json][timeout:120];('
        f'rel["building"]["name"="Parliament Buildings"]({PARLIAMENT_BBOX});'
        f'way["building"]["name"="Parliament Buildings"]({PARLIAMENT_BBOX});'
        # `out geom tags` prints tags ONLY, which silently drops a relation's
        # members. Plain `out geom` gives body, geometry and tags together.
        f');out geom;')['elements']
    rings, tags, geo = [], {}, []
    for el in els:
        tags = el.get('tags', {}) or tags
        for g in outer_rings(el):
            if len(g) < 4:
                continue
            geo += g
            pts = [project((n['lat'], n['lon'])) for n in g]
            if pts[0] == pts[-1]:
                pts = pts[:-1]
            rings.append([[round(x, 1), round(z, 1)] for x, z in pts])
    if not rings:
        print('  Parliament Buildings: NOTHING RETURNED')
        return [], {}

    lat = sum(n['lat'] for n in geo) / len(geo)
    lon = sum(n['lon'] for n in geo) / len(geo)
    road = COUNT_POINTS['921']
    try:
        elev = ground_height([(lat, lon), road])
        rise = round(elev[0] - elev[1], 1)
    except Exception as e:                              # noqa: BLE001
        print(f'  elevation lookup failed ({e}), falling back to 63 m')
        rise = 63.0
    meta = {'height': round(height_of(tags), 1), 'rise': rise,
            'name': tags.get('name', 'Parliament Buildings')}
    print(f'Parliament Buildings: {len(rings)} outer ring(s), '
          f"{meta['height']} m tall, {rise} m above the carriageway")
    return rings, meta


def main():
    ways = overpass(
        f'[out:json][timeout:120];'
        f'way["name"="{ROAD_NAME}"]["highway"]({ROAD_BBOX});out geom;'
    )['elements']
    print(f'{len(ways)} road ways named {ROAD_NAME}')

    lats = [n['lat'] for w in ways for n in w['geometry']]
    lons = [n['lon'] for w in ways for n in w['geometry']]
    bbox = f'{min(lats)-0.002},{min(lons)-0.003},{max(lats)+0.002},{max(lons)+0.003}'
    buildings = overpass(f'[out:json][timeout:180];(way["building"]({bbox}););out geom;')['elements']
    print(f'{len(buildings)} buildings along the road')

    # One side of this section is the Stormont estate, so the honest frontage
    # there is grass and trees, not an empty plane.
    green = overpass(
        f'[out:json][timeout:180];('
        f'way["leisure"~"park|garden|pitch|golf_course"]({bbox});'
        f'way["landuse"~"grass|forest|meadow|recreation_ground|cemetery"]({bbox});'
        f'way["natural"~"wood|scrub|grassland"]({bbox});'
        f');out geom;')['elements']
    trees = overpass(f'[out:json][timeout:120];(node["natural"="tree"]({bbox}););out;')['elements']
    print(f'{len(green)} green areas, {len(trees)} mapped trees')

    # Every named road that touches the corridor. These are what tell a local
    # where they are standing, faster than any coordinate.
    side = overpass(
        f'[out:json][timeout:180];'
        f'way["name"="{ROAD_NAME}"]["highway"]({ROAD_BBOX})->.r;'
        f'node(w.r)->.j;'
        f'way(bn.j)["highway"]["name"];'
        f'out geom tags;')['elements']
    print(f'{len(side)} named ways meeting the corridor')

    # Centre the section on the count points and take the bearing from the way
    # that actually passes through them.
    pts = list(COUNT_POINTS.values())
    centre = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

    near = None
    for w in ways:
        g = [(n['lat'], n['lon']) for n in w['geometry']]
        if haversine(g[0], g[-1]) < 40:
            continue
        d = min(haversine(centre, n) for n in g)
        if near is None or d < near['d']:
            near = {'d': d, 'g': g, 'w': w}

    g = near['g']
    print(f"nearest road way {near['w']['id']}, {near['d']:.0f} m from the count points")

    # Walk out half the section length each way from the centre, along the
    # bearing of that way.
    lat0 = centre[0]
    mlat = 111132.92 - 559.82 * math.cos(2 * math.radians(lat0))
    mlon = 111412.84 * math.cos(math.radians(lat0))
    dx = (g[-1][1] - g[0][1]) * mlon
    dy = (g[-1][0] - g[0][0]) * mlat
    norm = math.hypot(dx, dy)
    ux, uy = dx / norm, dy / norm
    half = SECTION_LEN / 2
    a = (centre[0] - uy * half / mlat, centre[1] - ux * half / mlon)
    b = (centre[0] + uy * half / mlat, centre[1] + ux * half / mlon)

    project = local_frame(a, b)
    kept = footprints(buildings, project, half)

    # Green areas, clipped the same way as the frontage.
    greens = []
    for el in green:
        geom = el.get('geometry') or []
        if len(geom) < 4:
            continue
        pts = [project((n['lat'], n['lon'])) for n in geom]
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        inside = [q for q in pts if abs(q[1]) <= half * 1.6 and abs(q[0]) <= CORRIDOR * 1.6]
        if len(inside) < 3:
            continue
        greens.append({'id': el['id'],
                       'ring': [[round(x, 1), round(z, 1)] for x, z in pts]})

    wood = []
    for el in trees:
        x, z = project((el['lat'], el['lon']))
        if abs(z) > half or abs(x) > CORRIDOR or abs(x) < MIN_SETBACK:
            continue
        wood.append([round(x, 1), round(z, 1)])
    print(f'{len(greens)} green areas and {len(wood)} trees inside the section')

    # The Stormont gates sit at the centre of this section, and they are the
    # single thing that tells a Belfast audience where they are standing.
    # Only the avenue. An earlier version also pulled way["barrier"] over a
    # bounding box, which returns every garden fence and hedge in Ballymiscaw
    # rather than the estate wall, and the scene scattered them as black
    # fragments across the footway. No wall beats the wrong wall.
    gates = overpass(
        f'[out:json][timeout:120];('
        f'way["name"="Prince of Wales Avenue"](54.590,-5.845,54.610,-5.820);'
        f');out geom tags;')['elements']

    avenue = []
    for el in gates:
        pts = [project((n['lat'], n['lon'])) for n in el.get('geometry') or []]
        if len(pts) < 2:
            continue
        run = [[round(x, 1), round(z, 1)] for x, z in pts
               if abs(z) <= half * 3 and abs(x) < 1400]
        if len(run) >= 2:
            avenue.append(run)
    print(f'gates: {len(avenue)} avenue runs')

    parliament, parl_meta = parliament_buildings(project)

    # A side street is placed at the point where it comes closest to the
    # centreline, which is its junction with the corridor.
    streets = {}
    for el in side:
        name = el.get('tags', {}).get('name')
        if not name or name == ROAD_NAME:
            continue
        for n in el.get('geometry') or []:
            x, z = project((n['lat'], n['lon']))
            if abs(z) > half - 12 or abs(x) > 34:
                continue
            prev = streets.get(name)
            if prev is None or abs(x) < abs(prev[0]):
                streets[name] = (round(x, 1), round(z, 1))
    print(f'{len(streets)} side streets on the section: {", ".join(sorted(streets))}')

    legs = side_street_legs(project, half, streets)
    left = sum(1 for x in kept if x['side'] == -1)
    best = {'a': a, 'b': b, 'mid': centre, 'left': left,
            'right': len(kept) - left, 'kept': kept, 'way': near['w']}

    a, b = best['a'], best['b']
    print(f"section centred {best['mid'][0]:.5f},{best['mid'][1]:.5f} on count points {', '.join(COUNT_POINTS)}")
    print(f"  {len(best['kept'])} buildings, {best['left']} west/north side, {best['right']} east/south")
    out = best['kept']
    SEG_A, SEG_B = a, b
    named = sum(1 for x in out if x['name'])
    print(f'{len(out)} kept within the {SECTION_LEN:.0f} m section, {named} named')

    path = pathlib.Path('src/frontage.js')
    lines = [
        '// GENERATED from OpenStreetMap by scripts/extract_frontage.py.',
        '// Do not hand-edit.',
        '//',
        '// Building footprints along the modelled 400 m of the Upper Newtownards',
        '// Road (A20), Belfast, in the scene frame: x across the road, z along it.',
        '// Heights are surveyed where OSM has them and derived from building:levels',
        '// otherwise, so treat them as indicative.',
        '//',
        '// (c) OpenStreetMap contributors, ODbL.',
        '',
        f'export const SECTION_LENGTH = {SECTION_LEN:.0f};',
        f'export const ANCHOR = {{ a: [{SEG_A[0]}, {SEG_A[1]}], b: [{SEG_B[0]}, {SEG_B[1]}] }};',
        '',
        'export const FRONTAGE = [',
    ]
    for b in out:
        name = f", name: {json.dumps(b['name'])}" if b['name'] else ''
        ring = ','.join(f'[{x},{z}]' for x, z in b['ring'])
        lines.append(f"  {{ id: {b['id']}, side: {b['side']}, height: {b['height']}{name}, ring: [{ring}] }},")
    lines += ['];', '']
    lines.append('/** Grass, parkland and estate ground beside the carriageway. */')
    lines.append('export const GREENS = [')
    for gr in greens:
        ring = ','.join(f'[{x},{z}]' for x, z in gr['ring'])
        lines.append(f"  {{ id: {gr['id']}, ring: [{ring}] }},")
    lines += ['];', '']
    lines.append('/** Individually mapped trees, as [x, z]. */')
    lines.append(f'export const TREES = {json.dumps(wood)};')
    lines.append('')
    # A locator: the corridor either side of the section, in the same frame, so
    # the UI can show WHERE on the road this 400 m sits. Asking "am I at
    # Stormont?" of a 3D view is a fair question; a plan answers it instantly.
    LOC_RANGE = 3000.0
    tracks = []
    for w in ways:
        pts = [project((n['lat'], n['lon'])) for n in w['geometry']]
        run = [q for q in pts if abs(q[1]) <= LOC_RANGE and abs(q[0]) < 60]
        if len(run) < 2:
            continue
        tracks.append([[round(x, 1), round(z, 1)] for x, z in run])
    lines.append('/** The corridor either side of the section, for the locator plan. */')
    lines.append(f'export const LOCATOR_RANGE = {LOC_RANGE:.0f};')
    lines.append('export const CORRIDOR = [')
    for tr in tracks:
        lines.append('  [' + ','.join(f'[{x},{z}]' for x, z in tr) + '],')
    lines += ['];', '']

    lines.append('/** Named places along the corridor, to anchor the locator. */')
    lines.append('export const LANDMARKS = [')
    for name, ll in LANDMARKS.items():
        x, z = project(ll)
        if abs(z) <= LOC_RANGE * 1.05:
            lines.append(f'  {{ name: {json.dumps(name)}, x: {round(x,1)}, z: {round(z,1)} }},')
    lines += ['];', '']

    lines.append('/** The count points the model runs on, in the scene frame. */')
    lines.append('export const COUNT_POINTS = [')
    for cid, ll in COUNT_POINTS.items():
        x, z = project(ll)
        lines.append(f'  {{ id: {json.dumps(cid)}, x: {round(x,1)}, z: {round(z,1)} }},')
    lines += ['];', '']

    lines.append('/** Stormont: the avenue and Parliament Buildings. */')
    for var, data in [('AVENUE', avenue), ('PARLIAMENT', parliament)]:
        lines.append(f'export const {var} = [')
        for run in data:
            lines.append('  [' + ','.join(f'[{x},{z}]' for x, z in run) + '],')
        lines += ['];', '']
    lines.append('/** Parliament Buildings: OSM building:levels, and DEM rise above the road. */')
    lines.append(f'export const PARLIAMENT_META = {json.dumps(parl_meta)};')
    lines.append('')

    lines.append('/**')
    lines.append(' * Side streets meeting the corridor, at their junction.')
    lines.append(' *')
    lines.append(' * `centre` is the real centreline, junction end first, running away from')
    lines.append(' * the corridor. It is shifted in x so the junction sits on the drawn')
    lines.append(' * centreline: the drawn corridor is straight and the real one curves, so')
    lines.append(' * without that the mouth misses the road by up to 30 m.')
    lines.append(' */')
    lines.append('export const STREETS = [')
    for name, (x, z) in sorted(streets.items(), key=lambda kv: kv[1][1]):
        run = legs.get(name) or []
        centre = ','.join(f'[{cx},{cz}]' for cx, cz in run)
        lines.append(f'  {{ name: {json.dumps(name)}, x: {x}, z: {z}, '
                     f'side: {-1 if x < 0 else 1}, centre: [{centre}] }},')
    lines += ['];', '']
    path.write_text('\n'.join(lines))
    print(f'wrote {path} ({path.stat().st_size / 1024:.0f} kB)')


if __name__ == '__main__':
    main()
