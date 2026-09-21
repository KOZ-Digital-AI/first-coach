# FIRST COACH / БІРІНШІ БАПКЕР

## Mission

Every child deserves a great first coach. FIRST COACH was created by KOZ AI and
opened to everyone on the 60th birthday of Kairat Boranbayev. It is a free,
open-source PWA for self-directed football skill training: a child (or a
parent, or a volunteer coach) picks a skill, follows a short drill, and sees
progress, with no paid coach and no subscription required.

> The product is still being built. Commands and endpoints below describe the
> planned setup and may change until the first release.

## Two open parts

FIRST COACH is open in two separate ways, with two licences.

- **FIRST COACH software** (the PWA, the API and the tooling) is licensed
  under the MIT licence. See [LICENSE](LICENSE).
- **Open Sport Commons** is the open, versioned knowledge base of skills and
  drills that the software teaches from. It is licensed under CC BY-SA 4.0.
  See [CONTENT-LICENSE.md](CONTENT-LICENSE.md).

## Run locally

Requirements: [Bun](https://bun.sh) 1.4 or newer.

```bash
bun install
cp .env.example .env
bun run dev
```

The API listens on port 4111 and serves everything under `/api`. The web dev
server proxies `/api` requests to it, so you only open the web dev server in
your browser.

An OpenAI key in `.env` is optional. The product works with the LLM off; the
key only enables extra AI-assisted features.

## Use the commons in another app

The commons is published as data you can reuse in your own app:

- `GET /api/commons/export.json` returns the full commons export.
- `GET /api/commons/schema.json` returns the JSON Schema that the export is
  validated against.

Fetch the export, validate it against the schema, and build on it. Carry the
attribution line from [CONTENT-LICENSE.md](CONTENT-LICENSE.md) in your app, and
share your adaptations of the content under CC BY-SA 4.0 as well.

## Contribute without GitHub

You do not need GitHub or any developer skills to contribute a method.

1. Sign in on the site.
2. Open the CONTRIBUTE A METHOD form and describe your drill or method.
3. Add a video.
4. Confirm that you own the rights to what you are submitting.
5. Submit. A reviewer approves it before it appears in the commons.

Your authorship is preserved: your name stays attached to your contribution.

## Honesty rule for AI-drafted content

The founding drills were drafted with AI. They are labelled
"FIRST COACH Community Draft" and carry the status COMMUNITY until real coaches
have reviewed them. Status badges are never hidden, so a learner can always
tell what has been reviewed by coaches and what has not.

## No copying commercial material

Do not submit or copy FIFA, UEFA or other commercial or copyrighted material.
Contribute only what you have the right to share under CC BY-SA 4.0: your own
methods, your own videos, and your own words.

## Licences

Software: MIT, see [LICENSE](LICENSE). Content: CC BY-SA 4.0, see
[CONTENT-LICENSE.md](CONTENT-LICENSE.md).
