# CarTrack Pro — QA and release checklist

This document complements automated tests (`backend/tests`, `frontend` Vitest, `frontend/e2e`). Run automated checks locally:

- Backend: `cd backend && pip install -r requirements-dev.txt && ruff check tests && pytest tests -q`
- Frontend: `cd frontend && npm ci && npm run lint && npm test && npm run build`
- End-to-end (starts API + Vite): `cd frontend && npm run test:e2e` (requires backend deps installed; Playwright will spawn `uvicorn` and `npm run dev` per `playwright.config.ts`).

Default seeded admin for local/E2E stacks: `admin` / `demo1234` (see backend startup seeding).

## Manual — VisionFlow

- Upload a short sample video (supported extensions per VisionFlow UI); confirm job appears in history and status progresses without server errors.
- Download or preview annotated output when the pipeline reports completion.
- Confirm `/analyzer` static UI loads when proxied through the backend (production nginx or dev proxy).

## Manual — ANPR

- With a known plate image or clip, verify detections appear under ANPR-related UI/API and optional visit linking behaves as expected.
- Spot-check stats endpoints (`/api/anpr/stats`) after a detection day.

## Manual — WebSocket

- Open the dashboard with browser devtools → Network → WS on `/ws`; confirm a `connected` message after connect.
- Send a JSON ping `{"type":"ping"}` from devtools or a small script; expect `{"type":"pong"}`.

## Optional — Accessibility (axe)

- In Playwright, add `@axe-core/playwright` and run `injectAxe` + `checkA11y` on `/login`, `/`, and one long form page (for example New Visit) before release.

## Optional — Lighthouse

- Run Lighthouse (desktop) on `/` after login; note LCP and CLS. Set informal budgets if you ship frequently.

## Optional — Dependency audit

- `cd frontend && npm audit`
- `pip install pip-audit && pip-audit -r backend/requirements.txt` (or your preferred scanner) before production releases.
