# GitHub App sync handoff

## What changed

- GitHub sync now authenticates with the GitHub App Device Flow. The user access token stays in memory and must be obtained again after reloading the app.
- The app can create the user's private `meet-up-planner-data` repository and initialize `data/meetup-planner.json`. If repository creation is unavailable, the user can create a private repository and grant the app access manually.
- Changes save locally first and sync automatically when online. Offline changes remain local for retry. The app detects cloud conflicts rather than silently overwriting data and offers a dated backup before replacing a version.
- The Pages workflow passes public build configuration to Vite. It reads `MEETUP_APP_CLIENT_ID` and `MEETUP_APP_SLUG` and maps them to `VITE_GITHUB_APP_CLIENT_ID` and `VITE_GITHUB_APP_SLUG`. Do not name Actions variables with the reserved `GITHUB_` prefix.

## Before merging and deploying

1. In the repository's **Settings → Secrets and variables → Actions → Variables**, add:
   - `MEETUP_APP_CLIENT_ID`: the GitHub App client ID.
   - `MEETUP_APP_SLUG`: the slug in the app's GitHub URL.
2. Confirm the GitHub App has Device Flow enabled and requests **Contents: Read and write**. Also enable **Repository creation: Read and write** if the app should create the private data repository.
3. Confirm the app homepage points to the deployed planner, webhooks are disabled, and the app can be installed on the user's account.
4. Merge the PR to `main` after review and passing checks. The Pages workflow deploys on a push to `main`; confirm the repository's Pages source is set to **GitHub Actions**.

The client ID and app slug are public build configuration. Do not add the app client secret or private key to the frontend, repository variables, or any other client-side configuration.

## Verification

Lint, all 16 tests, and the production build passed for the implementation. Secret scanning found no secrets, and CodeQL reported no alerts.

After deployment, verify the live flow with a test planner: install the app, connect through Device Flow, confirm a private data repository and planner JSON are created (or use a manually created private repository), then reload and reconnect to verify the local data still appears and sync resumes. Also check the GitHub Actions Pages deployment completed successfully.

## Known behavior

- Sign-in is session-only; reconnect after page reload.
- Planner records are not automatically merged when a conflict is detected. Choose the local or cloud copy deliberately.
- Repository creation depends on the GitHub App's granted permissions; manual private repository setup is the fallback.
