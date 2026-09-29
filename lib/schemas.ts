/**
 * lib/schemas.ts — per-command typebox schema overrides (optional sugar).
 *
 * PLAN §4: hand-written typed schemas for ~20 commands. New gstack flags are
 * ALWAYS available via `extraArgs` (every schema declares it), so additions
 * upstream are safe. Removals/renames of typed historical flags surface as
 * gen:tools WARNs at build (PLAN §10 cross-check) and require a manual update
 * here. Orphans (schema for a removed command) are discarded by gen:tools.
 *
 * `SCHEMA_FOR` is consumed by tools.generated.ts. Each entry is keyed by the
 * canonical gstack command name (matching COMMAND_DESCRIPTIONS keys). Missing
 * keys fall back to a bare `{ extraArgs?, timeoutMs? }` shape (lazy default,
 * still allowlist-validated).
 *
 * buildArgs() for a command with a typed schema maps params -> CLI args using
 * the per-command usage shape from commands.ts. Only the conversions that
 * differ from the trivial "-propName value" form are hand-coded.
 */
import { Type } from "typebox";

// Common tail every tool accepts.
const COMMON = {
  extraArgs: Type.Optional(Type.Array(Type.String())),
  timeoutMs: Type.Optional(Type.Number()),
};

// ref | selector: both optional, validated in execute (exactly one required
// where the command expects a target). We declare both optional here so the
// schema is loose; the per-command buildArgs decides precedence.
const TGT = {
  ref: Type.Optional(Type.String({ description: "@e3 ref from snapshot" })),
  selector: Type.Optional(Type.String({ description: "CSS selector" })),
};

