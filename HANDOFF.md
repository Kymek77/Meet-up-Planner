# Meet-up Planner — product baseline and handoff

## How to use this handoff

Treat the product requirements below as the continuing baseline for all future work on Meet-up Planner. Preserve existing behavior while implementing them, and do not narrow the product to the most recent GitHub sync change. GitHub sign-in uses a GitHub App and a Cloudflare Worker for the web authorization token exchange.

## Domain migration

The owner has purchased `meetup-planner.com` through Cloudflare. Migration to same-origin Worker hosting and an optional persistent-session sync mode is being prepared; do not assume the new deployment is live. Keep the existing GitHub-only sync mode available without a subscription. Before the origin changes, export local planner data from each device and keep the old site available until the new site is verified. Browser storage does not move between origins.

## Product purpose

Build a complete, production-quality, mobile-first personal planner for organising multiple one-to-one meet-ups with friends during a fixed period, such as a festive trip. The app is for one user. Friends never sign in, fill in forms, or book slots; the user contacts them through WhatsApp, iMessage, in person, or other channels and enters their availability.

The experience should feel like a polished, calm, personal planner—not a business scheduling tool or spreadsheet. The app is local-first, works offline, and optionally syncs to the user's private GitHub repository so the same data can be accessed from other devices.

## Non-goals

Do not build group availability polls, friend-facing booking pages, shared editing or multi-user collaboration, messaging integrations, calendar OAuth, or a backend planner-data server/database. The Cloudflare Worker may host the frontend, manage sessions, and proxy GitHub sync, but GitHub remains the optional cloud data store.

## Product workflow

1. Create a planning period, such as “Festive trip: 20–30 December”.
2. Add the friends to see and enter their availability from their messages.
3. Add personal available time blocks.
4. Create tentative meet-ups and assign one friend to each.
5. Mark plans confirmed once agreed.
6. Review unbooked friends, conflicts, gaps, and a final itinerary.
7. Optionally connect GitHub and sync the same planner data across devices.

## Technology and quality baseline

- React 18+ and TypeScript with Vite.
- date-fns for date handling; React Router only if routing is needed.
- Zustand or React Context for state; IndexedDB via Dexie for local-first persistence.
- GitHub REST API for optional cloud sync; Vitest for scheduling and sync tests.
- PWA support for installation on a phone home screen.
- Zod runtime validation for imported and downloaded JSON.
- Keep UI components, state/storage, GitHub API services, date/time utilities, and validation appropriately separated.
- Avoid `any` where practical, heavy UI libraries unless justified, non-working placeholders, and unnecessary dependencies.
- Use accessible semantic HTML and labels, keyboard navigation, large touch targets, and WCAG AA contrast. Colour-coding must also have text/icon/pattern cues.
- Support phone portrait and landscape layouts, desktop navigation, and preferably system dark mode.
- Provide confirmation or undo for destructive actions, especially deleting friends, availability, or confirmed plans.

## Branding

The exact app name is **Meet-up Planner**. Use it consistently in the browser title, PWA metadata, header, empty states, and documentation. Use a friendly, clean, modern visual style; colour is the primary way to distinguish friends and plan status.

## Core entities

Keep the product concepts represented in the data model:

- **Friend:** `id`, `name`, `colour`, priority (`must-see | high | normal | low`), optional location/notes, and creation/update timestamps.
- **Availability block:** `id`, friend reference, ISO date, start/end time, source (`WhatsApp | iMessage | In person | Other`), confidence (`firm | likely | maybe`), optional notes, timestamps, and an expired/no-longer-relevant state.
- **My time block:** `id`, ISO date, start/end time, optional label, location, notes, timestamps, and a way to distinguish available, reserved, busy, or unavailable time.
- **Meet-up:** `id`, one friend reference, title/activity, ISO date, start/end time, status (`idea | proposed | awaiting-reply | tentative | confirmed | cancelled`), optional location, travel-time minutes, notes, and timestamps.
- **Planning period:** `id`, name, start/end dates, active state, and timestamps.

Preserve relationships and validate imported/cloud data. The planner snapshot includes friends, periods, availability, and meet-ups.

## Functional requirements

### Friends

- Add, edit, archive, and delete friends. Assign colours automatically and allow changing them.
- Set priority (`must-see`, `high`, `normal`, `low`) and notes such as shift patterns, preferred times, early finishes, or reminders.
- Clearly show friends with no confirmed meet-up, and per-friend confirmed, tentative, and unassigned meet-up counts.
- Provide filtering by priority, status, confirmed state, and unbooked/contact-needed state.

