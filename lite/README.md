# FIRST COACH / БІРІНШІ БАПКЕР — Genesis v0.1 (lite)

Every child deserves a great first coach.
A free, open football school: 60 drills from the Open Sport Commons, each with an animation,
steps, timer, common mistakes and safety notes; a personal 4-week roadmap; skill tests with
before/after comparison; a skill tree; a contribution form and a moderation queue.
Kazakh, Russian and English.

Created by KOZ AI. Opened to everyone on the 60th birthday of Kairat Boranbayev.

## What is inside

- **No build step, no backend, no dependencies.** Plain HTML/CSS/JS, ~1 MB total (~150 KB gzipped).
- **PWA**: installable, opens offline after the first visit (`sw.js`).
- **Content**: `js/data.js` and `commons.json` are generated from the main repo's
  `config/commons/football` (skill graph, 60 drills, 5 tests, rubrics) with `build_data.py`.
- **Animations**: `js/anim.js` draws every drill as SVG (side view, feet close-up, pitch diagram).
  No video files, no third-party footage — nothing to license, fast on a cheap Android phone.
- **Privacy**: progress, test results and contributions live in the browser (`localStorage`).
  Video self-check never uploads the video.

## Run locally

```bash
cd lite
python3 -m http.server 8080
```

Open http://localhost:8080

## Deploy

Any static hosting works (Railway, Vercel, Netlify, GitHub Pages, nginx).

**Production (Railway, current setup)**: the root `Dockerfile` copies `lite/` into the image and
sets `WEB_DIST=/app/lite`, so the existing Hono server serves this app at `/` while `/api`, `/health`
and the `/data` volume stay as they were. Delete those two lines to serve `apps/web/dist` again.

**Separate service**: `lite/Dockerfile` (nginx, listens on `$PORT`) also runs on its own,
for example as a second Railway service with Root Directory `lite`.

**Vercel**: `vercel deploy --prod` from this folder. **Netlify**: drag the folder into app.netlify.com/drop.

When you change files, bump `?v=` in `index.html` and `CACHE` in `sw.js` so phones pick up the new version.

## Refresh the content from the Open Sport Commons

From the repo root, after editing `config/commons/football`:

```bash
python3 lite/build_data.py
```

## Honest limits of v0.1

- All 60 drills are **FIRST COACH Community Drafts** until a real coach reviews them.
- Contributions and moderation are stored on the device where they were made (no server yet).
  The next step is to connect them to the API of the main `first-coach` repo.
- The video check is a coach's checklist the child or parent fills in; automatic AI analysis is the next stage.
- Kazakh interface copy needs a native-speaker review.

## Licences

Software: MIT. Open Sport Commons content: CC BY-SA 4.0.
