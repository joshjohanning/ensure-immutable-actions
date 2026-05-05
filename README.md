# ensure-immutable-actions

[![GitHub release](https://img.shields.io/github/release/joshjohanning/ensure-immutable-actions.svg?logo=github&labelColor=333)](https://github.com/joshjohanning/ensure-immutable-actions/releases)
[![Immutable Releases](https://img.shields.io/badge/releases-immutable-blue?labelColor=333)](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases)
[![GitHub marketplace](https://img.shields.io/badge/marketplace-Ensure%20Immutable%20Actions-blue?logo=github&labelColor=333)](https://github.com/marketplace/actions/ensure-immutable-actions)
[![CI](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/ci.yml/badge.svg)](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/ci.yml)
[![Publish GitHub Action](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/publish.yml/badge.svg)](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/publish.yml)
![Coverage](./badges/coverage.svg)

A GitHub Action that validates third-party actions in your workflows are using immutable releases, enhancing supply chain security.

## What's new

Please refer to the [release page](https://github.com/joshjohanning/ensure-immutable-actions/releases) for the latest release notes.

## What it does

This action scans your workflow files and validates that third-party actions are using [immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-immutable-releases), which prevents supply chain attacks where a release could be modified after you've started using it. First-party actions (`actions/*`, `github/*`, and `octokit/*`) are excluded from checks by default, but can be included via the `include-first-party` input.

The scan covers:

- **Step-level actions** (`steps[].uses`)
- **Job-level reusable workflows** (`jobs.<id>.uses`)
- **Local composite actions** — recursively scans nested `uses` references inside composite actions in your repository
- **Remote composite actions and reusable workflows** — recursively fetches and scans nested `uses` references from external repositories

## Example Output

The action generates a report organized by workflow, making it easy to identify which workflows need attention:

### ✅ ci.yml

**Actions:** 2 excluded, 1 immutable, 0 mutable

| Action                                                         | Status         | Message                |
| -------------------------------------------------------------- | -------------- | ---------------------- |
| actions/checkout@v4                                            | ✅ First-party | Excluded (first-party) |
| actions/setup-node@v4                                          | ✅ First-party | Excluded (first-party) |
| [owner/repo@v1.2.3](https://github.com/owner/repo/tree/v1.2.3) | ✅ Immutable   | Immutable release      |

### ❌ deploy.yml

**Actions:** 0 excluded, 1 immutable, 2 mutable

| Action                                                                             | Status       | Message                             |
| ---------------------------------------------------------------------------------- | ------------ | ----------------------------------- |
| [owner/secure-action@v2.0.0](https://github.com/owner/secure-action/tree/v2.0.0)   | ✅ Immutable | Immutable release                   |
| [owner/mutable-action@v1](https://github.com/owner/mutable-action/tree/v1)         | ❌ Mutable   | No release found for this reference |
| [owner/another-action@v2.1.0](https://github.com/owner/another-action/tree/v2.1.0) | ❌ Mutable   | Mutable release                     |

## Usage

### Check all workflows (default)

```yaml
name: Check Action Immutability
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  check-immutable:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Ensure immutable actions
        uses: joshjohanning/ensure-immutable-actions@v2
```

### Check specific workflows only

```yaml
- name: Ensure immutable actions
  uses: joshjohanning/ensure-immutable-actions@v2
  with:
    workflows: 'ci.yml,deploy.yml,release.yml'
```

### Check workflows matching a glob pattern

```yaml
- name: Ensure immutable actions
  uses: joshjohanning/ensure-immutable-actions@v2
  with:
    workflows: 'deploy-*.yml'
```

### Check all except certain workflows

```yaml
- name: Ensure immutable actions
  uses: joshjohanning/ensure-immutable-actions@v2
  with:
    exclude-workflows: 'experimental.yml,temp-workflow.yml'
```

### Exclude workflows matching a glob pattern

```yaml
- name: Ensure immutable actions
  uses: joshjohanning/ensure-immutable-actions@v2
  with:
    exclude-workflows: 'experimental-*.yml'
```

## Inputs

| Input                 | Description                                                                                                                                                                                                                                    | Required | Default               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| `github-token`        | GitHub token for API calls. The default `github.token` works for public repos. For recursion into private/internal repos, use a PAT or GitHub App token with `contents: read` scope.                                                           | Yes      | `${{ github.token }}` |
| `fail-on-mutable`     | Fail the workflow if mutable actions are found                                                                                                                                                                                                 | No       | `true`                |
| `workflows`           | Specific workflow files to check (comma-separated filenames or glob patterns, e.g., `ci.yml,deploy-*.yml`). **If not specified, checks ALL workflows in `.github/workflows/`.**                                                                | No       | All workflows         |
| `exclude-workflows`   | Workflow files to exclude from checks (comma-separated filenames or glob patterns, e.g., `experimental-*.yml`).                                                                                                                                | No       | -                     |
| `include-first-party` | Include first-party actions (`actions/*`, `github/*`, `octokit/*`) in immutability checks. When `true`, first-party actions are also checked and appear in `mutable-actions`/`immutable-actions` outputs in addition to `first-party-actions`. | No       | `false`               |

## Outputs

| Output                | Description                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `mutable-actions`     | JSON array of actions using mutable releases                                                                 |
| `immutable-actions`   | JSON array of actions using immutable releases                                                               |
| `unsupported-actions` | JSON array of action references that were found but not analyzed because their reference type is unsupported |
| `first-party-actions` | JSON array of all first-party actions with `allowed` and `message` fields indicating their status.           |
| `all-passed`          | Boolean indicating if all checks passed                                                                      |
| `workflows-checked`   | List of workflow files that were checked                                                                     |

## Examples

### Fail on any mutable action

```yaml
- uses: joshjohanning/ensure-immutable-actions@v2
  with:
    fail-on-mutable: true # This is the default
```

### Report only (don't fail)

```yaml
- uses: joshjohanning/ensure-immutable-actions@v2
  with:
    fail-on-mutable: false
```

### Check only CI/CD workflows

```yaml
- uses: joshjohanning/ensure-immutable-actions@v2
  with:
    workflows: 'ci.yml,cd.yml,build.yml'
```

### Include first-party actions in checks

```yaml
- uses: joshjohanning/ensure-immutable-actions@v2
  with:
    include-first-party: true
```

## How it Works

1. **Scans Workflows**: Reads all workflow files (or specified ones) from `.github/workflows/`
2. **Extracts Actions**: Parses YAML to find all `uses:` references at both the step level and job level (reusable workflows)
3. **Recurses into Composite Actions**: Follows local and remote composite actions and reusable workflows to find nested third-party action references
4. **Filters**: Excludes `actions/*`, `github/*`, and `octokit/*` organizations by default (configurable via `include-first-party`)
5. **Checks Immutability**: For each action not excluded by filters:
   - **Full 40-character SHA references** (e.g., `user/action@abc123...def`) are considered inherently immutable (no API check needed)
   - For tag/branch references, attempts to fetch the release via GitHub API
   - Checks the `immutable` property of the release
   - Reports actions without releases as mutable (e.g., major tags like `v3`, non-immutable SemVer releases, and branch references)
6. **Reports Unsupported References**: Surfaces unsupported reference types such as local actions and `docker://` references separately from mutable/immutable findings
7. **Reports Results**: Creates a summary with all findings, including the source workflow file for each finding
8. **Optionally Fails**: If `fail-on-mutable` is true, fails the workflow when mutable actions are found

> [!NOTE]
> This action always checks immutability against the github.com API since that is the provenance for marketplace actions. It is not designed for use with GHES API URLs.

> [!NOTE]
> Recursion into remote composite actions and reusable workflows uses the `github-token` to fetch file contents via the GitHub API. The default `GITHUB_TOKEN` only has `contents: read` access to the triggering repository — remote references in private or internal repositories may not be readable and can be reported as unsupported in the action output/summary. To enable full recursion across private repos, provide a token with broader `contents: read` scope, such as a GitHub App token:
>
> ```yaml
> - uses: actions/create-github-app-token@v2
>   id: app-token
>   with:
>     app-id: ${{ vars.APP_ID }}
>     private-key: ${{ secrets.APP_PRIVATE_KEY }}
>     owner: ${{ github.repository_owner }}
>
> - uses: joshjohanning/ensure-immutable-actions@v2
>   with:
>     github-token: ${{ steps.app-token.outputs.token }}
> ```

## What's Considered Immutable?

- ✅ **Full 40-character SHA**: `user/action@1234567890abcdef1234567890abcdef12345678` - Cryptographic hash that cannot change
- ✅ **Immutable release tags**: Release tags that have been marked as immutable via GitHub API
- ✅ **Actions from trusted organizations**: `actions/*`, `github/*`, and `octokit/*` organizations [already publish immutable releases](https://github.com/github/codeql/blob/main/actions/ql/extensions/immutable-actions-list/ext/immutable_actions.yml) and are excluded from checks by default (configurable via `include-first-party`)
- ❌ **Mutable release tags**: Release tags that can still be modified or deleted
- ❌ **Branch references**: `user/action@main` - Branches are always mutable
- ❌ **Major version tags**: `user/action@v1` - Typically don't have releases, can be moved

## What are Immutable Releases?

Immutable releases are GitHub releases that have been marked with an `immutable` flag, indicating they cannot be modified or deleted. This is a GitHub feature that helps prevent supply chain attacks where an attacker could modify a release that your workflows depend on.

When checking actions:

- **Tags with immutable releases**: ✅ Most secure - the release content cannot be changed
- **Tags with mutable releases**: ⚠️ Release exists but could be modified
- **Tags without releases**: ❌ No release found - typical for major version tags like `v3`
- **Commit SHAs**: ⚠️ No releases (SHAs are inherently immutable in Git)
- **Branch names**: ❌ Not recommended - content can change

**Best practices for supply chain security:**

1. Use specific release tags (e.g., `v1.2.3`) with immutable releases
2. Or use commit SHAs (e.g., `abc123def456...`) for maximum security
3. Avoid major version tags (like `v3`) as they typically don't have releases and point to mutable branches

## Development

### Setup

```bash
git clone https://github.com/joshjohanning/ensure-immutable-actions.git
cd ensure-immutable-actions
npm install
```

### Available Scripts

- `npm test` - Run Jest tests
- `npm run lint` - Run ESLint
- `npm run format:write` - Format code with Prettier
- `npm run package` - Bundle the action with ncc
- `npm run all` - Run format, lint, test, coverage, and package

### Testing Locally

You can test the action locally using `env` to set input variables (hyphens are preserved in the env var names):

```bash
export GITHUB_WORKSPACE="/path/to/your/repo"
env 'INPUT_GITHUB-TOKEN=ghp_your_token_here' 'INPUT_FAIL-ON-MUTABLE=true' 'INPUT_WORKFLOWS=ci.yml' node src/index.js
```

## License

MIT - See [LICENSE](LICENSE) for details
