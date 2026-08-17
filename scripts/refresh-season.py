#!/usr/bin/env python3
"""Refresh one season of coaching staffs and schedule from Wikipedia.

    python3 scripts/refresh-season.py 2026            # fetch, then rebuild
    python3 scripts/refresh-season.py 2026 --offline   # rebuild from the cache

Writes the season into src/data.json (school -> year -> hc/oc/dc/other) and the
deduped game list into src/schedule_<year>.json. Run
`npm run generate:schedule-lineage` afterwards, or just `npm run build`, to
rescore the matchups.

Page titles come from the source_url already recorded in
src/school_records_frontend.json, so the school list stays in sync with the app.
Downloaded wikitext is cached under scripts/.wiki-cache/<year>/ so a re-run costs
nothing; delete that folder to force a fresh fetch.

Sources for a staff, most specific first:
  1. a "Coaching staff" wikitable          (name || position || seasons)
  2. {{American football roster/Footer}}   (*Name - ''Position'' bullets)
  3. the season infobox                    (head_coach / off_coach / def_coach / co-*)
  4. the program page infobox              (head coach only, when no season page exists)

Player-transfer and poll tables are deliberately skipped: their headings collide
with coaching sections ("Acquisitions", "Coaches") and their columns describe
jobs at other schools.
"""
import argparse
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
CACHE = os.path.join(ROOT, 'scripts', '.wiki-cache')
API = 'https://en.wikipedia.org/w/api.php'
UA = {'User-Agent': 'cfb-trees-refresh/1.0 (https://cfb.stoneg.org)'}

# ----------------------------------------------------------------- wiki markup

REF_RE = re.compile(r'<ref[^>]*?/>|<ref[^>]*?>.*?</ref>', re.S | re.I)
COMMENT_RE = re.compile(r'<!--.*?-->', re.S)
# An ASCII hyphen only separates a name from a title when spaces surround it, so
# hyphenated surnames (Spotts-Orgeron) survive.
DASH_SPLIT_RE = re.compile(r'\s+[-–—−]\s+|\s*[–—−]\s*|\s*\|\s*')
NAME_OK = re.compile(r"^[A-Z][A-Za-z.'’\-]*(?: [A-Za-z.'’\-]+)+$")


def strip_noise(s):
    s = COMMENT_RE.sub('', REF_RE.sub('', s))
    return re.sub(r'<[^>]+>', '', s)


def unlink(s):
    s = strip_noise(re.sub(r'<br\s*/?>', ' ', s, flags=re.I))
    s = re.sub(r'\[\[([^\]|]*\|)?([^\]|]+)\]\]', r'\2', s)
    s = re.sub(r"'{2,}", '', s)
    # {{small|Defensive coordinator}} carries its text in the last argument.
    for _ in range(3):
        s = re.sub(r'\{\{[^{}|]*\|([^{}|]*)\}\}', r'\1', s)
    s = re.sub(r'\{\{[^{}]*\}\}', '', s)
    s = s.replace('&nbsp;', ' ').replace('&amp;', '&')
    return re.sub(r'\s+', ' ', s).strip()


def link_target(s):
    m = re.search(r'\[\[([^\]|]+)', s)
    return m.group(1).strip() if m else None


def clean_name(s):
    s = unlink(s)
    s = re.sub(r'^[\*#:;\s]+', '', s)
    s = re.sub(r'^\d+\s*[-–—]\s*', '', s)
    s = re.sub(r'\s*\((?:interim|acting)\)\s*$', '', s, flags=re.I)
    return re.sub(r'\s+', ' ', s.strip(' \t*|–—-−·†‡^~,.')).strip()


def plausible_name(s):
    if not s or len(s) > 40:
        return False
    bad = ('reference', 'source', 'vacant', 'tbd', 'to be', 'none', 'total', 'staff',
           'position', 'media guide', 'roster', 'coach')
    if any(b in s.lower() for b in bad):
        return False
    return bool(NAME_OK.match(s))


