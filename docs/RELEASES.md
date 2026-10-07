# Centralized source releases

Every push to `main` in an enrolled repository dispatches `release.yml` in `susanbeasles/delivery_control`. The receiver creates an annotated `vMAJOR.MINOR.PATCH` tag at the exact push SHA and publishes a stable GitHub release. This path is independent of repoctl and its broker.

## Version policy

| Commit messages since the preceding stable tag | Bump |
| --- | --- |
| Conventional `type!:` / `type(scope)!:` or `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer | Major |
| `feat:` or `feat(scope):` | Minor |
| All other messages, including docs/chore/fix and nonconventional text | Patch |

The highest bump wins. Initial version calculation uses `v0.0.0` and all commits through the first recorded push: a plain initial commit produces `v0.0.1`; a feature produces `v0.1.0`. Breaking changes increment major even before 1.0. Existing stable `vX.Y.Z` tags establish the baseline; prerelease and differently named tags are ignored. The manager never edits package versions, branches, existing tags, or published releases.

These are official **source releases**, with GitHub's source archives. Binary builds, signing, artifact upload, SBOM, and provenance remain a separate publishing pipeline. Do not treat these source releases as verification of executable assets.

## Credentials

Create a dedicated release GitHub App and install it on the personal account repositories to be released. Set repository permissions **Contents: write**, **Actions: read**, and the automatic **Metadata: read**. No webhook is required. If installing on all repositories, new repositories are covered by the App installation, but still need the caller workflow and dispatch secret.

In `delivery_control`, configure:

- Variable `RELEASE_APP_CLIENT_ID`: App client ID.
- Secret `RELEASE_APP_PRIVATE_KEY`: PEM private key, confined to this repository.

The receiver uses GitHub's official pinned `actions/create-github-app-token` action to issue a token narrowed to the requested source repository. The action revokes it at job completion. The private key never enters source repositories or source project scripts.

For cross-repository dispatch, ordinary source `GITHUB_TOKEN` is insufficient. Supply `RELEASE_DISPATCH_TOKEN` to each enrolled source repository: an independently managed credential restricted to **Actions: write on delivery_control only**. A fine-grained personal token with only that selected repository and permission is the simplest initial option. Use an expiry and rotate it. An externally issued short-lived App installation token can replace it; do not distribute the release App private key. The dispatch credential can affect central Actions; it is not a cryptographic proof of the sending repository. The receiver independently validates the referenced source run and main ancestry.

October 7 qualification confirmed repository admin/push access, but the central variable list and secret-name list are empty. The CLI credential cannot enumerate App installations (HTTP 403), and repository installation lookup requires App authentication (HTTP 401). App configuration and a disposable live release remain unverified.

## Install the receiver

Extract this bundle, then copy its receiver files into your existing `delivery_control` checkout. Preserve other workflows and executor files:

```sh
cd ~/code/delivery_control
cp /path/to/release-kit/src/releases.mjs src/releases.mjs
mkdir -p test docs templates
cp /path/to/release-kit/test/releases.test.mjs test/releases.test.mjs
cp /path/to/release-kit/docs/RELEASES.md docs/RELEASES.md
cp /path/to/release-kit/templates/auto-release.yml templates/auto-release.yml
cp /path/to/release-kit/.github/workflows/release.yml .github/workflows/release.yml
cp /path/to/release-kit/.github/workflows/test-releases.yml .github/workflows/test-releases.yml
node --test test/releases.test.mjs
git add src/releases.mjs test/releases.test.mjs docs/RELEASES.md templates/auto-release.yml .github/workflows/release.yml .github/workflows/test-releases.yml
git commit -S -m 'feat: add centralized automatic semver source releases'
```

Land that commit through your existing authorized promotion process. `workflow_dispatch` requires the receiver on the default branch, and this receiver accepts only `main`. Do not replace or bypass existing main protections to install it.

Configure the central variable and secret interactively, without pasting a key into command history:

```sh
gh variable set RELEASE_APP_CLIENT_ID --repo susanbeasles/delivery_control
gh secret set RELEASE_APP_PRIVATE_KEY --repo susanbeasles/delivery_control
```

## Enroll each repository

Install `templates/auto-release.yml` as `.github/workflows/auto-release.yml`, through the repository's normal signed commit and promotion process.

The template now calls workflow_depot's `request-release.yml` at the exact signed source revision `a99e0fe6a66ebffbcd33ca9921b53e0b069fc202`. Review that dependency before installing the caller and allow that pinned reusable workflow in each source repository's Actions policy. workflow_depot is currently public. The reusable workflow uses the caller's repository/SHA/run context; keep the `auto-release.yml` source filename because the receiver validates it. Pass only the dispatch credential through the explicit secret mapping, not `secrets: inherit`. No release App private key enters workflow_depot or source repositories.

Set the dispatch credential interactively:

```sh
gh secret set RELEASE_DISPATCH_TOKEN --repo susanbeasles/REPOSITORY
```

The workflow has no checkout, project code execution, package install, release key, or write permission to its own repository. It forwards repository name, numeric repository ID, push SHA, and its own run ID. Install it in `delivery_control` too if that repository should release itself.

Inventory all current account repositories, without assuming that installing on one enrolls all:

```sh
gh repo list susanbeasles --limit 1000 --json nameWithOwner,isArchived,isFork,defaultBranchRef \
  --jq '.[] | select(.isArchived == false and .isFork == false and .defaultBranchRef.name == "main") | .nameWithOwner'