const S = {
  goto: Type.Object({
    url: Type.String({ description: "http(s):// or file:// URL" }),
    ...COMMON,
  }),
  load_html: Type.Object({
    file: Type.String({ description: "HTML file path under safe-dirs" }),
    waitUntil: Type.Optional(
      Type.String({ description: "load|domcontentloaded|networkidle (--wait-until)" }),
    ),
    tabIndex: Type.Optional(Type.Number({ description: "--tab-id <N>" })),
    ...COMMON,
  }),
  click: Type.Object({ ...TGT, ...COMMON }),
  fill: Type.Object({
    ...TGT,
    value: Type.String({ description: "Text to fill" }),
    ...COMMON,
  }),
  select: Type.Object({
    ...TGT,
    value: Type.String({ description: "Dropdown value/label/visible text" }),
    ...COMMON,
  }),
  hover: Type.Object({ ...TGT, ...COMMON }),
  type: Type.Object({
    text: Type.String({ description: "Text to type into focused element" }),
    ...COMMON,
  }),
  press: Type.Object({
    key: Type.String({
      description:
        "Playwright key name: Enter, Tab, Escape, ArrowUp/Down/Left/Right, Backspace, Delete, Home, End, PageUp, PageDown, or combos like Shift+Enter, Control+A, Meta+K.",
    }),
    ...COMMON,
  }),
  scroll: Type.Object({ ref: TGT.ref, selector: TGT.selector, ...COMMON }),
  wait: Type.Object({
    selector: Type.Optional(Type.String()),
    networkidle: Type.Optional(Type.Boolean({ description: "--networkidle" })),
    load: Type.Optional(Type.Boolean({ description: "--load" })),
    ...COMMON,
  }),
  upload: Type.Object({
    ...TGT,
    files: Type.Array(Type.String(), { description: "One or more file paths" }),
    ...COMMON,
  }),
  viewport: Type.Object({
    size: Type.Optional(Type.String({ description: "WxH, e.g. 1280x720" })),
    scale: Type.Optional(Type.Number({ description: "--scale <n> (1-3)" })),
    ...COMMON,
  }),
  cookie: Type.Object({
    nameValue: Type.String({ description: "<name>=<value>" }),
    ...COMMON,
  }),
  cookie_import: Type.Object({
    json: Type.String({ description: "JSON file path" }),
    ...COMMON,
  }),
  cookie_import_browser: Type.Object({
    browser: Type.Optional(Type.String()),
    domain: Type.Optional(Type.String({ description: "--domain <d>" })),
    ...COMMON,
  }),
  header: Type.Object({
    nameValue: Type.String({ description: "<name>:<value>" }),
    ...COMMON,
  }),
  useragent: Type.Object({
    string: Type.String({ description: "User agent string" }),
    ...COMMON,
  }),
  dialog_accept: Type.Object({
    text: Type.Optional(Type.String({ description: "Prompt response text" })),
    ...COMMON,
  }),
  text: Type.Object({ selector: TGT.selector, ...COMMON }),
  html: Type.Object({ selector: TGT.selector, ...COMMON }),
  links: Type.Object({ ...TGT, ...COMMON }),
  forms: Type.Object({ ...TGT, ...COMMON }),
  media: Type.Object({
    images: Type.Optional(Type.Boolean({ description: "--images" })),
    videos: Type.Optional(Type.Boolean({ description: "--videos" })),
    audio: Type.Optional(Type.Boolean({ description: "--audio" })),
    selector: Type.Optional(Type.String()),
    ...COMMON,
  }),
  accessibility: Type.Object({ ...TGT, ...COMMON }),
  js: Type.Object({
    expr: Type.String({ description: "Inline JS expression" }),
    out: Type.Optional(Type.String({ description: "--out <file>" })),
    raw: Type.Optional(Type.Boolean({ description: "--raw (skip base64 decode)" })),
    ...COMMON,
  }),
  eval: Type.Object({
    file: Type.String({ description: "JS file path under /tmp or cwd" }),
    out: Type.Optional(Type.String()),
    raw: Type.Optional(Type.Boolean()),
    ...COMMON,
  }),
  css: Type.Object({
    selector: Type.String(),
    prop: Type.String({ description: "CSS property name" }),
    ...COMMON,
  }),
  attrs: Type.Object({ ref: TGT.ref, selector: TGT.selector, ...COMMON }),
  is: Type.Object({
    prop: Type.String({
      description: "visible|hidden|enabled|disabled|checked|editable|focused",
    }),
    ref: TGT.ref,
    selector: TGT.selector,
    ...COMMON,
  }),
  console: Type.Object({
    clear: Type.Optional(Type.Boolean({ description: "--clear" })),
    errors: Type.Optional(Type.Boolean({ description: "--errors" })),
    ...COMMON,
  }),
  network: Type.Object({
    clear: Type.Optional(Type.Boolean({ description: "--clear" })),
    ...COMMON,
  }),
  storage: Type.Object({
    setKey: Type.Optional(Type.String({ description: "set mode: key" })),
    setValue: Type.Optional(Type.String({ description: "set mode: value" })),
    ...COMMON,
  }),
  style: Type.Object({
    ...TGT,
    prop: Type.String({ description: "CSS property" }),
    value: Type.String({ description: "CSS value" }),
    undo: Type.Optional(Type.Boolean({ description: "style --undo mode" })),
    undoN: Type.Optional(Type.Number()),
    ...COMMON,
  }),
  cleanup: Type.Object({
    ads: Type.Optional(Type.Boolean({ description: "--ads" })),
    cookies: Type.Optional(Type.Boolean({ description: "--cookies" })),
    sticky: Type.Optional(Type.Boolean({ description: "--sticky" })),
    social: Type.Optional(Type.Boolean({ description: "--social" })),
    all: Type.Optional(Type.Boolean({ description: "--all" })),
    ...COMMON,
  }),
  snapshot: Type.Object({
    interactive: Type.Optional(Type.Boolean({ description: "-i interactive only" })),
    compact: Type.Optional(Type.Boolean({ description: "-c compact" })),
    depth: Type.Optional(Type.Number({ description: "-d N depth limit" })),
    selector: Type.Optional(Type.String({ description: "-s <sel> scope" })),
    diff: Type.Optional(Type.Boolean({ description: "-D diff vs previous" })),
    annotate: Type.Optional(Type.Boolean({ description: "-a annotated screenshot" })),
    outputPath: Type.Optional(Type.String({ description: "-o <path>" })),
    cursorInteractive: Type.Optional(Type.Boolean({ description: "-C @c refs" })),
    heatmap: Type.Optional(Type.String({ description: "-H <json> heatmap" })),
    ...COMMON,
  }),
  screenshot: Type.Object({
    ...TGT,
    viewport: Type.Optional(Type.Boolean({ description: "--viewport" })),
    clip: Type.Optional(Type.String({ description: "--clip x,y,w,h" })),
    base64: Type.Optional(Type.Boolean({ description: "--base64" })),
    path: Type.Optional(Type.String({ description: "output path" })),
    ...COMMON,
  }),
  pdf: Type.Object({
    path: Type.Optional(Type.String()),
    format: Type.Optional(Type.String({ description: "letter|a4|legal" })),
    width: Type.Optional(Type.String()),
    height: Type.Optional(Type.String()),
    margins: Type.Optional(Type.String()),
    pageNumbers: Type.Optional(Type.Boolean()),
    tagged: Type.Optional(Type.Boolean()),
    outline: Type.Optional(Type.Boolean()),
    printBackground: Type.Optional(Type.Boolean()),
    tabIndex: Type.Optional(Type.Number({ description: "--tab-id <N>" })),
    ...COMMON,
  }),
  responsive: Type.Object({
    prefix: Type.Optional(Type.String({ description: "filename prefix" })),
    ...COMMON,
  }),
  diff: Type.Object({
    url1: Type.String(),
    url2: Type.String(),
    ...COMMON,
  }),
  download: Type.Object({
    url: Type.Optional(Type.String({ description: "URL to download (positional — url OR ref, not both)" })),
    ref: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    base64: Type.Optional(Type.Boolean()),
    navigate: Type.Optional(Type.Boolean({ description: "--navigate" })),
    ...COMMON,
  }),
  scrape: Type.Object({
    kind: Type.String({ description: "images|videos|media" }),
    selector: Type.Optional(Type.String()),
    dir: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
    ...COMMON,
  }),
  archive: Type.Object({ path: Type.Optional(Type.String()), ...COMMON }),
  tabs: Type.Object({ ...COMMON }),
  tab: Type.Object({ id: Type.Number(), ...COMMON }),
  newtab: Type.Object({
    url: Type.Optional(Type.String()),
    json: Type.Optional(Type.Boolean({ description: "--json" })),
    ...COMMON,
  }),
  closetab: Type.Object({ id: Type.Optional(Type.Number()), ...COMMON }),
  frame: Type.Object({
    ref: Type.Optional(Type.String()),
    selector: Type.Optional(Type.String()),
    name: Type.Optional(Type.String({ description: "--name n" })),
    url: Type.Optional(Type.String({ description: "--url pattern" })),
    main: Type.Optional(Type.Boolean({ description: "return to main frame" })),
    ...COMMON,
  }),
  state: Type.Object({
    action: Type.String({ description: "save|load" }),
    name: Type.String(),
    ...COMMON,
  }),
  skill: Type.Object({
    action: Type.String({ description: "list|show|run|test|rm" }),
    name: Type.Optional(Type.String()),
    arg: Type.Optional(Type.Array(Type.String(), { description: "--arg k=v ..." })),
    timeoutSec: Type.Optional(Type.Number({ description: "--timeout=Ns" })),
    ...COMMON,
  }),
  ux_audit: Type.Object({ ...COMMON }),
  prettyscreenshot: Type.Object({
    scrollTo: Type.Optional(Type.String({ description: "--scroll-to <sel|text>" })),
    cleanup: Type.Optional(Type.Boolean()),
    hide: Type.Optional(Type.Array(Type.String(), { description: "--hide <sel> ..." })),
    width: Type.Optional(Type.Number()),
    path: Type.Optional(Type.String()),
    ...COMMON,
  }),
  handoff: Type.Object({ message: Type.Optional(Type.String()), ...COMMON }),
  resume: Type.Object({ ...COMMON }),
  // --- WP1 (HANDOFF §3): batch + daemon lifecycle surface --------------------
  chain: Type.Object({
    commands: Type.Array(Type.Array(Type.String()), {
      minItems: 1,
      description:
        'JSON array of [cmd, ...args] batches, e.g. [["goto","https://x"],["click","@e3"],["text","h1"]]. Executed in order; every command runs — failures appear as "[cmd] ERROR: ..." lines (no early stop; check every line). Payload travels via stdin.',
    }),
    // Deliberately NO extraArgs here: argv extras are meaningless when the
    // payload travels via stdin, and passing them would silently break the
    // stdin contract (review finding #4). Only the shared timeout applies.
    timeoutMs: Type.Optional(Type.Number()),
  }),
  dialog: Type.Object({ ...COMMON }),
  perf: Type.Object({
    selector: Type.Optional(Type.String({ description: "CSS selector (positional target)" })),
    ...COMMON,
  }),
  status: Type.Object({ ...COMMON }),
  restart: Type.Object({
    force: Type.Optional(
      Type.Boolean({ description: "--force-restart: also kill a live-but-busy daemon" }),
    ),
    ...COMMON,
  }),
  reload: Type.Object({ ...COMMON }),
  back: Type.Object({ ...COMMON }),
  forward: Type.Object({ ...COMMON }),
  url: Type.Object({ ...COMMON }),
  cookies: Type.Object({ ...COMMON }),
  dialog_dismiss: Type.Object({ ...COMMON }),
};

export const SCHEMA_FOR = S;

/** Bare fallback for commands without a typed schema. */
export const BARE_SCHEMA = Type.Object({ ...COMMON });
