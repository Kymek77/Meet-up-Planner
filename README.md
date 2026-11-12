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

### Deployment setup

1. Register a **GitHub App** under Settings → Developer settings → GitHub Apps. Set its homepage and callback URL to the exact deployed planner URL, including its trailing slash (for example `https://YOUR-ACCOUNT.github.io/Meet-up-Planner/`). Turn webhooks off. Request **Contents: Read and write**, and **Repository creation: Read and write** if it should create repositories. Make the app public if other GitHub accounts should use it. If changing permissions on an existing app, approve the changes on its installation.
2. Create a Cloudflare account on the **Workers Free** plan. In `worker/wrangler.toml`, set `GITHUB_CLIENT_ID` to the app's client ID, `PLANNER_ORIGIN` to the exact planner origin (for example `https://YOUR-ACCOUNT.github.io`), and `CALLBACK_URL` to the same exact callback URL registered above. Use a dedicated origin if possible: other pages on the same origin have the same browser access. For local testing, use a separate Worker and GitHub App callback configured for the local Vite origin and path.
3. Generate a GitHub App client secret in its settings and store it as a Worker secret, **not** in Git, `wrangler.toml`, frontend variables, or logs. With Node.js installed, authenticate Wrangler and deploy:

   ```sh
   npx wrangler login
   npx wrangler secret put GITHUB_CLIENT_SECRET --config worker/wrangler.toml
   npx wrangler deploy --config worker/wrangler.toml
   ```

   Copy the deployed Worker URL. The Worker exchanges authorization codes only; it doesn't store planner data or tokens. Its origin check is a browser protection, not an abuse-prevention or authentication mechanism: public requests can still consume the free quota. Configure Cloudflare protections if needed.
4. In this repository's Settings → Secrets and variables → Actions → Variables, set `MEETUP_APP_CLIENT_ID`, `MEETUP_APP_SLUG` (from `github.com/apps/<slug>`) and `MEETUP_AUTH_URL` (the Worker URL), then redeploy Pages. These are public build values; never put the client secret or private key in them. Local development uses `VITE_GITHUB_APP_CLIENT_ID`, `VITE_GITHUB_APP_SLUG` and `VITE_GITHUB_AUTH_URL` in ignored `.env.local`.

### Connect your planner

1. In planner Settings choose **Install GitHub App**. To limit access to one repository, first create a private `meet-up-planner-data` repository on GitHub (initialize it with a README), then select only that repository during installation. Alternatively, grant access to all repositories and the app can attempt to create the private data repository; this gives the app access to your other repositories too. If the app is already installed, update its repository selection in GitHub settings as needed.
2. Choose **Connect GitHub** and authorize on GitHub. On return, the planner verifies the private repository and initializes `data/meetup-planner.json` or loads the existing data. If creation is denied or an existing repository is inaccessible, create/select it manually as above. The app never silently overwrites an existing conflicting planner.

The Worker is called during sign-in, including a browser preflight request; **sync requests go directly from the browser to GitHub**, not through Cloudflare. GitHub's API rate limits still apply. The Workers Free plan has a daily request limit; if exhausted, new sign-ins fail until the limit resets, while local planning remains available. Check [Cloudflare's current limits](https://developers.cloudflare.com/workers/platform/limits/) and ensure your account remains on the free plan if you do not want usage-based charges.

The GitHub App uses fine-grained app permissions instead of OAuth scopes. Its user access token stays in memory and is cleared on reload or sign-out, so sign in again in each new browser session. While signed in, changes save locally first and sync automatically after a short pause. Offline changes remain in IndexedDB and sync when the app is open and the connection returns; transient errors are retried. The sync status is shown in the app, and **Sync now** remains available. If another device changed the cloud copy, the app asks which version to keep rather than silently overwriting; it downloads a dated backup before replacing either copy. It does not merge planner records automatically.

## GitHub Pages

In repository Settings → Pages, select **GitHub Actions** as the source. Push to `main` or run the deployment workflow manually. It installs dependencies, lints, tests, builds with the repository-specific base path, and deploys the output. For other hosting, set `VITE_BASE_PATH` to the deployment path at build time (default `/`).

## Data and privacy

The planner stores friends, planning periods, time blocks and meet-ups in IndexedDB. Repository configuration and the most recently synced blob SHA are stored in localStorage. Data pushed to GitHub is a plain JSON file in your private repository and remains in its Git history. Do not use a public repository for personal data. Delete or revoke tokens in GitHub settings when no longer needed.