### Friend availability and personal time

- Enter multiple availability blocks per friend per day, including broad periods such as Monday afternoon, Tuesday evening, or Wednesday lunchtime.
- Include free-text notes and distinguish firm, likely, and maybe availability.
- Mark availability expired or no longer relevant.
- Add the user's own available blocks in a distinct neutral colour; support labels, location, and notes.
- Mark personal blocks reserved, busy, or unavailable. Prevent accidental double-booking where possible.

### Meet-up planning and conflicts

- Create a meet-up from friend availability or a personal time block; one friend per meet-up.
- Support idea, proposed, awaiting reply, tentative, confirmed, and cancelled statuses with clear non-colour cues.
- Duplicate a meet-up as another option.
- Move meet-ups by desktop drag-and-drop and through an edit form on mobile.
- Warn on overlapping confirmed meet-ups, overlapping tentative meet-ups, overlap with unavailable time, and dates outside the planning period.
- Configure the between-meet-up buffer (default 30 minutes) and warn when the gap is too short.

### Calendar

Provide a week view with days as columns and time as rows. Show personal availability, friend availability, tentative plans, and confirmed plans, using friend colours consistently. Tapping a block opens its details; tapping an empty slot can create a meet-up. Show conflict warnings.

### People view

Show every friend as a card with their availability, proposed options, confirmed plan, and unbooked status. Support priority/status/confirmation filters and make people to contact or chase obvious.

### Itinerary

Show confirmed meet-ups chronologically with date, time, friend, activity, location, travel time, and notes. Highlight gaps and potential travel issues. Allow copying a plain-text itinerary.

### Dashboard

Show the current planning period, friend count, confirmed count, tentative/awaiting-reply count, unbooked count, today's meet-ups, next confirmed meet-up, conflicts/warnings, and (when last-contacted dates exist) friends not contacted recently.

### Settings, backup, and empty state

- Settings include GitHub connection/repository settings, default meet-up duration, travel buffer, theme, JSON export/import, and a danger zone to delete local data.
- Export a complete, human-readable JSON backup. Import must validate before replacement and warn before replacing existing data.
- Provide a plain-text export of confirmed meet-ups.
- On first load, show a friendly empty state explaining that planning can start immediately and GitHub can be connected later.

## Local-first, offline, and privacy baseline

- Keep all planner data in IndexedDB. Changes must be saved locally before cloud sync and survive refresh.
- The app remains usable offline; queue unsynced changes and retry when connectivity returns while the app is open. Show a clear offline/sync indicator.
- Keep credentials and GitHub repository configuration out of exported planner data.
- Never log or expose access tokens, hard-code a personal access token, or commit tokens, secrets, or real personal data.
- Use environment variables only for public, non-secret build configuration.
- Browser storage can be evicted; encourage regular exports.

## GitHub App authentication and private sync

Use the GitHub App created for this planner. GitHub Pages uses GitHub App web authorization with PKCE and a Cloudflare Worker for the token exchange:

1. The user starts **Connect GitHub** in planner Settings, authorizes the app on GitHub and returns to the planner. The planner verifies state and sends the authorization code and PKCE verifier to the Worker. A device-code fallback supports installed apps that cannot return to the same browser session. Only the Worker holds the client secret.
2. If the app is not installed on their personal account, the planner offers GitHub's installation page; the user returns to the planner and selects **Continue after installation**.
3. Direct GitHub mode keeps the user token in memory only; it is cleared on reload/sign-out. Connected mode uses an HttpOnly same-origin session cookie and stores encrypted tokens in a Worker Durable Object. Never put an app client secret, session encryption key, or private key in frontend code or build variables.
4. Request **Contents: Read and write** and **Repository creation: Read and write** for automatic creation. Enable Device Flow, disable webhooks and configure the deployed planner URL as the homepage and exact callback URL. The site owner can deploy and configure the Worker through the Cloudflare browser dashboard as described in README.
5. On successful sign-in, create or connect a private `meet-up-planner-data` repository and initialize `data/meetup-planner.json`. If creation is not permitted, instruct the user to create a private repository manually and grant the app access.
6. Repository settings are owner, private repository name, branch, and file path (default `data/meetup-planner.json`). Keep settings and sync state locally.
7. Use GitHub Contents API reads and writes. Include the current blob SHA on updates; detect conflicts and never silently overwrite. Connected mode merges independent record changes against a trusted baseline; incompatible edits and deletions require a choice. Direct mode retains its explicit whole-copy conflict flow. Before replacing a version, download a dated backup.
8. Save locally first, debounce automatic sync (approximately 2–5 seconds), provide manual **Sync now**, show clear saved/syncing/synced/offline/failure status, and retain local data for retries during outages.
9. Handle missing repositories, incorrect branches/paths, expired/revoked tokens, and insufficient permissions with actionable messages.