def find_template(text, name, start=0):
    """(body, end_index) of the first {{name ...}} at or after start."""
    m = re.search(r'\{\{\s*' + re.escape(name), text[start:], re.I)
    if not m:
        return None, None
    i = start + m.start()
    depth, j = 0, i
    while j < len(text) - 1:
        if text[j:j + 2] == '{{':
            depth += 1
            j += 2
        elif text[j:j + 2] == '}}':
            depth -= 1
            j += 2
            if depth == 0:
                return text[i:j], j
        else:
            j += 1
    return text[i:], len(text)


def split_params(body):
    """Template body -> {param: raw value}, ignoring nested braces and links."""
    inner = body[2:-2] if body.endswith('}}') else body[2:]
    parts, depth, buf, k = [], 0, '', 0
    while k < len(inner):
        two = inner[k:k + 2]
        if two in ('{{', '[['):
            depth += 1
            buf += two
            k += 2
        elif two in ('}}', ']]'):
            depth -= 1
            buf += two
            k += 2
        else:
            if inner[k] == '|' and depth == 0:
                parts.append(buf)
                buf = ''
            else:
                buf += inner[k]
            k += 1
    parts.append(buf)
    out = {}
    for p in parts[1:]:
        if '=' in p:
            key, val = p.split('=', 1)
            out[key.strip().lower()] = val.strip()
    return out


def table_rows(section):
    for tbl in re.findall(r'\{\|.*?\n\|\}', section, re.S):
        for row in re.split(r'\n\|-+', tbl):
            cells = []
            for line in row.split('\n'):
                line = line.strip()
                if not line.startswith('|') or line.startswith(('|}', '|+', '|-')):
                    continue
                cells += re.split(r'\|\|', line.lstrip('|'))
            cells = [re.sub(r'^[^|\[]*?\b(?:align|colspan|rowspan|scope|width|style)\s*=[^|]*\|',
                            '', c, flags=re.I) for c in cells]
            if cells:
                yield cells


def section_bodies(text, heading_re):
    for m in re.finditer(heading_re, text, re.I | re.M):
        start = m.end()
        nxt = re.search(r'^=+ *[^=\n]+ *=+ *$', text[start:], re.M)
        yield text[start:start + nxt.start()] if nxt else text[start:]


# --------------------------------------------------------------- role decoding

# Front-office titles: real jobs, but not coaching lineage.
NON_COACHING = re.compile(
    r'general manager|chief of staff|personnel specialist|athletic trainer|'
    r'\b(?:director|coordinator)\b[^,/]*\b(?:operations|personnel|scouting|equipment|'
    r'recruiting|creative|communications|video|nutrition|sports medicine|player '
    r'development|player acquisition|retention|on-?boarding)\b|'
    r'\b(?:operations|scouting|equipment|nutrition|video)\s+(?:director|coordinator|assistant)\b|'
    r'sports information|academic|compliance|student manager')
COACHING_HINT = re.compile(
    r'coach|coordinator|analyst|assistant|advis|consultant|strength|conditioning|'
    r'performance|quality control|specialist|quarterback|running back|wide receiver|'
    r'tight end|offensive line|defensive line|linebacker|cornerback|safet|secondary|'
    r'defensive back|special teams|nickel|edge|bandit|spear|star|outside|inside|'
    r'pass game|run game|passing game|running game|kicker|punter|return')
HC_EXACT = re.compile(r'^(?:interim |acting |co-)?head coach(?: \((?:interim|acting)\))?$')


def classify(position):
    """Position text -> 'hc' | 'oc' | 'dc' | 'other' | None."""
    p = unlink(position).lower().replace('&', ' and ')
    p = re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 /,()\-]', ' ', p)).strip()
    if not p or NON_COACHING.search(p):
        return None
    # Coordinator titles win over any "head coach" text, so that
    # "co-defensive coordinator/associate head coach" lands in dc.
    if re.search(r'\bco[- ]?offensive coordinator\b|\boffensive coordinator\b', p):
        return 'oc'
    if re.search(r'\bco[- ]?defensive coordinator\b|\bdefensive coordinator\b', p):
        return 'dc'
    # Only a bare "head coach" is the head coach; advisors, analysts, and
    # assistant/associate head coaches are assistants.
    if HC_EXACT.match(p):
        return 'hc'
    return 'other' if COACHING_HINT.search(p) else None


