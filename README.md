# Corridor

Turns commercial real estate listing photos into cinematic video tours, then hosts
them behind a QR code on the listing sign so drive-by interest becomes a trackable lead.

A second workflow, **Visualize**, generates concept imagery so a broker can answer
"could this work for us?" with a picture: a building not yet built, an existing
building repositioned, a tenant fit-out, or an alternate layout.

The video is the demo. **The product is the hosted tour + QR + attribution** — a
prospect who reads a sign and drives off is invisible to every other tool in CRE.

---

## Quick start

```bash
npm install
npm run doctor     # preflight: spends nothing, calls nothing
npm start          # http://localhost:4182  (landing page; studio at /studio)
```

Preview-quality rendering, publishing, QR sign kit, lead capture and analytics all
work with **no API keys at all**. Keys are only needed for cinematic generation.

## Configuration

Copy `.env.example` to `.env`. Nothing is required to run.

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | Origin used for share links **and** for the image URLs handed to Higgsfield. Must be publicly reachable for cinematic renders. |
| `HIGGSFIELD_KEY_ID` / `HIGGSFIELD_KEY_SECRET` | Cinematic generation. Auth header is `Key ID:SECRET` — **not** Bearer. |
| `CREDIT_BUDGET` | Hard monthly ceiling. Generation returns `402` before spending past it. |
| `SESSION_SECRET` | Session signing. Auto-generates into `db.json` with a warning if unset — set it before deploying. |
| `ANTHROPIC_API_KEY` | Optional. Spec extraction from free text; degrades to a heuristic parse without it. |

## Before hosting

```bash
npm test                                     # 58 checks, spends nothing
npm run doctor                               # config preflight
node scripts/verify-higgsfield.js --confirm  # proves REST auth (~5 credits)
curl localhost:4182/healthz                  # uptime, pending jobs, disk, RSS
```

`npm test` runs against a throwaway data dir on a spare port and never touches
your live `db.json`.

### Verifying the Higgsfield path

```bash
node scripts/verify-higgsfield.js            # dry run, spends nothing
node scripts/verify-higgsfield.js --confirm  # real call, ~5 credits
```

---

## How it works

```
photos → spec → storyboard → takes → select → reel → publish → QR → leads
```

1. **Upload** — space type inferred from the filename, editable.
2. **Spec** (`POST /listings/:id/specs`) — free text → structured spec. One Claude
   call, or a heuristic parse without a key.
3. **Plan** (`POST /listings/:id/plan`) — costs the entire job. Cannot spend money.
4. **Generate** (`POST /{listings,projects}/:id/generate`) — behind the rate limiter
   and credit gate.
5. **Select** — several takes per shot; pick the best.
6. **Reel** — montage → burned-in captions → end card.
7. **Publish** — public tour at `/t/:slug`, print-ready sign assets, lead capture.

### Visualize (second workflow)

Four modes, each with a permanent disclosure label: **concept** (no building yet),
**renovation**, **fit-out**, **layout**. Images cost 1 credit (`nano_banana`) or 7
(`gpt_image_2`), so exploring options is cheap. Architecture is preserved in every
mode except concept — walls, windows, columns and ceiling height never move.

Corridor is not a CRM. There are no pipelines, deal stages, task boards or contact
management, and none should be added — lead capture exists only to attribute a QR
scan to a tour.

### Two render tiers

**Preview** is local ffmpeg Ken Burns whose direction of travel matches the
Higgsfield move it stands in for. Free, instant, and it lets a broker block out an
entire tour before spending a credit. **Cinematic** goes to Higgsfield.

---

## Things learned the expensive way

- **Higgsfield "presets" are not camera moves.** That catalogue is consumer character
  effects (ZOMBIE DANCE, EARTH ZOOM). There is no `dolly_in` preset. Camera direction
  lives in the prompt. The preset router will also *hijack* a submit and return a
  recommendation instead of generating — pass `declined_preset_id` to clear it.
- **~40% of shots come back defective** on the first take (invented signage, inverted
  camera moves). One take yields a clean five-shot tour ~8% of the time; three takes
  ~73%. Redundancy beats better prompting — a take costs about $0.20.
- **Output is 24 fps.** Normalising a cut to 30 duplicates every fourth frame and reads
  as camera shake on slow dollies. The pipeline is 24 fps end to end.
- **Always stabilise.** Motion invented from a single still makes straight lines swim;
  suspended ceiling grids are the worst case, and offices are full of them.
- **Generic negative prompts are ignored.** "no text overlays" still produced invented
  facade signage. Specific and prominent works.
- **The start frame decides what motion is possible.** A pull-back only works from a
  tight crop — the camera needs somewhere to retreat to.
- **Model cost** (preflighted, 5s, no audio): `cinematic_studio_video_v2` 5.0 credits ·
  `kling3_0` 7.5 · `seedance_2_0` 17.5.

## Architecture notes

- **MCP is client-side only.** The server must use the Higgsfield REST API. An MCP
  connection is not available to a deployed process.
- **JSON store, single process.** Deliberate for a pilot. Stop the server before
  editing `db.json` — a running process will flush stale state over your changes.
- Auth stays open until the first account exists, then scopes everything to it. The
  public tour API is mounted **above** the gate — a prospect scanning a sign must
  never meet a login screen.
- No password reset, email verification or recovery. Fine while you know every user
  by name; not fine when strangers can sign up.

## Layout

```
server/
  agents/       spec / tour / envision planners — return plans, never call out
  routes/       api, public tour, auth  (chat.sketch.js is NOT mounted)
  higgsfield.js REST client
  jobs.js       take orchestration, polling, stabilisation
  limits.js     credit gate + rate limiting
  endcard.js    end cards, captions, text overlays
  signkit.js    QR + print-ready sign assets
public/         index.html   marketing homepage + entry point
                studio.html  the studio app (/studio)
                tour.html    public tour player (/t/:slug)
scripts/        doctor, verify-higgsfield
```
