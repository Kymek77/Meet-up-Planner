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

In Settings, export a readable JSON backup or a text itinerary. Import validates the file before asking to replace local data. Back up your existing data before importing. GitHub credentials and repository settings are not included in exports.

## Optional GitHub sync

1. Register a **GitHub App** under Settings → Developer settings → GitHub Apps. Enable **Device Flow**, set the homepage URL to the deployed app, turn webhooks off, and request only **Contents: Read and write** plus **Repository creation: Read and write** if you want the planner to create its private data repository. Device Flow does not use a callback URL. Install the app on your account and grant it access to the data repository.
2. In this repository's Settings → Secrets and variables → Actions → Variables, add `MEETUP_APP_CLIENT_ID` with the GitHub App's client ID and `MEETUP_APP_SLUG` with the slug from its GitHub URL (`github.com/apps/<slug>`), then redeploy. GitHub reserves the `GITHUB_` prefix for Actions, so do not use it for custom variable names. Both values are public configuration. Do not put an app client secret or private key in the frontend or Actions variables used by the Vite build. For local development, set `VITE_GITHUB_APP_CLIENT_ID` and `VITE_GITHUB_APP_SLUG` in `.env.local` (ignored by Git).
3. In planner Settings, choose **Install GitHub App** if shown, grant the app access to your account/repository, then choose **Connect GitHub** and approve the one-time device code. The app creates a private `meet-up-planner-data` repository if the granted permissions allow it, and initializes `data/meetup-planner.json`. Otherwise, create a private repository manually and install/grant the app access to it.

The GitHub App uses fine-grained app permissions instead of OAuth scopes. Its user access token stays in memory and is cleared on reload or sign-out, so sign in again in each new browser session. While signed in, changes save locally first and sync automatically after a short pause. Offline changes remain in IndexedDB and sync when the app is open and the connection returns; transient errors are retried. The sync status is shown in the app, and **Sync now** remains available. If another device changed the cloud copy, the app asks which version to keep rather than silently overwriting; it downloads a dated backup before replacing either copy. It does not merge planner records automatically.

## GitHub Pages

In repository Settings → Pages, select **GitHub Actions** as the source. Push to `main` or run the deployment workflow manually. It installs dependencies, lints, tests, builds with the repository-specific base path, and deploys the output. For other hosting, set `VITE_BASE_PATH` to the deployment path at build time (default `/`).

## Data and privacy

The planner stores friends, planning periods, time blocks and meet-ups in IndexedDB. Repository configuration and the most recently synced blob SHA are stored in localStorage. Data pushed to GitHub is a plain JSON file in your private repository and remains in its Git history. Do not use a public repository for personal data. Delete or revoke tokens in GitHub settings when no longer needed.