STAFF_HEADING = (r'^=+ *(?:Coaching staff|Support staff|Staff|Roster and coaching staff|'
                 r'Roster and staff|Coaching staff and roster) *=+ *$')
INFOBOX_ROLES = [('head_coach', 'Head coach'), ('head_coach2', 'Head coach'),
                 ('off_coach', 'Offensive coordinator'),
                 ('cooff_coach1', 'Co-offensive coordinator'),
                 ('cooff_coach2', 'Co-offensive coordinator'),
                 ('def_coach', 'Defensive coordinator'),
                 ('codef_coach1', 'Co-defensive coordinator'),
                 ('codef_coach2', 'Co-defensive coordinator'),
                 ('assoc_coach', 'Associate head coach')]


def parse_staff_tables(text):
    out = []
    for section in section_bodies(text, STAFF_HEADING):
        for cells in table_rows(section):
            if len(cells) < 2:
                continue
            name, pos = clean_name(cells[0]), cells[1]
            if plausible_name(name) and classify(pos):
                out.append((name, pos))
    return out


def parse_roster_footer(text):
    out = []
    body, _ = find_template(text, 'American football roster/Footer')
    if not body:
        return out
    params = split_params(body)
    for key, default_role in (('head_coach', 'Head coach'), ('asst_coach', None),
                              ('coord_coach', None)):
        for line in (params.get(key) or '').split('\n'):
            line = line.strip()
            if not line.startswith('*'):
                continue
            # A <br> inside a bullet separates name from title.
            line = re.sub(r'<br\s*/?>', ' – ', line.lstrip('*').strip(), flags=re.I)
            parts = DASH_SPLIT_RE.split(strip_noise(line), maxsplit=1)
            name = clean_name(parts[0])
            pos = parts[1] if len(parts) > 1 and parts[1].strip() else default_role
            if pos and plausible_name(name) and classify(pos):
                out.append((name, pos))
    return out


# -------------------------------------------------------------------- schedule

MONTHS = {m: i + 1 for i, m in enumerate(
    ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
     'september', 'october', 'november', 'december'])}


def parse_date(raw, season):
    # {{dow tooltip|October 23|Friday}} keeps the date in its FIRST argument, so
    # scan the raw text with markup treated as separators instead of unlink()ing.
    s = re.sub(r'[\[\]{}|]', ' ', strip_noise(raw))
    m = re.search(r'\b([A-Za-z]+)\s+(\d{1,2})\b', s)
    if not m:
        return None
    mon = MONTHS.get(m.group(1).lower())
    if not mon:
        return None
    year = season + 1 if mon <= 2 else season
    return f'{year}-{mon:02d}-{int(m.group(2)):02d}'


def week0_saturday(season):
    """The Saturday of Week 0: the last Saturday of August."""
    d = date(season, 8, 31)
    while d.weekday() != 5:
        d -= timedelta(days=1)
    return d


def normalize_key(s):
    s = unicodedata.normalize('NFKD', s or '')
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace('–', '-').replace('—', '-').replace('’', "'")
    return re.sub(r'[^a-z0-9]', '', re.sub(r'\(fcs\)|\bfcs\b', '', s))


CONF_ALIASES = {'CUSA': 'C-USA', 'Conference USA': 'C-USA', 'MWC': 'MW',
                'Mountain West Conference': 'MW', 'Mid-American Conference': 'MAC',
                'Sun Belt Conference': 'Sun Belt', 'American Conference': 'American',
                'Southeastern Conference': 'SEC', 'Big Ten Conference': 'Big Ten',
                'Atlantic Coast Conference': 'ACC', 'Big 12 Conference': 'Big 12',
                'Pac-12 Conference': 'Pac-12'}
