# Meet-up Planner — product baseline and handoff

## How to use this handoff

Treat the product requirements below as the continuing baseline for all future work on Meet-up Planner. Preserve existing behavior while implementing them, and do not narrow the product to the most recent GitHub sync change. GitHub sign-in uses a GitHub App and a Cloudflare Worker for the web authorization token exchange.

## Product purpose

Build a complete, production-quality, mobile-first personal planner for organising multiple one-to-one meet-ups with friends during a fixed period, such as a festive trip. The app is for one user. Friends never sign in, fill in forms, or book slots; the user contacts them through WhatsApp, iMessage, in person, or other channels and enters their availability.

The experience should feel like a polished, calm, personal planner—not a business scheduling tool or spreadsheet. The app is local-first, works offline, and optionally syncs to the user's private GitHub repository so the same data can be accessed from other devices.

## Non-goals

Do not build group availability polls, friend-facing booking pages, shared editing or multi-user collaboration, messaging integrations, calendar OAuth, or a backend planner-data server/database. The Cloudflare Worker is limited to GitHub authentication.

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
3. The user token remains in memory only; it is cleared on reload/sign-out and the user reconnects in each browser session. Never put an app client secret or private key in frontend code or build variables.
4. Request **Contents: Read and write** and **Repository creation: Read and write** for automatic creation. Enable Device Flow, disable webhooks and configure the deployed planner URL as the homepage and exact callback URL. The site owner can deploy and configure the Worker through the Cloudflare browser dashboard as described in README.
5. On successful sign-in, create or connect a private `meet-up-planner-data` repository and initialize `data/meetup-planner.json`. If creation is not permitted, instruct the user to create a private repository manually and grant the app access.
6. Repository settings are owner, private repository name, branch (default `main`), and file path (default `data/meetup-planner.json`). Keep settings and the most recently synced blob SHA locally.
7. Use GitHub Contents API reads and writes. Include the current blob SHA on updates; detect 409/conflict conditions and never silently overwrite. Before replacing a version, download a dated backup and let the user choose local or cloud data. Automatic record merging is not required.
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

## Current branch / PR handoff

The current branch is `copilot/fix-github-sign-in-user-flow`. It adds the authentication Worker and browser-only deployment guidance, GitHub web authorization with PKCE and a device-code fallback, personal-installation detection, and an attempt to automatically create a private data repository. Existing local-first sync, validation, conflict handling and backups remain in place. The owner intends to merge the branch; no merge is performed by this handoff.

Cloudflare's first build failed with **root directory not found** because the `worker` folder is on this branch but was not yet on `main`. After merging, verify `worker/index.ts` and `worker/wrangler.toml` exist on `main`, then retry the Cloudflare build using `main` and root directory `worker`. In Cloudflare Workers Builds use Worker name `meet-up-planner-auth`, a blank build command, deploy command `npx wrangler deploy`, preview builds off, and Cloudflare Access off. The Worker does not become operational until its runtime variables and secret are configured.

### Remaining deployment steps

1. Confirm the GitHub App is public if other accounts will use it, with the exact deployed planner URL as homepage and callback, Device Flow enabled, webhooks disabled, and **Contents: read and write** plus **Repository creation: read and write** permissions. Approve changed permissions on existing installations.
2. In the deployed Worker's Cloudflare **Settings → Variables and Secrets**, add text runtime variables `GITHUB_CLIENT_ID`, `PLANNER_ORIGIN` (origin only, no trailing slash) and `CALLBACK_URL` (the exact planner callback URL including trailing slash). Add the GitHub App client secret as a **Secret** named `GITHUB_CLIENT_SECRET` and deploy the configuration. Never put the secret in Git, frontend configuration or logs.
3. In repository **Settings → Secrets and variables → Actions → Variables**, set the public variables `MEETUP_APP_CLIENT_ID`, `MEETUP_APP_SLUG` and `MEETUP_AUTH_URL` (the Worker URL). Ensure Pages uses **GitHub Actions**, then run the Pages deployment workflow after these variables are set. Merging triggers a deployment but does not automatically configure the Worker or these variables.
4. Test the live flow: authorize GitHub, install the app if prompted, return and continue, automatically create a private repository and initialize the JSON file, reconnect to an existing installation/repository, and exercise the device-code fallback. Test conflicts and offline/reconnect behavior without losing local data. The live Worker, GitHub installation, repository creation and browser/PWA flows have **not** been verified end to end.

The GitHub installation page may require selecting an existing repository when choosing selected repositories. All-repository access is broader; GitHub controls this choice. Repository creation also depends on GitHub permissions, and a 404 can mean an existing repository is inaccessible. The Worker handles sign-in only; sync calls GitHub directly. The Worker Free plan has request limits, including device-flow polling, and its origin check alone does not prevent abuse.

Most recent code validation before this documentation update: lint, 25 tests and production build passed; secret scanning found no secrets and CodeQL reported no alerts. Run current checks again before release.

## Known GitHub sync behavior

- Sign-in is session-only; reconnect after page reload.
- Conflicts require an explicit choice between local and cloud data; planner records are not automatically merged.
- Automatic private repository creation depends on the GitHub App's granted permissions; manual creation of a private repository is the fallback.
- Remote JSON is validated before use. Never weaken validation or replace the local snapshot with unvalidated data.
