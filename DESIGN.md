---
name: FIRST COACH / БІРІНШІ БАПКЕР
description: A calm paper-and-ink training notebook for children and volunteer coaches, built mobile-first for cheap Android phones.
colors:
  bg: "#f4f3ee"
  paper: "#fffefa"
  ink: "#101815"
  muted: "#68716c"
  line: "#d8ddd8"
  accent: "#2e7d53"
  accent-2: "#dff1e6"
  warning: "#a16a18"
  danger: "#b8473d"
  danger-tint: "#f7e4e2"
  white: "#ffffff"
typography:
  display:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(48px, 7vw, 96px)"
    fontWeight: 700
    letterSpacing: "-0.065em"
  numeral:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "128px"
    fontWeight: 800
    letterSpacing: "-0.08em"
  headline:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(32px, 5vw, 60px)"
    fontWeight: 700
    letterSpacing: "-0.05em"
  title:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "20px"
    fontWeight: 700
    letterSpacing: "-0.025em"
  body:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 400
  label:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: "0.12em"
rounded:
  control: "12px"
  card: "18px"
  pill: "999px"
spacing:
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "54px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "14px 18px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "14px 18px"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.danger-tint}"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "14px 18px"
    height: "44px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "22px"
  card-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.white}"
    rounded: "{rounded.card}"
    padding: "28px"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 13px"
    height: "44px"
  option-selected:
    backgroundColor: "{colors.accent-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "16px"
  skill-pill:
    backgroundColor: "{colors.accent-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "6px 9px"
  progress-track:
    backgroundColor: "{colors.line}"
    rounded: "{rounded.pill}"
    height: "10px"
---

<!--
Provenance: authored non-interactively by the fc-mol-blr.6 generator using impeccable's document flow in scan mode.
Token values are extracted from the :root block of first-coach-demo.html (verified identical). Everything labelled
"derived" (the North Star, colour names, spacing scale, the departures listed under Do's and Don'ts) is inferred from
root design sections 1 and 3 plus the prototype, was not confirmed by a human, and may be revised.
-->

# Design System: FIRST COACH / БІРІНШІ БАПКЕР

## Overview

**Creative North Star: "The Coach's Notebook"** (derived)

FIRST COACH is a free, open-source PWA where a child picks a football skill, follows a short drill and watches their own progress. The audience is children (from about age 6) and volunteer or community coaches, most of them on cheap Android phones at 360px width, often on a slow connection, in three languages: Қазақша, Русский and English. The interface has to feel like a well-kept paper notebook lying on a training-ground bench: warm off-white paper, near-black ink, one calm green. It reads like an editorial page, not a sports app. It never shouts at a child, never promises a future as a professional, and never compares one child with another. Progress is measured against yourself.

The system is mobile-first in the literal sense. Every screen is designed at 360px first and then allowed to grow. Large type, generous tap targets and plain paper surfaces are not a concession to small screens; they are the design. Desktop is the same notebook with more margin.

**Key Characteristics:**

- Paper-and-ink palette (warm off-white, near-black green ink) with a single green accent used sparingly.
- Tight, confident Inter headlines with heavy negative tracking; quiet, readable body copy.
- Flat paper cards with hairline borders; one soft ambient shadow reserved for the biggest surfaces.
- Light theme only. No dark mode.
- State always has a second signal beyond colour: words, numbers, icons or shape.
- Built from 360px upward; reduced motion respected.

## Colors

A restrained paper-and-ink palette: warm neutrals do almost all the work, green appears only where something is selected, done or primary, and warning and danger reds are kept for genuine states. Hex values in the frontmatter are normative. Descriptive names are derived.

### Primary