SCHOOL_ALIASES = {'ulm': 'Louisiana-Monroe', 'ulmonroe': 'Louisiana-Monroe',
                  'southernmiss': 'Southern Mississippi', 'umass': 'Massachusetts',
                  'pitt': 'Pittsburgh', 'appstate': 'Appalachian State',
                  'miamifl': 'Miami (FL)', 'miamioh': 'Miami (OH)'}


# ------------------------------------------------------------------- fetching

def api_query(params):
    url = API + '?' + urllib.parse.urlencode(params)
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))


def fetch_raw(title):
    url = 'https://en.wikipedia.org/w/index.php?' + urllib.parse.urlencode(
        {'title': title, 'action': 'raw'})
    return urllib.request.urlopen(
        urllib.request.Request(url, headers=UA), timeout=60).read().decode('utf-8')


def page_titles():
    """school -> "<Nickname> football team" title, from the recorded source URLs."""
    records = json.load(open(os.path.join(SRC, 'school_records_frontend.json')))
    titles = {}
    for team in records['teams'].values():
        for year in sorted(team['years'], reverse=True):
            url = team['years'][year].get('source_url')
            if url:
                slug = url.rsplit('/', 1)[-1]
                titles[team['teamName']] = urllib.parse.unquote(slug.split('_', 1)[1])
                break
    return titles


def cache_path(season, kind, school):
    folder = os.path.join(CACHE, str(season))
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, f'{kind}-{school.replace("/", "_")}.wiki')


def download(season, titles, offline):
    """school -> (kind, wikitext) where kind is 'season' or 'program'."""
    pages = {}
    todo = []
    for school in sorted(titles):
        for kind in ('season', 'program'):
            path = cache_path(season, kind, school)
            if os.path.exists(path):
                pages[school] = (kind, open(path).read())
                break
        else:
            todo.append(school)

    if not todo:
        return pages
    if offline:
        print(f'  {len(todo)} schools missing from the cache; --offline leaves them out')
        return pages

    season_titles = {s: f'{season} {titles[s]}'.replace('_', ' ') for s in todo}
    items = sorted(season_titles.items())
    for i in range(0, len(items), 10):
        batch = items[i:i + 10]
        res = api_query({'action': 'query', 'format': 'json', 'formatversion': 2,
                         'prop': 'revisions', 'rvprop': 'content', 'rvslots': 'main',
                         'redirects': 1, 'titles': '|'.join(t for _, t in batch)})
        renamed = {}
        for entry in res['query'].get('normalized', []) + res['query'].get('redirects', []):
            renamed[entry['from']] = entry['to']
        by_title = {}
        for page in res['query']['pages']:
            if page.get('revisions'):
                by_title[page['title']] = page['revisions'][0]['slots']['main']['content']
        for school, title in batch:
            resolved = renamed.get(title, title)
            text = by_title.get(renamed.get(resolved, resolved))
            if text is None:
                continue
            open(cache_path(season, 'season', school), 'w').write(text)
            pages[school] = ('season', text)
        print(f'  season pages {min(i + 10, len(items))}/{len(items)}')
        time.sleep(0.4)

    # No season page yet (common for smaller programs before kickoff): take the
    # current head coach off the program page instead.
    for school in todo:
        if school in pages:
            continue
        title = titles[school].replace('_football_team', '_football')
        try:
            text = fetch_raw(title)
            if text.lstrip().upper().startswith('#REDIRECT'):
                target = link_target(text)
                text = fetch_raw(target.replace(' ', '_')) if target else text
        except Exception as err:                                  # noqa: BLE001
            print(f'  !! {school}: {err}')
            continue
        open(cache_path(season, 'program', school), 'w').write(text)
        pages[school] = ('program', text)
    return pages


# -------------------------------------------------------------------- staffing

