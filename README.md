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

1. Create a GitHub OAuth App under Settings → Developer settings → OAuth Apps, enable **Device Flow**, and set its homepage URL to the deployed app. Device Flow does not use a redirect callback.
2. Copy the OAuth App client ID. It is public and is not the client secret; do not put a client secret in this frontend.
3. Create a **private** GitHub repository owned by your account and initialize it with a commit on `main`.
4. In planner Settings, enter the client ID and sign in with GitHub. Approve the one-time device code at GitHub. Select the private repository, branch and file path (default `data/meetup-planner.json`), then push or pull.

GitHub authorizes the OAuth app with the `repo` scope. The resulting access token is kept in memory only and cleared when you leave Settings or reload, so sign in again on each browser/session. The app verifies that the selected repository is private and owned by the signed-in account. Sync is manual. If another device changed the cloud copy, the app offers to use the cloud version or explicitly overwrite it with this device's version; it does not automatically merge records. Changes made offline remain local until manually pushed.

**Current limitation:** Automatic background sync is not implemented.

## GitHub Pages

In repository Settings → Pages, select **GitHub Actions** as the source. Push to `main` or run the deployment workflow manually. It installs dependencies, lints, tests, builds with the repository-specific base path, and deploys the output. For other hosting, set `VITE_BASE_PATH` to the deployment path at build time (default `/`).

## Data and privacy

The planner stores friends, planning periods, time blocks and meet-ups in IndexedDB. Repository configuration and the most recently synced blob SHA are stored in localStorage. Data pushed to GitHub is a plain JSON file in your private repository and remains in its Git history. Do not use a public repository for personal data. Delete or revoke tokens in GitHub settings when no longer needed.
