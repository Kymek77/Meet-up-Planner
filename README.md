# Meet-up Planner

A personal, local-first planner for arranging one-to-one meet-ups. Friends do not need accounts. Planning data stays in this browser's IndexedDB unless you explicitly export it or push it to GitHub.

## Run locally

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run dev
npm test
npm run lint
npm run build
```

Create a planning period, add friends and record their availability and your own. The calendar shows time blocks and plans; click an empty slot to create a plan, or drag an existing plan to another hour on desktop. Use the edit form to move a plan on mobile. Warnings are shown for overlaps, busy blocks, availability and travel buffers. The itinerary shows confirmed plans only.

The installable PWA caches the application for offline use after its first successful online load. Browser storage can be evicted or cleared, so export backups regularly.

## Backups

In Settings, download a readable planner backup or a text itinerary. Restore validates the file before asking to replace local data. The app offers a backup download before replacing or deleting a planner; declining the download continues without it. Restoring or deleting data can also sync that change to GitHub. GitHub credentials and repository settings are not included in backups.

### Moving from GitHub Pages to meetup-planner.com

The new domain has separate browser storage: existing planner data, repository settings and installed PWAs do not move automatically. Before changing the GitHub App callback or deploying the new site, export a JSON backup from every device with local changes. Keep the old site available until you have opened the new site, imported or reconciled the data and verified your planner. Do not clear the old browser storage as part of the migration.

The Worker deployment serves the Vite build at the root and handles `/api/*` on the same origin. Worker static assets and API requests have different Cloudflare usage limits; session storage also has its own limits. The Worker does not store planner snapshots: GitHub remains the optional cloud data store.

## Optional GitHub sync

### Worker deployment

The site owner needs an active Cloudflare zone, a Worker and a GitHub App. Individual planner users do not need a Cloudflare account. The target production origin is `https://meetup-planner.com`; the app and `/api/*` must share this exact HTTPS origin for connected sessions. Attach the Worker as a Cloudflare custom domain only after the new code and settings are ready.

1. In GitHub App settings, add `https://meetup-planner.com/` as an exact callback URL, retaining the existing Pages callback during migration. Set the **Setup URL** to `https://meetup-planner.com/` and turn off **Request user authorization (OAuth) during installation**; GitHub does not allow a separate setup URL when that option is enabled. Enable Device Flow, disable webhooks, and request **Contents: read and write** and **Repository creation: read and write**. Approve changed permissions on existing installations. Repository creation permission is not needed if users create their own private repository.
2. Connect the repository to Cloudflare Workers Builds. Set its root directory to the repository root, build command to `npm ci && npm run build`, and deploy command to `npx wrangler deploy --config worker/wrangler.toml`. Configure public build variables `VITE_GITHUB_APP_CLIENT_ID`, `VITE_GITHUB_APP_SLUG`, `VITE_GITHUB_AUTH_URL=https://meetup-planner.com`, `VITE_GITHUB_APP_SETUP_URL=https://meetup-planner.com/` and `VITE_BASE_PATH=/`. The setup URL build variable must match the GitHub App's setup URL and this site's exact base URL; otherwise installation-first is disabled for that site. The Wrangler configuration deploys the built static assets and the SQLite-backed session Durable Object.
3. Configure Worker runtime variables `GITHUB_CLIENT_ID`, `APP_ORIGIN=https://meetup-planner.com` and `CONNECTED_CALLBACK_URL=https://meetup-planner.com/`. Preserve the existing `PLANNER_ORIGIN` and `CALLBACK_URL` for the Pages site while migrating. Set `GITHUB_CLIENT_SECRET` and `SESSION_ENCRYPTION_KEY` as secrets; the latter must be 32 cryptographically random bytes encoded in base64. Never commit or share either secret. Changing the session encryption key invalidates existing sessions.
4. Deploy the new code and attach the custom domain in **Workers & Pages → Worker → Settings → Domains & Routes → Add → Custom Domain**. Verify HTTPS, both sign-in modes and local data migration before retiring the old site. Cloudflare Builds settings and Worker runtime variables are separate.

The Worker stores encrypted GitHub credentials for connected sessions, but not planner snapshots. Session cookies expire after 30 days; signing out deletes the server session. Users can also revoke access in GitHub settings. Origin checks are not abuse prevention: configure Cloudflare protections and monitor usage.

### Connect your planner

1. In planner Settings choose **Connect GitHub**. On a site configured for installation-first setup, GitHub asks you to add the app to your personal account and then authorize it; the planner continues automatically when you return to the same browser. If you have already added the app on another device, use **Advanced connection settings → Already added on GitHub? Sign in**. On other sites, sign in first and follow the installation instructions if needed.
2. The planner connects an accessible existing private `meet-up-planner-data` repository, or attempts to create one automatically, then initializes `data/meetup-planner.json`. GitHub automatically grants an app access to repositories it creates. Installation with **All repositories** also grants access to your other repositories; with **Only select repositories**, GitHub may require an existing repository to be selected before installation. If an existing planner repository is not accessible or creation is denied, update the installation's repository selection or permissions in GitHub settings. The app never silently overwrites an existing conflicting planner.

On an installed mobile app where GitHub opens in a separate browser and cannot return to the same session, choose **Advanced connection settings → Connect with a device code**. Open the GitHub activation link, enter the displayed code, then return to the planner while it waits for approval. If the app also needs installing, follow the displayed instructions.

In direct mode, sign-in uses the Worker and sync requests go directly from the browser to GitHub. Connected mode uses the Worker for its session and sync requests; it checks for remote changes while the app is open and visible. Browser background restrictions mean this is not instantaneous or a background service. Cloudflare Worker and Durable Object limits and GitHub API limits apply. If a service or quota is unavailable, planner data remains local. Check [Cloudflare's current limits](https://developers.cloudflare.com/workers/platform/limits/) and monitor usage.

If sign-in returns HTTP 502, check that the latest Worker is deployed and inspect its `GitHub authentication upstream failure` log. `fetch_failed` means the outbound request could not be completed; `non_2xx_response` includes the upstream status and GitHub request ID when available. The Worker rejects redirects rather than forwarding credentials to another endpoint. Do not share authorization codes, tokens, client secrets, or request bodies when troubleshooting.

In direct mode the token stays in memory and is cleared on reload or sign-out. Local changes push automatically after a short pause while signed in; pull is manual, and conflicting snapshots require an explicit choice.

Connected mode restores its server session after refresh, checks for changes automatically and merges independent record changes against the last synced baseline. Conflicting edits and deletions require a choice; an on-device safety copy is kept and a downloadable backup is offered before replacement. The baseline and pending local data remain in IndexedDB. Connected sync requires browser support for Web Locks and pauses rather than risk unsafe multi-tab writes if unavailable. Both modes keep local planning available offline.

## GitHub Pages fallback

In repository Settings → Pages, select **GitHub Actions** as the source. Push to `main` or run the deployment workflow manually. It installs dependencies, lints, tests, builds with the repository-specific base path, and deploys the output. For other hosting, set `VITE_BASE_PATH` to the deployment path at build time (default `/`).

A GitHub App has one setup URL. With the production setup URL above, the Pages fallback uses authorization first and offers a separate installation link rather than redirecting users to the production origin. Existing Pages users should keep the old site available for data export during migration.

## Data and privacy

The planner stores friends, planning periods, time blocks and meet-ups in IndexedDB. Connected sync also stores its baseline and local conflict backups there; repository configuration is stored in localStorage. Data pushed to GitHub is a plain JSON file in your private repository and remains in its Git history. Do not use a public repository for personal data. Delete or revoke tokens in GitHub settings when no longer needed.
