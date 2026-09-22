# Первый тренер / Бірінші бапкер / First Coach — lite

A free, open football school: 60 drills from the Open Sport Commons, each with an animation,
steps, timer, common mistakes and safety notes; a personal 4-week roadmap; skill tests with
before/after comparison; a skill tree; a contribution form and a moderation queue.
Kazakh, Russian and English.

Created by KOZ AI.

## What is inside

- **No build step, no backend, no dependencies.** Plain HTML/CSS/JS, ~1 MB total (~150 KB gzipped).
- **PWA**: installable, opens offline after the first visit (`sw.js`).
- **Content**: `js/data.js` and `commons.json` are generated from the main repo's
  `config/commons/football` (skill graph, 60 drills, 5 tests, rubrics) with `build_data.py`.
- **Animations**: `js/anim.js` draws every drill as SVG (side view, feet close-up, pitch diagram).
  No video files, no third-party footage — nothing to license, fast on a cheap Android phone.
- **Players**: a light sign-in with local profiles (name or nickname, avatar, colour, optional 4-digit PIN).
  Several children can share one phone or a school tablet; each has their own plan and progress.
  No email or password is asked of a child. A forgotten PIN is reset behind a grown-up maths question.
- **Privacy**: profiles, progress, test results and contributions live in the browser (`localStorage`).
  The PIN keeps siblings out; it is not account security. Video self-check never uploads the video.

## Run locally

```bash
cd lite
python3 -m http.server 8080
```

Open http://localhost:8080

## Deploy

Any static hosting works (Railway, Vercel, Netlify, GitHub Pages, nginx).

**Railway**: add a new service from this repo, set **Root Directory** to `lite`.
The `lite/Dockerfile` (nginx, listens on `$PORT`) is picked up automatically. The main app's
Dockerfile only copies `apps/`, `config/` and `scripts/`, so this folder does not affect it.

**Vercel**: `vercel deploy --prod` from this folder. **Netlify**: drag the folder into app.netlify.com/drop.

When you change files, bump `?v=` in `index.html` and `CACHE` in `sw.js` so phones pick up the new version.

## Refresh the content from the Open Sport Commons

From the repo root, after editing `config/commons/football`:

```bash
python3 lite/build_data.py
```

## Where coaches' drills go

Set `CONTACT_EMAIL` at the top of `js/app.js`. After a coach fills in the form, the app offers
"Send by email" with the drill already written into the message. Without an address it offers
Share (on phones) and Copy.

## Honest limits of v0.1

- All 60 drills are **FIRST COACH Community Drafts** until a real coach reviews them.
- Contributions reach the team by email (see above); the moderation screen (`#/admin`) only sees
  drills added on the same device. The next step is to connect it to the API of the main repo.
- The video check is a coach's checklist the child or parent fills in; automatic AI analysis is the next stage.
- Kazakh interface copy needs a native-speaker review.

## Licences

Software: MIT. Open Sport Commons content: CC BY-SA 4.0.
