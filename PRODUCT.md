# Product

<!-- impeccable:product-schema 1 -->

<!--
Provenance: authored non-interactively (no question mechanism was available to the generator). Facts stated in the
task brief and README.md are recorded as given. Anything marked "(derived)" is inferred from root design sections 1
and 3 and from first-coach-demo.html, was not confirmed by a human, and should be reviewed.
-->

## Platform

web

## Users

- **Children, from about age 6 (primary).** They train on their own or with a friend or parent: pick a skill, follow a short drill, see their own progress. Most use cheap Android phones with a 360px-wide screen, sometimes on slow or patchy connections, and read in Қазақша, Русский or English. They cannot be assumed to read long text or tolerate friction.
- **Volunteer and community coaches.** They have no budget and often no formal coaching qualification. They use FIRST COACH to run a first session with a group of children, choose drills and follow what each child is working on.
- **Parents (secondary, derived).** They help a younger child start and may act as the coach at home.

The job: help a child get better at a football skill in a small, honest step today, and help a coach give that child a great first coach experience without paying for one.

## Product Purpose

FIRST COACH / БІРІНШІ БАПКЕР is a free, open-source PWA for self-directed football skill training. It exists because every child deserves a great first coach. It was created by KOZ AI and opened to everyone on the 60th birthday of Kairat Boranbayev. A child (or a parent, or a volunteer coach) picks a skill, follows a short drill and sees progress, with no paid coach and no subscription required.

Success is a child who trains again tomorrow because the last session felt good and honest, and a volunteer coach who can run a session with confidence on a phone.

## Positioning

An honest, non-commercial first coach: free and open, in Kazakh, Russian and English, that measures a child only against themselves. Its drills come from Open Sport Commons, an open, versioned knowledge base of skills and drills under CC BY-SA 4.0, with the software under the MIT licence. A commercial sports app monetising attention with rewards and rankings cannot truthfully copy that.

## Operating Context

- Phones first: cheap Android devices, 360px width, mobile data, sometimes offline; installed as a PWA.
- Sessions happen on the pitch or at home: short, outdoors or in a small space, often with one hand on the phone.
- Three interface languages (kk, ru, en); every screen must work in all three.
- Volunteer coaches run group sessions with little preparation time.
- The LLM is optional: the product works with it off, and it only enables extra AI-assisted features (per README.md).

## Capabilities and Constraints

- Pick a skill, follow a short drill, see progress over time (README.md).
- Open Sport Commons is exported as data (`/api/commons/export.json`) and can be reused by other apps with attribution.
- Light theme only.
- Undecided (do not invent): video features, accounts and sync details, any coach-to-child messaging.

## Brand Commitments

**Brand personality (derived from root design section 1/3 and the prototype):** calm, respectful, warm and honest. It speaks like a patient older sibling or a good volunteer coach: plain words, small steps, progress against yourself. It never tells a child they will become a professional, never scolds and never hypes.

**Anti-references (do not resemble these):**

- Casino gamification: points economies, streak pressure, loot boxes, slot-machine rewards.
- Leaderboards and rankings of children against each other.
- Confetti storms and celebratory pop-ups.
- Social feeds and follower mechanics.
- Ad-tech, tracking and attention-harvesting patterns.
- Generic sports-app energy: neon, aggressive italics, stadium hype.

**Fixed commitments:** the name FIRST COACH / БІРІНШІ БАПКЕР; free and open source; the mission "Every child deserves a great first coach."; light theme only; the dedication to Kairat Boranbayev on his 60th birthday, credited to KOZ AI.

## Evidence on Hand

- `README.md`: mission, the two open parts (MIT software, CC BY-SA 4.0 commons), run instructions.
- `first-coach-demo.html`: the clickable prototype that is the source of the visual tokens now recorded in DESIGN.md.
- `LICENSE` and `CONTENT-LICENSE.md`: the two licences.
- No testimonials, user numbers, press, case studies or benchmarks exist. Do not fabricate them.

## Product Principles

1. **Progress against yourself.** Show a child how they have improved compared with their own earlier attempts; never compare children with each other.
2. **Small, honest steps.** One short drill, one clear next action. Encourage effort and improvement without promising a professional career.
3. **Built for the cheap phone.** If it is not usable at 360px, on slow data and with a thumb, it is not finished.
4. **Kazakh, Russian and English are equals.** No language is a translation afterthought; every string and layout works in all three.
5. **Open and free, always.** No paywall, no ads, no tracking of children for profit; the knowledge stays in the commons.
6. **Calm over exciting.** Reward sustained practice with clarity and respect, not with slot-machine mechanics.

## Accessibility & Inclusion

- Children as young as about six: short words, large text, large tap targets (at least 44px), one primary action per screen.
- State is never conveyed by colour alone; always add a word, number, icon or shape.
- Visible keyboard and switch focus at least 2px thick; support reduced motion.
- Cheap devices and weak connections: light pages, self-hosted fonts, offline-capable PWA.
- Kazakh, Russian and English with full Cyrillic support, including the Kazakh-specific letters.
- Target contrast at least WCAG AA (4.5:1 for small text).