def staff_from_season_page(text):
    infobox, _ = find_template(text, 'Infobox college sports team season')
    ib = split_params(infobox) if infobox else {}

    rows = []
    for key, pos in INFOBOX_ROLES:
        for piece in re.split(r'<br\s*/?>|\n\*', ib.get(key) or ''):
            name = clean_name(piece)
            if plausible_name(name):
                rows.append((name, pos))
    rows += parse_staff_tables(text)
    rows += parse_roster_footer(text)

    priority = {'hc': 0, 'oc': 1, 'dc': 1, 'other': 2}
    best = {}
    for name, pos in rows:
        role = classify(pos)
        if role and (name not in best or priority[role] < priority[best[name]]):
            best[name] = role

    roster = defaultdict(list)
    for name, role in best.items():
        roster[role].append(name)
    meta = {'conference': unlink(ib.get('short_conf') or ib.get('conference') or '') or None,
            'stadium': unlink(ib.get('stadium', '')) or None}
    return {role: sorted(names) for role, names in roster.items()}, meta


def staff_from_program_page(text):
    hc = re.search(r'^\| *(?:HeadCoach|head_coach|Coach) *= *(.*)$', text, re.M | re.I)
    conf = re.search(r'^\| *Conference *= *(.*)$', text, re.M | re.I)
    roster = {}
    if hc:
        name = clean_name(hc.group(1))
        if plausible_name(name):
            roster['hc'] = [name]
    meta = {'conference': unlink(conf.group(1)) if conf else None, 'stadium': None}
    return roster, meta


def canonical_names(data):
    """Name lookups so a refresh reuses the spelling already in the dataset."""
    def norm(name):
        s = unicodedata.normalize('NFKD', name)
        s = ''.join(c for c in s if not unicodedata.combining(c))
        return re.sub(r'\s+', ' ', re.sub(r'[.,]', '', s.lower().replace('’', "'"))).strip()

    def initkey(name):
        out, run = [], ''
        for token in norm(name).split(' '):
            if len(token) == 1:
                run += token
            else:
                if run:
                    out.append(run)
                    run = ''
                out.append(token)
        if run:
            out.append(run)
        return ' '.join(out)

    exact, initials = defaultdict(set), defaultdict(set)
    for seasons in data.values():
        for roster in seasons.values():
            for value in roster.values():
                for coach in (value if isinstance(value, list) else [value]):
                    if coach:
                        coach = re.sub(r'\s+', ' ', coach.strip())
                        exact[norm(coach)].add(coach)
                        initials[initkey(coach)].add(coach)

    def canonical(name):
        for table, key in ((exact, norm(name)), (initials, initkey(name))):
            hits = table.get(key)
            if hits:
                return sorted(hits, key=lambda c: (c != name, -len(c)))[0]
        return name

    return canonical


# ------------------------------------------------------------------ schedules

def parse_schedule(text, school, season, titles):
    body, _ = find_template(text, 'CFB schedule')
    if not body:
        return []
    title_to_school = {t.replace('_', ' '): s for s, t in titles.items()}
    games = []
    for m in re.finditer(r'\{\{\s*CFB schedule entry', body):
        entry, _ = find_template(body, 'CFB schedule entry', m.start())
        if not entry:
            continue
        p = split_params(entry)
        if not p.get('opponent', '').strip():
            continue

        target = link_target(p['opponent'])
        display = re.sub(r'^(?:No\.\s*\d+\s*)', '', unlink(p['opponent']).strip('* ')).strip()
        opponent = None
        if target:
            t = re.sub(r'^\d{4}\s+', '', re.sub(r'\s+', ' ', target.replace('_', ' ')).strip())
            if t in title_to_school:
                opponent = title_to_school[t]
            else:
                program = re.sub(r' football( team)?$', '', t)
                for title, name in title_to_school.items():
                    if re.sub(r' football team$', '', title) == program:
                        opponent = name
                        break

        yes = lambda key: p.get(key, '').strip().lower() in ('y', 'yes', 'true')
        games.append({
            'source': school,
            'opponent': opponent,
            'opponentDisplay': display,
            'date': parse_date(p.get('date', ''), season),
            'time': unlink(p.get('time', '')) or None,
            'away': yes('away'),
            'neutral': yes('neutral'),
            'nonConference': yes('nonconf'),
            'stadium': unlink(p.get('site_stadium') or p.get('stadium') or '') or None,
            'city': unlink(p.get('site_cityst') or p.get('cityst') or '') or None,
            'tv': unlink(p.get('tv', '')) or None,
            'gameName': unlink(p.get('gamename', '')) or None,
        })
    return games


