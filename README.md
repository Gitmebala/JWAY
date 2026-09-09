# JWAY — JKUAT campus wayfinder

Walking directions across the JKUAT Juja campus, down to the building you're
actually looking for. Built because finding your way to class as a first-year
is genuinely hard and no existing map routes across the campus footpaths.

**Live:** _(deploy URL goes here)_

## What it does

- **Search places the way people say them** — `student library`, `mess`, `hall 7`,
  `flamingo`, `gate b`, `pool`, or a room code like `ELB 212`.
- **Real shortest-path routing** over the campus footpath network (Dijkstra,
  with start and end points projected onto the nearest path edge rather than
  snapped to the nearest junction).
- **Spoken turn-by-turn** — announces at 150 m, 40 m and at the turn, with
  haptic taps, so the phone can stay in your pocket. Toggleable.
- **Voice destination** — "take me to ELB 212".
- **Compass heading**, so it can tell you you're facing the wrong way before you
  walk off in it.
- **Directions with landmarks and streets** — "Turn right onto Science Street at
  NSC Cafeteria, passing JKUAT Library on your left".
- **Nearest of a kind** — one tap for the closest mess, cafeteria, hostel, gym,
  gate, shop or hospital, ranked by walking distance rather than straight line.
- **Holds the screen awake** while navigating, so it does not die in your pocket.
- **Shareable links** — `?to=CTC%20207` opens straight into a route, so a link in
  a group chat lands someone on the directions.
- Recent destinations, satellite and street basemaps, decluttered labels.

## Running it locally

Any static file server works — there is no build step.

```bash
python -m http.server 5178
```

Then open <http://localhost:5178>.

Geolocation, the compass and speech synthesis require a secure context, so they
work on `localhost` and over HTTPS, but not over plain `http://` to another host.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Markup and dialogs |
| `app.css` | All styling, light and dark |
| `app.js` | Routing, search, map, navigation, speech |
| `data/campus.js` | The campus dataset (buildings, POIs, path graph, streets, rooms) |

## Where the data comes from

Everything is openly licensed. No proprietary map data is embedded.

- **Buildings, footpaths, street names and POIs** — [OpenStreetMap](https://www.openstreetmap.org/)
  contributors, via the Overpass API. Licensed [ODbL](https://opendatacommons.org/licenses/odbl/).
- **Additional building footprints** — a public JKUAT ArcGIS survey layer, used to
  fill gaps OSM did not cover. The two agreed to within 4–16 m, which is how they
  were cross-validated.
- **Room codes** — venue codes appearing on JKUAT's own published exam timetables.
- **Basemap tiles** — Esri World Imagery (satellite) and OpenStreetMap (street).

Attribution is displayed on the map, as ODbL requires. Keep it there.

### Room codes

Codes in the main teaching blocks encode their own floor: a three-digit code
starts with the floor it is on (`CTC 207` -> 2nd floor, `CTC 105` -> 1st), and a
shorter code is ground level (`CTC 03`). JWAY applies that rule live, so a room
nobody has ever recorded still resolves — `CTC 312` routes to the right building
and tells you the 3rd floor, flagged as inferred.

`CTC` is the COHRED block beside the HRD building. Its footprints are unnamed in
OpenStreetMap, so its location came from local knowledge rather than a public
dataset — [adding it to OSM](https://www.openstreetmap.org/) would make that
permanent for everyone. The `PAM` labs are in the New Science Complex, which
houses the College of Pure and Applied Sciences.

## Contributing campus data

The best place to fix or add a building is **OpenStreetMap**, not this repo —
edits there flow to everyone. Regenerate `data/campus.js` from fresh Overpass
pulls after upstream changes.