For GitHub Pages, repository Actions Variables `MEETUP_APP_CLIENT_ID`, `MEETUP_APP_SLUG`, and `MEETUP_AUTH_URL` map to public Vite build variables. Set the client secret only in the Worker secret store. See README for deployment and callback configuration.

## GitHub Pages and documentation

Configure Vite with the correct project-site base path, no routing that breaks Pages (use hash routing if client-side routing is needed), and a Pages workflow that installs dependencies, type-checks/builds, runs tests, and deploys. The repository README should explain creating/configuring the private data repository, GitHub App sign-in, deployment, stored data/privacy, and backup export/import.

## Test baseline

Write and maintain tests for meet-up creation/update, conflict detection, travel-buffer warnings, availability merging, sync serialization/deserialization, and import/export validation. Run existing lint, tests, and build after relevant code changes; do not remove unrelated tests to make checks pass.

## Original implementation order

1. Project setup, routing, theme, PWA foundations, and local data layer.
2. Friends CRUD and colour assignment.
3. Friend availability and personal time blocks.
4. Meet-up creation/editing/statuses and conflict detection.
5. Week calendar.
6. People view and dashboard.
7. Itinerary.
8. GitHub App authentication.
9. GitHub JSON sync, conflict handling, and status.
10. Export/import, settings, tests, README, and Pages deployment.

## Acceptance checklist

- [ ] Add friends and assign each a colour.
- [ ] Enter friends' availability manually and add personal available time.
- [ ] Create tentative meet-ups, move them between slots, and confirm them.
- [ ] See unbooked friends and scheduling/travel-buffer conflicts.
- [ ] View and copy a chronological confirmed itinerary.
- [ ] Use the app offline with persistent local data.
- [ ] Sign in with the GitHub App and sync a JSON file to a private repository.
- [ ] Access the same planner from another device after reconnecting.
- [ ] Export/import a complete validated JSON backup.
- [ ] Install the app as a phone PWA and deploy it to GitHub Pages.

Treat this checklist as a product-level audit, not a claim that each item has already been tested or fully implemented. Check the current application and tests before reporting an item complete.

## Historical authentication fix handoff

The following investigation and deployment instructions describe the earlier Pages-only setup. The owner has since reported successful sign-in; use the current README for Worker hosting and domain migration rather than the historical build settings below.