- **Field Green** (#2e7d53, `accent`): the single accent. Eyebrow labels, progress fills, selected borders, the active step and completed drill markers. Its rarity is the point. Contrast is 4.98:1 on paper and 4.53:1 on the page background, which is enough for text at 12px and up on those surfaces only (see the departures under Do's and Don'ts for accent-on-accent-2).
- **Morning Mint** (#dff1e6, `accent-2`): the quiet tint behind selected options, skill pills and step numbers. It marks "this is chosen or achieved" without adding a second hue.

### Neutral

- **Bench Paper** (#f4f3ee, `bg`): the page background. Warm, slightly grey off-white that keeps long sessions easy on the eyes.
- **Notebook Page** (#fffefa, `paper`): the surface colour for cards, panels, drills, inputs' surroundings and secondary buttons. A hair warmer than white so cards read as paper lying on the bench.
- **Ink** (#101815, `ink`): all body text, the primary button, the ink hero card and drill index badges. Contrast 17.88:1 on paper. The prototype's `--dark` is the same value and is treated as Ink, not a separate colour.
- **Pencil Grey** (#68716c, `muted`): secondary text, captions and metadata. 4.99:1 on paper and 4.54:1 on the page background; do not use it below 12px or on Morning Mint.
- **Chalk Line** (#d8ddd8, `line`): hairline borders, dividers and the track behind progress. It is a decorative boundary (1.36:1 on paper); it never carries meaning alone.
- **White** (#ffffff, `white`): text on Ink surfaces and the fill inside text inputs.

### Semantic

- **Amber Notice** (#a16a18, `warning`): cautions, such as an unverified or beta item. 4.53:1 on paper. Always paired with a label.
- **Signal Red** (#b8473d, `danger`): destructive actions and errors. 5.19:1 on paper. Its pale companion (#f7e4e2, `danger-tint`) is the fill for the danger button. Always paired with words and an icon.

### Named Rules

**The One Green Rule.** Field Green is the only chromatic accent. It appears on a small share of any screen. If two things on a screen are both green, one of them is wrong.

**The Second Signal Rule.** State is never conveyed by colour alone. Selected, done, verified, error, warning and progress each carry text, a number, an icon or a shape as well as colour.

## Typography

**Display, headline, title, body and label font:** Inter, with the stack `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.

Inter is self-hosted. There is no third-party font request: the app is a PWA used on cheap phones with patchy data and must work offline. Because the UI ships in Қазақша, Русский and English, the self-hosted subset must be Cyrillic-capable and include the Kazakh-specific letters (Ә ә Ғ ғ Қ қ Ң ң Ө ө Ұ ұ Ү ү Һ һ І і). Verify glyph coverage when the font files are added; a fallback glyph inside a Kazakh word is a bug.

**Character:** one family, big weight contrast. Headlines are heavy, tight and confident, like a printed sports-page masthead; body text is plain and unhurried.

### Hierarchy

- **Display** (700, clamp(48px, 7vw, 96px), line-height .94, tracking -.065em): page H1 only. One per screen.
- **Numeral** (800, 128px, 96px at 600px and below, line-height .8, tracking -.08em): the single large hero number on the ink card. Used once per screen at most.
- **Headline** (700, clamp(32px, 5vw, 60px), line-height 1, tracking -.05em): section H2. Inner page heads use a slightly smaller display size (clamp(40px, 6vw, 74px)).
- **Title** (700, 20px, line-height 1.2, tracking -.025em): card and drill titles. Stat figures use 26 to 30px at tracking -.04em.
- **Body** (400, 16px, line-height 1.45): everything else. Lead paragraphs are 18 to 20px at line-height 1.45 to 1.5. Keep lines at 65 to 75 characters or fewer; section copy caps at about 760px.
- **Label** (700, 12px, uppercase, tracking .12em, Field Green): the eyebrow above a heading. Metadata and captions are 12 to 13px in Pencil Grey.

### Named Rules

**The Tight Headline Rule.** Heavy negative tracking belongs to Display, Numeral and Headline only. Body and Label copy is never tightened. Check the longest Kazakh and Russian headline at 360px before shipping; the tight tracking must not cause collisions or overflow.

**The Body Floor Rule.** Nothing a child must read is smaller than 16px. The 12px Label is for eyebrows and metadata, not instructions.

## Layout

A single centred column on a warm page background. The container is `min(1180px, 100% - 40px)`, narrowing to `100% - 24px` at 600px and below. Sections breathe vertically (54px section padding, larger above the hero); content inside sections is grouped by consistent 8, 12, 16 and 24px gaps (derived scale, see frontmatter).

The prototype is written desktop-first with max-width queries at 900px and 600px. The rule going forward is mobile-first: write the 360px layout as the base and add complexity at wider min-width breakpoints. Approximate steps (derived from the prototype): one column up to 600px; two columns of cards from 600px; three columns of cards and the two-column hero from 900px.

Rules that hold at every width:

- Design and test at 360px first. No horizontal page scroll.
- Multi-column grids collapse to one column at 600px and below; rows such as drills and assessment lines stack their parts vertically.
- Persistent navigation moves into a compact top bar at 900px and below; secondary actions may be hidden but never the language switch.
- Lists of drills and skills are single, scannable columns on phones. One primary action per view.

### Named Rules

**The 360px First Rule.** If a layout only works from 600px up, it is not finished.

## Elevation & Depth

The system is flat by default and tonal: depth comes from paper-on-bench contrast (Notebook Page on Bench Paper) plus a Chalk Line hairline border. Shadows are ambient and rare.

### Shadow Vocabulary

- **Lifted Panel** (`box-shadow: 0 18px 60px rgba(19, 34, 27, .08)`): the large panel and the ink hero card only.
- **Resting Card** (`box-shadow: 0 8px 24px rgba(15, 28, 22, .025)`): the faintest lift on ordinary cards; nearly invisible by design.
- **Focus Ring** (`outline: 3px solid #2e7d53; outline-offset: 2px`, 2px minimum; use Notebook Page on Ink surfaces): the visible keyboard and switch focus indicator. It does not fit the frontmatter, so it lives here. It replaces the prototype's near-invisible 3px 8%-alpha glow.
- The sticky top bar uses a translucent Bench Paper with a 18px backdrop blur; treat this as a progressive enhancement and keep the bar readable without it, since blur is costly on cheap phones.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat with a hairline border at rest. Reach for a shadow only for the one or two largest surfaces on a screen.

**The Visible Focus Rule.** Never remove the outline without replacing it with one at least 2px thick. Focus must be findable on Notebook Page, Bench Paper and Ink alike.

## Shapes

Soft, paper-like corners with three sizes only: **18px** for cards, panels and containers, **12px** for controls (buttons, inputs, options, small badges), and a full **999px** pill for chips, tags, skill pills and progress bars. Circles (step numbers) use the pill radius. Borders are 1px Chalk Line; the selected option is the exception, using a 1px Field Green border and Morning Mint fill. The roadmap item's 3px Field Green left edge is the only directional accent.

The prototype scatters other radii (10px, 11px, 13px, 14px, 16px, 24px, 28px). Normalise them: anything at or below 14px becomes 12px, anything from 16px up becomes 18px, and round shapes become pills.

## Components

Every component is paper first: plain fill, hairline border, no gradients, no decorative illustration.

### Buttons

- **Shape:** gently rounded (12px).
- **Primary:** Ink fill, white text, 14px 18px padding, weight 700. The only filled dark control. On hover it lifts 1px; keep the transition short and disable it under reduced motion.
- **Secondary:** Notebook Page fill, Chalk Line border, Ink text.
- **Danger:** Signal Red text on the pale red tint. Pair with an icon and a plain-language label.
- **Small and ghost buttons:** must still meet the 44px minimum tap target. The prototype's small button (8px 10px padding) does not; enlarge the hit area.
- **Focus:** the Focus Ring above, always visible.

### Cards / Containers

- **Corner Style:** 18px.
- **Background:** Notebook Page on Bench Paper. The ink card (28px padding in the prototype) inverts to Ink with white text and carries the Numeral.
- **Shadow Strategy:** Resting Card for ordinary cards; Lifted Panel for the panel and ink card only.
- **Border:** 1px Chalk Line.
- **Internal Padding:** 22px on cards, 26 to 28px on panels.

### Inputs / Fields

- **Style:** 1px Chalk Line border, white fill, 12px radius, 44px minimum height, always a visible label above (weight 700, 13px) with helper text in Pencil Grey below.
- **Focus:** Field Green border plus the Focus Ring. The prototype's `outline: none` with a faint glow is retired.
- **Error / Disabled:** errors use Signal Red text plus an icon plus a written message next to the field, never a border colour change alone.

### Options and Selection

- **Style:** paper card, 12px radius. Selected state is Field Green border and Morning Mint fill plus a check icon and an accessible selected state, since the colour change alone is not enough.

### Skill Pills and Tags

- **Style:** pill radius, 12px bold label. Field Green text on Morning Mint measures only 4.28:1, so use Ink text on Morning Mint for pills at this size.
- **State:** verified and beta items carry a written word ("verified", "beta"), not only a tint.

### Progress

- **Style:** 10px pill track in Chalk Line, Field Green fill. Always show the number beside it (for example "58%") so progress is readable without colour.
- **Done drills:** a completed drill shows its index badge in Field Green and reduced opacity, plus a check icon and the word "Done".

### Navigation

- **Style:** sticky 76px top bar in translucent Bench Paper; brand mark in an Ink 12px-radius tile; the language switch (kk / ru / en) is always reachable.

### Empty and Notice Blocks

- **Style:** dashed Chalk Line border with muted, encouraging copy for empty states; pale tinted notice blocks for information and warnings, always with a text label.

## Do's and Don'ts

### Do

- **Do** design at 360px width first, on a cheap Android phone, then grow.
- **Do** keep every tap target at least 44px by 44px, including small buttons, chips that act, and icon buttons.
- **Do** keep a visible focus ring of at least 2px outline on every interactive element.
- **Do** measure contrast. Ink on Morning Mint is 15.35:1; Field Green on Morning Mint is only 4.28:1.
- **Do** load Inter from the app's own files with a Cyrillic subset that covers Kazakh letters.
- **Do** write calm, respectful copy: progress against yourself, small honest next steps.
- **Do** respect `prefers-reduced-motion`; motion is minimal and never carries meaning.

### Don't

- **Don't** rely on hue to say what happened. State is never conveyed by colour alone.
- **Don't** add a dark theme, a theme toggle or `prefers-color-scheme: dark` styling. Light theme only. (The Ink hero card is a surface colour, not a dark theme.)
- **Don't** use points economies, streak flames, loot, slot-machine reveals, confetti storms or celebratory pop-ups. No casino gamification. There are also no leaderboards and no ranking of children against each other.
- **Don't** tell a child they will become a professional; the interface never makes that promise.
- **Don't** add new radii, new accent hues or new shadow recipes. Three radii, one accent, three shadow roles.
- **Don't** hide or drop the language switch on small screens.

### Named Rules

**State is never conveyed by colour alone.** Every selected, done, verified, warning, error and progress state carries a word, number, icon or shape.

**Light theme only.** Paper and ink, in daylight. One theme, no toggle.

**No casino gamification.** No leaderboards, no confetti storms, no streak pressure, no reward loops.

### Departures from the prototype (derived rules; hex values unchanged)

The prototype's colour values are kept exactly. These four departures are recorded as rules for real implementation.

1. **Visible focus ring.** At least a 2px outline on every focusable element. The prototype's focus treatment (`outline: none`, 3px glow at 8% alpha) is effectively invisible and must not be carried over.
2. **Tap targets at least 44px.** Every interactive element measures at least 44px in height and width, including the prototype's small button and nav items, which currently fall short.
3. **Accent on accent-2 is 4.28:1.** Field Green (#2e7d53) on Morning Mint (#dff1e6) fails the 4.5:1 threshold for small text. Use Ink for small text on Morning Mint; keep Field Green for large or bold display use only.
4. **Normalise stray radii.** Collapse the prototype's 10, 11, 13, 14, 16, 24 and 28px radii to 18px (cards and containers), 12px (controls) and pill (circles and chips).