def merge_games(raw, schools, season, meta):
    """One row per matchup, merging the two teams' versions of it."""
    # Display names that resolved via wikilink teach us the aliases; some pages
    # have typo'd link targets ("Thundering Heard") or an en-dash.
    learned = {}
    for game in raw:
        if game['opponent']:
            learned.setdefault(normalize_key(game['opponentDisplay']), game['opponent'])
    by_key = {normalize_key(s): s for s in schools}
    for game in raw:
        if game['opponent']:
            continue
        key = normalize_key(game['opponentDisplay'])
        game['opponent'] = by_key.get(key) or learned.get(key) or SCHOOL_ALIASES.get(key)

    def sides(game):
        if game['neutral']:
            return None, None
        other = game['opponent'] or game['opponentDisplay']
        return (other, game['source']) if game['away'] else (game['source'], other)

    groups = defaultdict(list)
    for game in raw:
        other = game['opponent'] or ('~' + game['opponentDisplay'])
        groups[tuple(sorted((game['source'], other)))].append(game)

    games, conflicts = [], []
    for pair, entries in sorted(groups.items()):
        dates = [e['date'] for e in entries if e['date']]
        if len(set(dates)) > 1:
            conflicts.append(('date', pair, sorted(set(dates))))
        neutral = any(e['neutral'] for e in entries)

        home = away = None
        if not neutral:
            votes = defaultdict(int)
            for entry in entries:
                h, a = sides(entry)
                if h:
                    votes[(h, a)] += 1
            if votes:
                top = max(votes.values())
                winners = [k for k, v in votes.items() if v == top]
                if len(winners) > 1:
                    conflicts.append(('home', pair, winners))
                    # Both pages claim the game: believe whichever team's own
                    # stadium is listed as the site.
                    listed = {e['stadium'] for e in entries if e['stadium']}
                    for candidate, other in sorted(winners):
                        own = (meta.get(candidate) or {}).get('stadium')
                        if own and any(own in site or site in own for site in listed):
                            winners = [(candidate, other)]
                            conflicts[-1] = ('home resolved by stadium', pair, candidate)
                            break
                home, away = sorted(winners)[0]
        if neutral or not home:
            # A neutral site has no host; list the tracked school first.
            home, away = sorted(pair, key=lambda s: (s.startswith('~'), s))

        def clean(name):
            # Some pages fold the division into the name ("(FCS) Stony Brook").
            label = re.sub(r'\(FCS\)', '', name.lstrip('~'), flags=re.I)
            return re.sub(r'\s+', ' ', label).strip(' -')

        def best(field):
            return next((e[field] for e in entries if e.get(field)), None)

        def best_game_name():
            # Rivalry links pipe as "[[X-Y football rivalry|rivalry]]", so one page
            # can offer a bare "rivalry" while the other names the trophy game.
            names = [e['gameName'] for e in entries if e.get('gameName')]
            specific = [n for n in names if n.strip().lower() != 'rivalry']
            chosen = specific[0] if specific else (names[0] if names else '')
            return re.sub(r'^rivalry\b', 'Rivalry', chosen) or None

        home_name, away_name = clean(home), clean(away)
        games.append({
            'date': min(dates) if dates else None,
            'home': home_name,
            'away': away_name,
            'homeTracked': home_name in schools,
            'awayTracked': away_name in schools,
            'neutralSite': neutral,
            'conferenceGame': not any(e['nonConference'] for e in entries),
            'kickoff': best('time'),
            'stadium': best('stadium'),
            'city': best('city'),
            'tv': best('tv'),
            'name': best_game_name(),
        })

    week0 = week0_saturday(season)
    for game in games:
        if not game['date']:
            game['week'] = None
            continue
        d = date.fromisoformat(game['date'])
        saturday = d - timedelta(days=1) if d.weekday() == 6 else d + timedelta(days=5 - d.weekday())
        game['week'] = (saturday - week0).days // 7

    games.sort(key=lambda g: (g['week'] if g['week'] is not None else 99,
                              g['date'] or '9999', g['home']))
    for game in games:
        slug = re.sub(r'[^a-z0-9]+', '-', f"{game['away']}-at-{game['home']}".lower()).strip('-')
        game['id'] = f"{game['date'] or 'tbd'}-{slug}"
    return games, conflicts


