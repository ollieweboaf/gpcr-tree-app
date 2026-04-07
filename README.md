# GPCR Tree — Scroll Animation

A scroll-controlled animation of a GPCR phylogenetic tree. The tree grows
organically from its root as the user scrolls, then highlights named tips
(specific GPCRs) once the canopy is fully drawn.

## Features

- Scroll-driven SVG path animation, growing outward from the trunk
- Built-in **Label tips** mode for clicking branch tips and naming them
- **Colors** panel for live customization of tree, tip, label, and background
  colors (persisted to localStorage)
- **Embed** export that produces a self-contained HTML snippet ready to paste
  into a Webflow Embed element

## Local development

It's a pure static site — no build step. Just open `index.html` in a browser,
or serve the folder with any static server, e.g.:

```bash
python3 -m http.server 8000
```

## Files

- `index.html` — page shell with the SVG inlined
- `styles.css` — dark theme + UI panels
- `app.js` — animation, labeler, color settings, embed generator
- `GPCR_tree_noNames.svg` — source SVG used by the app
- `tips.json` — sample tip configuration
