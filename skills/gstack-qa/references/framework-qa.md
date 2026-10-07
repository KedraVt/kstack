# Framework-specific QA checks

Read the section matching the detected framework during exploration.

## Next.js

- Console: hydration errors (`Hydration failed`, `Text content did not match`)
- Network: `_next/data` requests — 404s = broken data fetching
- Test client-side navigation by clicking links (not just `goto`) — catches
  routing issues
- Watch for CLS on pages with dynamic content

## Rails

- Console: N+1 query warnings (development mode)
- CSRF token present in forms
- Turbo/Stimulus transitions smooth; flash messages appear and dismiss

## WordPress

- Plugin conflicts — JS errors from different plugins
- Admin bar visibility for logged-in users
- REST API endpoints (`/wp-json/`)
- Mixed content warnings (common)

## General SPA (React, Vue, Angular)

- `snapshot -i` for navigation — `links` misses client-side routes
- Stale state: navigate away and back — does data refresh?
- Browser back/forward — history handled?
- Memory leaks — watch console after extended use
