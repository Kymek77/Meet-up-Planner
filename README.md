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

### One-time deployment setup (browser only)

The site owner performs this setup once; individual planner users do not need a Cloudflare account. No local installation or terminal is required.

1. In GitHub → Settings → Developer settings → GitHub Apps, configure the existing **GitHub App** (or register one). Set its homepage and callback URL to the exact deployed planner URL, including the trailing slash, e.g. `https://YOUR-ACCOUNT.github.io/Meet-up-Planner/`. Enable **Device Flow**, turn webhooks off, and request **Contents: read and write** and **Repository creation: read and write**. Make the app public for other GitHub accounts. Approve changed permissions on any existing installation.
2. Ensure these Worker files are merged into the GitHub branch you will deploy. Create a Cloudflare account on the **Workers Free** plan. In the Cloudflare dashboard, open **Workers & Pages → Create application → GitHub**, authorize Cloudflare's GitHub integration and select this repository. Name the Worker `meet-up-planner-auth` to match `worker/wrangler.toml`, choose the deployment branch, and set its **root directory** to `worker`. Leave the optional build command empty and use the default deploy command. Select **Save and Deploy**. Cloudflare runs the deployment; you do not need Wrangler on your computer. The Worker cannot sign users in until the next step is complete.
3. In the deployed Worker's Cloudflare **Settings → Variables and Secrets**, add these runtime variables as text:
   - `GITHUB_CLIENT_ID`: the GitHub App's client ID.
   - `PLANNER_ORIGIN`: the planner origin only, e.g. `https://YOUR-ACCOUNT.github.io` (no path or trailing slash).
   - `CALLBACK_URL`: the exact callback URL configured in step 1.

   Generate a client secret in the GitHub App settings, add it as a **Secret** named `GITHUB_CLIENT_SECRET`, and select **Deploy** to apply the changes. Never put this secret in Git, build variables, or logs. `keep_vars` in the Worker configuration preserves dashboard variables across deployments. Use a dedicated planner origin if possible: other pages on the same origin have the same browser access.
4. Copy the Worker's `workers.dev` URL. In this repository's **Settings → Secrets and variables → Actions → Variables**, set `MEETUP_APP_CLIENT_ID` to the same client ID, `MEETUP_APP_SLUG` to the slug from `github.com/apps/<slug>`, and `MEETUP_AUTH_URL` to the Worker URL. These are public build values, not secrets. Redeploy Pages by running **Deploy Meet-up Planner** from the repository's Actions tab. Cloudflare automatically deploys the Worker when its configured branch changes. Local development can use a separate Worker and GitHub App with matching callback and `VITE_GITHUB_APP_CLIENT_ID`, `VITE_GITHUB_APP_SLUG`, and `VITE_GITHUB_AUTH_URL` in ignored `.env.local`.

The Worker handles authorization only and does not store planner data or tokens. Its origin check is a browser protection, not abuse prevention: public requests can still consume the free quota. Configure Cloudflare protections if needed.

### Connect your planner

1. In planner Settings choose **Connect GitHub** and authorize on GitHub. If the app is not installed on your personal account, the planner offers an installation link. Approve the installation, return to the planner, and choose **Continue after installation**.
2. The planner connects an accessible existing private `meet-up-planner-data` repository, or attempts to create one automatically, then initializes `data/meetup-planner.json`. GitHub automatically grants an app access to repositories it creates. Installation with **All repositories** also grants access to your other repositories; with **Only select repositories**, GitHub may require an existing repository to be selected before installation. If an existing planner repository is not accessible or creation is denied, update the installation's repository selection or permissions in GitHub settings. The app never silently overwrites an existing conflicting planner.

On an installed mobile app where GitHub opens in a separate browser and cannot return to the same session, choose **Use device code instead**. Open the GitHub activation link, enter the displayed code, then return to the planner while it waits for approval.

The Worker is called during sign-in, including browser preflight requests and repeated polling when using the device-code fallback; **sync requests go directly from the browser to GitHub**, not through Cloudflare. GitHub's API rate limits still apply. The Workers Free plan has a daily request limit; if exhausted, new sign-ins fail until the limit resets, while local planning remains available. Check [Cloudflare's current limits](https://developers.cloudflare.com/workers/platform/limits/) and ensure your account remains on the free plan if you do not want usage-based charges.

The GitHub App uses fine-grained app permissions instead of OAuth scopes. Its user access token stays in memory and is cleared on reload or sign-out, so sign in again in each new browser session. While signed in, changes save locally first and sync automatically after a short pause. Offline changes remain in IndexedDB and sync when the app is open and the connection returns; transient errors are retried. The sync status is shown in the app, and **Sync now** remains available. If another device changed the cloud copy, the app asks which version to keep rather than silently overwriting; it downloads a dated backup before replacing either copy. It does not merge planner records automatically.

## GitHub Pages

In repository Settings → Pages, select **GitHub Actions** as the source. Push to `main` or run the deployment workflow manually. It installs dependencies, lints, tests, builds with the repository-specific base path, and deploys the output. For other hosting, set `VITE_BASE_PATH` to the deployment path at build time (default `/`).

## Data and privacy

The planner stores friends, planning periods, time blocks and meet-ups in IndexedDB. Repository configuration and the most recently synced blob SHA are stored in localStorage. Data pushed to GitHub is a plain JSON file in your private repository and remains in its Git history. Do not use a public repository for personal data. Delete or revoke tokens in GitHub settings when no longer needed.
