# Visual Design & Wireframing (UI Exploration Only)

When the idea or feature under discovery involves user-facing UI (screens, dashboards, forms, CLI TUI, or browser pages), use this guidance to produce a rapid visual anchor. Skip completely for backend, protocol, or headless infrastructure work.

## 1. Principles
- **Subtraction default**: Rams' "as little design as possible". Every element earns its pixels.
- **Realistic content**: Use representative, realistic domain text, not "Lorem Ipsum".
- **States first**: Always account for loading, empty, and error states.

## 2. Fast HTML Wireframe Sketch
Generate a single-file, self-contained HTML wireframe when visual alignment is needed:
- Self-contained: system fonts, neutral gray palette, clean layout, no external CDN dependencies.
- Save to an ephemeral file under `.kstack/discover/wireframe-<name>.html`.
- If browser tooling (`pi_kstack_goto` or browse) is available, capture a screenshot for quick review.

## 3. Incorporation into Direction Doc
When a wireframe or UI state flow is established, reference its path or key UI layout contract in `## 4. Key Interfaces & Contracts` of `.kstack/discover/direction.md`.