**Latest investigation:** The `fetch_failed` log is consistent with the Worker setting `redirect: 'error'`, which Cloudflare Workers does not implement and rejects before sending the request. The Worker now uses `redirect: 'manual'` and rejects all non-2xx responses, including redirects, without forwarding credentials. Deploy this change to Cloudflare and restart sign-in with a fresh authorization code; a successful live exchange is still unverified. If `fetch_failed` persists after deployment, investigate outbound connectivity rather than assuming this was the only cause. See [Cloudflare's Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/).

This fix changes the Worker, its authentication tests and troubleshooting documentation. The observed `fetch_failed` log does not include an exception, so the unsupported redirect mode is the likely cause, not a confirmed live diagnosis. The fix has not yet been deployed or verified against a real GitHub sign-in.

Cloudflare's first build failed with **root directory not found** because the `worker` folder was not yet on `main`; the folder is now present on the deployed branch. In Cloudflare Workers Builds, use root directory `worker`, Worker name `meet-up-planner-auth`, a blank build command, deploy command `npx wrangler deploy`, preview builds off, and Cloudflare Access off.

### Remaining deployment steps

1. Confirm the GitHub App is public if other accounts will use it, with the exact deployed planner URL as homepage and callback, Device Flow enabled, webhooks disabled, and **Contents: read and write** plus **Repository creation: read and write** permissions. Approve changed permissions on existing installations.
2. In the deployed Worker's Cloudflare **Settings → Variables and Secrets**, add text runtime variables `GITHUB_CLIENT_ID`, `PLANNER_ORIGIN` (origin only, no trailing slash) and `CALLBACK_URL` (the exact planner callback URL including trailing slash). Add the GitHub App client secret as a **Secret** named `GITHUB_CLIENT_SECRET` and deploy the configuration. Never put the secret in Git, frontend configuration or logs.
3. In repository **Settings → Secrets and variables → Actions → Variables**, set the public variables `MEETUP_APP_CLIENT_ID`, `MEETUP_APP_SLUG` and `MEETUP_AUTH_URL` (the Worker URL). Ensure Pages uses **GitHub Actions**. The latest Pages workflow run (#9) succeeded, but a successful build/deployment does not verify the live Worker or prove the built site received the intended Worker URL.
4. **Current live sign-in status:** GitHub authorization redirects back to the planner, but the deployed Worker's `/exchange` request returned HTTP 502 and logged `fetch_failed`; the browser's `OPTIONS` preflight returned 204. Merge and deploy the redirect fix, confirm Cloudflare deployed the new revision, and retry sign-in from the beginning to obtain a fresh authorization code. If it still fails, inspect **Workers & Pages → `meet-up-planner-auth` → Logs** for `GitHub authentication upstream failure`. The log contains only a category, upstream HTTP status and GitHub request ID when available, and a sanitized OAuth error code when applicable. It never logs request or response bodies, authorization codes, PKCE verifiers, tokens, or secrets.
   
   Interpret the diagnostic as follows:
   - `oauth_error` with an `errorCode`: verify the Worker client ID and secret belong to the same GitHub App, and that the app callback URL exactly matches `CALLBACK_URL`; then retry with a fresh authorization.
   - `non_2xx_response`: use the upstream status and GitHub request ID to investigate the GitHub-side response. The response body is intentionally not logged.
   - `fetch_failed`: the Worker could not complete its outbound GitHub request; investigate outbound connectivity or a transient GitHub/network failure.
   - `invalid_json` or `invalid_response`: GitHub returned a successful HTTP status but the response could not be parsed or did not match the expected token/device-flow shape.

   The reported log already includes these diagnostics; it predates deployment of the redirect fix. Do not share request bodies, authorization codes, tokens, or secrets. Once the issue is resolved, remove or reduce the temporary diagnostics if they are no longer needed.

   For other statuses, inspect the failing `/exchange` request in browser Developer Tools → **Network** and check Worker configuration:
   - `403`: the request's `Origin` must exactly equal `PLANNER_ORIGIN`.
   - `503`: check that all Worker variables/secrets exist and that `CALLBACK_URL` is a valid URL on `PLANNER_ORIGIN`.
   - `502`: follow the diagnostic steps above; the status alone cannot identify the upstream cause.
   - `401`: GitHub returned a successful response without an access token; check the logged OAuth error code or invalid-response category.
   Update Worker configuration in Cloudflare and deploy it after any changes. The Worker URL is the endpoint, not the GitHub callback URL.
5. Once the Worker is correctly configured, merging/pushing to the configured `main` branch triggers the GitHub Pages workflow and, if Cloudflare Workers Builds is connected to that branch, a Worker build/deployment. A Pages rerun only rebuilds the frontend; it does not change Worker runtime variables or secrets. Confirm both deployments, then test authorization, installation if prompted, private repository creation and JSON initialization, reconnection, device-code fallback, conflicts, and offline/reconnect behavior without losing local data. The complete live flow remains unverified.

The GitHub installation page may require selecting an existing repository when choosing selected repositories. All-repository access is broader; GitHub controls this choice. Repository creation also depends on GitHub permissions, and a 404 can mean an existing repository is inaccessible. In direct mode the Worker handles sign-in and sync calls GitHub directly; connected mode also proxies sync. The Worker Free plan has request limits, including device-flow polling, and its origin check alone does not prevent abuse.

Historical validation of the redirect fix: lint passed, all 28 tests passed, and the production build passed. The owner subsequently reported that live login and setup work. The new domain and connected-session flow still require separate live verification after deployment.

## Known GitHub sync behavior

- Direct GitHub sign-in is session-only; connected mode uses a persistent Worker session.
- Direct mode conflicts require an explicit choice between local and cloud data. Connected mode can merge independent record changes against a trusted local baseline, but conflicting edits still require a choice.
- Automatic private repository creation depends on the GitHub App's granted permissions; manual creation of a private repository is the fallback.
- Remote JSON is validated before use. Never weaken validation or replace the local snapshot with unvalidated data.