```

Repositories with another default branch need an explicit policy adjustment; this kit intentionally releases `main` only. New repositories require this same caller and secret onboarding.

For repeatable account-wide enrollment, the bundled script previews all eligible repositories, then sets the scoped dispatch secret and opens a PR with a locally signed commit for each. It requires Python 3, `gh`, Git, and your existing signing configuration. It never merges PRs or bypasses rules; existing caller files and pending enrollment branches stop it for reconciliation. The App installation still needs access to each enrolled repository. Preview first:

```sh
python3 /path/to/release-kit/scripts/enroll.py
python3 /path/to/release-kit/scripts/enroll.py --apply
```

The second command requests the dispatch credential with hidden input; signing may require a YubiKey touch per repository. Partial enrollment is possible if a repository rejects a branch, signature, or secret update. Inspect the last repository before rerunning. This enrollment script has been syntax-checked but not executed against your account.

## Protection compatibility

Give the App authority to **create** release tags where tag-creation rules require it. Preserve separate no-bypass rules forbidding tag **update and deletion**. An App token does not automatically override rulesets. Do not give the App a bypass on the update/delete ruleset. The manager performs neither operation.

Enable GitHub immutable releases per repository using your existing settings/policy mechanism before publication if immutability is required. This workflow does not change administrative settings. Tags are annotated through GitHub's Git API; they are not cryptographically signed Git tags. Required signed tags would need a separate signing integration.

## Ordering, retries, and verification

The central receiver serializes by source repository with `queue: max`; GitHub caps the queue at 100 waiting runs and does not guarantee dispatch order. To handle ordinary reordering, the receiver lists recorded `auto-release.yml` main-push runs through the requested run number, sorts by source run number, and reconciles each pending push boundary. It validates all recorded boundaries against current main before writing. Multiple commits in one push produce one release; different pushes to the same SHA do not create duplicate versions.

A later dispatch can recover an earlier failed caller. Source workflow runs are the push-boundary record; deleting them can remove this coverage. This is not a durable event ledger. If the final dispatch fails, rerun it; if central execution fails, rerun the central run. Queue overflow, Actions outages, disabled workflows, pushes made with a repository `GITHUB_TOKEN` that suppresses push-triggered workflows, and missing enrollment require reconciliation. repoctl's promoter should use its App token so main push workflows fire.

No automatic retry follows an uncertain tag or release mutation. On rerun, the highest managed annotated tag is checked against its source SHA and numeric repository ID, then interrupted publication is resumed. Published releases are not rewritten. Unexpected tags, diverged history, inaccessible APIs, and invalid source identities fail visibly.

Use a disposable enrolled repository for the first real test:

1. Push `chore: initial` and confirm `v0.0.1` targets that SHA.
2. Push `feat: add example` and confirm `v0.1.0`.
3. Push `fix: correct example` and confirm `v0.1.1`.
4. Rerun the caller and receiver; confirm no new version appears.
5. Confirm tag-update/delete rules still reject mutations.

Local automated tests cover semver, source identity rejection, source ordering, duplicate requests, interrupted publication, pagination, and uncertain mutation behavior. A real App-backed end-to-end run remains required after configuration.

Official references: [App token action](https://github.com/actions/create-github-app-token), [GITHUB_TOKEN scope](https://docs.github.com/en/actions/concepts/security/github_token), [workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [concurrency queues](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency), and [immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
