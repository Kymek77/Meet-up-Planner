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

1. Create a **private** GitHub repository owned by your account and initialize it with a commit on `main`.
2. Create a fine-grained personal access token limited to that repository, with Contents read and write permission.
3. In Settings, enter your GitHub username, repository, branch and file path (default `data/meetup-planner.json`) and the token. The token stays in memory only, and is cleared when you leave Settings or reload.
4. Push from the device containing your data. On another device, pull the cloud copy. Pull replaces local data, so export a backup first.

Sync is manual. Each push uses the last known GitHub blob SHA. If another device has changed the cloud copy, the app shows a conflict choice: use the latest cloud copy on this device, or explicitly overwrite the cloud copy with this device's data. The app does not automatically merge records. The app verifies that the repository is private and owned by the authenticated account.

**Current limitations:** GitHub OAuth Device Flow, automatic background sync, and a conflict-resolution interface are not implemented. The current token-based manual sync is not the requested GitHub sign-in experience. Changes made offline remain local until manually pushed.

## GitHub Pages

In repository Settings → Pages, select **GitHub Actions** as the source. Push to `main` or run the deployment workflow manually. It installs dependencies, lints, tests, builds with the repository-specific base path, and deploys the output. For other hosting, set `VITE_BASE_PATH` to the deployment path at build time (default `/`).

## Data and privacy

The planner stores friends, planning periods, time blocks and meet-ups in IndexedDB. Repository configuration and the most recently synced blob SHA are stored in localStorage. Data pushed to GitHub is a plain JSON file in your private repository and remains in its Git history. Do not use a public repository for personal data. Delete or revoke tokens in GitHub settings when no longer needed.