# ----------------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('season', type=int)
    parser.add_argument('--offline', action='store_true',
                        help='rebuild from scripts/.wiki-cache without hitting Wikipedia')
    args = parser.parse_args()
    season = args.season

    data_path = os.path.join(SRC, 'data.json')
    data = json.load(open(data_path))
    titles = page_titles()
    missing = sorted(set(data) - set(titles))
    if missing:
        print(f'!! no page title for: {missing}')

    print(f'{season}: collecting {len(titles)} schools'
          + (' from cache' if args.offline else ' from Wikipedia'))
    pages = download(season, titles, args.offline)
    print(f'  pages available: {len(pages)}')

    canonical = canonical_names(data)
    staffs, meta, raw_games = {}, {}, []
    for school, (kind, text) in sorted(pages.items()):
        if kind == 'season':
            roster, school_meta = staff_from_season_page(text)
            raw_games += parse_schedule(text, school, season, titles)
        else:
            roster, school_meta = staff_from_program_page(text)
        meta[school] = school_meta

        entry = {}
        for role in ('hc', 'oc', 'dc', 'other'):
            names = []
            for name in roster.get(role, []):
                fixed = canonical(name)
                if fixed not in names:
                    names.append(fixed)
            if names:
                entry[role] = names if (role == 'other' or len(names) > 1) else names[0]
        if entry:
            staffs[school] = entry

    for role in ('hc', 'oc', 'dc'):
        absent = sorted(s for s in staffs if role not in staffs[s])
        print(f'  no {role}: {len(absent)}' + (f' {absent}' if absent and role == 'hc' else ''))

    for school, entry in staffs.items():
        data[school][str(season)] = entry
    ordered = {s: {y: seasons[y] for y in sorted(seasons, key=int)}
               for s, seasons in data.items()}
    with open(data_path, 'w') as f:
        json.dump(ordered, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'  wrote {len(staffs)} staffs into src/data.json')

    games, conflicts = merge_games(raw_games, set(data), season, meta)
    for conflict in conflicts:
        print(f'  ?? {conflict[0]} disagreement between the two pages: {conflict[1]}')

    conferences = {}
    for school in data:
        conf = (meta.get(school) or {}).get('conference')
        if conf:
            conferences[school] = CONF_ALIASES.get(conf, conf)
    out_path = os.path.join(SRC, f'schedule_{season}.json')
    with open(out_path, 'w') as f:
        json.dump({'season': season, 'week0Saturday': week0_saturday(season).isoformat(),
                   'conferences': dict(sorted(conferences.items())), 'games': games},
                  f, indent=1, ensure_ascii=False)
        f.write('\n')
    tracked = sum(1 for g in games if g['homeTracked'] and g['awayTracked'])
    print(f'  wrote {len(games)} games ({tracked} between tracked schools) '
          f'into src/schedule_{season}.json')
    print('\nNow run: npm run generate:schedule-lineage')
    return 0


if __name__ == '__main__':
    sys.exit(main())
