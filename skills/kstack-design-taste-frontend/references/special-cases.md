# Special cases

Branches of the run; SKILL.md names when to read this file.

## A product page that shows its app

A product site that shows its app is a page; the interface fragments on it follow the app-screen
rules for their insides. Deal the product's app style once, in its own folder, with the page's colours
and type kept:

```bash
node $KSTACK_EXTENSION_DIR/skills/kstack-design-taste-frontend/scripts/draw.mjs --app --kind <kind> --brief "<the product>" --keep palette,type --out .taste-skill/app
```

and build every fragment the page shows (the hero's live screen, a feature's crop, a chart) as a real
piece of that app: `assets/app.css` for its panels, tables and controls, `assets/charts.js` for its
charts, real data that adds up, one finding stated, cropped and scaled the way the page's blueprint
treats a picture. A fragment that looks like a working product is the strongest picture a software page
has; grey bars and lorem numbers are the weakest. When a request mixes both (a landing page and the
dashboard behind it), build each with its own run and one shared palette and typeface.

## An existing brand or design system

Pass `--keep palette,type`, map the brand's colours and faces
onto the roles, and take only composition from the draw. The house rules still apply; if the brand
itself requires a banned device (its logo sits in a gradient, its accent is violet), keep the brand
asset, say so in the report, and pass `--allow <rule>` to the inspector for that rule only.

## Redesign, restyle or review of an existing page or app screen

1. **Record the before.** Run the project as it is and inspect it into its own folder
   (`inspect.mjs <url> --out .taste-skill/before`, with `--app` for an app screen) and lint its
   source. Read the code: the framework, the styling method (Tailwind v3 or v4, CSS modules,
   styled-components, plain CSS), the components, and what must survive: routes, forms, data,
   behaviour, the brand's own assets.
2. **A review stops here.** Critique the before screenshots with `references/critique.md`, list the
   findings with the inspector's measurements, and name the three changes that would move the page
   most.
3. **Keep the stack, the content and what works.** No framework or styling-library migration; check the
   dependency file before adding anything. A restyle keeps the layout and takes type, colour and
   components from a dealt direction (`--keep` whatever the brand fixes); a redesign deals a full
   direction and rebuilds the sections from its blueprints inside the existing components. Either way
   proceed from step 2 of the run with the page's real content.
4. **Order of work, biggest effect for least risk:** type (faces and scale), colour (one ground, one
   ink, one accent), the frame (margins, section rhythm, a title on the first screen and a heading on
   every section), states (hover, focus, loading, empty, error), then the stock components (icon
   cards, pill badges, gradient blobs, card grids) replaced by the dealt blueprints.
5. **Prove it.** Inspect again into `.taste-skill/after`, compare before and after at every width,
   click through every link, form and menu that worked before, and report the before and after
   measurements side by side.

## A component or a single section, not a page

Skip the draw unless there is no direction to follow.
Match the surrounding design, apply the house rules and the laws, and still inspect the result.

## No checkout, no form backend

The primary button goes to the real destination when the brief names
one. Otherwise it opens an email with a written subject and body (`mailto:` with the visitor's choices
filled in), or, for a shop, it points at `#checkout` and the report says it must be wired before
launch. Never fake a payment form.

## No Chrome or Node 22

Run `lint.mjs` (Node 18+), take screenshots with whatever browser tool you
have, and critique those. Say in the report that the inspector could not run.

## No network

If `assets.mjs` reaches no source, draw the pictures and say in the report that the
open collections could not be searched.
