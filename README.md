# ensure-immutable-actions

[![GitHub release](https://img.shields.io/github/release/joshjohanning/ensure-immutable-actions.svg?logo=github&labelColor=333)](https://github.com/joshjohanning/ensure-immutable-actions/releases)
[![Immutable Releases](https://img.shields.io/badge/releases-immutable-blue?labelColor=333)](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases)
[![GitHub marketplace](https://img.shields.io/badge/marketplace-Ensure%20Immutable%20Actions-blue?logo=github&labelColor=333)](https://github.com/marketplace/actions/ensure-immutable-actions)
[![CI](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/ci.yml/badge.svg)](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/ci.yml)
[![Publish GitHub Action](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/publish.yml/badge.svg)](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/publish.yml)
![Coverage](./badges/coverage.svg)

A GitHub Action that validates third-party actions in your workflows are using immutable releases, enhancing supply chain security.

## What it does

This action scans your workflow files and ensures that all third-party actions (excluding `actions/*`, `github/*`, and `octokit/*` organizations which already publish immutable releases) are referencing immutable releases. This prevents supply chain attacks where a release could be modified after you've started using it.

## Example Output

The action generates a report organized by workflow, making it easy to identify which workflows need attention:

### ✅ ci.yml

**Actions:** 2 first-party, 1 immutable, 0 mutable

| Action                                                         | Status         | Message            |
| -------------------------------------------------------------- | -------------- | ------------------ |
| actions/checkout@v4                                            | ✅ First-party | First-party action |
| actions/setup-node@v4                                          | ✅ First-party | First-party action |
| [owner/repo@v1.2.3](https://github.com/owner/repo/tree/v1.2.3) | ✅ Immutable   | Immutable release  |

### ❌ deploy.yml

**Actions:** 0 first-party, 1 immutable, 2 mutable

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
      - uses: actions/checkout@v5

      - name: Ensure immutable actions
        uses: joshjohanning/ensure-immutable-actions@v1
```

### Check specific workflows only

```yaml
- name: Ensure immutable actions
  uses: joshjohanning/ensure-immutable-actions@v1
  with:
    workflows: 'ci.yml,deploy.yml,release.yml'
```

### Check all except certain workflows

```yaml
- name: Ensure immutable actions
  uses: joshjohanning/ensure-immutable-actions@v1
  with:
    exclude-workflows: 'experimental.yml,temp-workflow.yml'
```

## Inputs

| Input               | Description                                                                                                                                        | Required | Default               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| `github-token`      | GitHub token for API calls                                                                                                                         | Yes      | `${{ github.token }}` |
| `fail-on-mutable`   | Fail the workflow if mutable actions are found                                                                                                     | No       | `true`                |
| `workflows`         | Specific workflow files to check (comma-separated, e.g., `ci.yml,deploy.yml`). **If not specified, checks ALL workflows in `.github/workflows/`.** | No       | All workflows         |
| `exclude-workflows` | Workflow files to exclude from checks (comma-separated). Only applies when `workflows` is not specified.                                           | No       | -                     |

## Outputs

| Output              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `mutable-actions`   | JSON array of actions using mutable releases   |
| `immutable-actions` | JSON array of actions using immutable releases |
| `all-passed`        | Boolean indicating if all checks passed        |
| `workflows-checked` | List of workflow files that were checked       |

## Examples

### Fail on any mutable action

```yaml
- uses: joshjohanning/ensure-immutable-actions@v1
  with:
    fail-on-mutable: true # This is the default
```

### Report only (don't fail)

```yaml
- uses: joshjohanning/ensure-immutable-actions@v1
  with:
    fail-on-mutable: false
```

### Check only CI/CD workflows

```yaml
- uses: joshjohanning/ensure-immutable-actions@v1
  with:
    workflows: 'ci.yml,cd.yml,build.yml'
```

## How it Works

1. **Scans Workflows**: Reads all workflow files (or specified ones) from `.github/workflows/`
2. **Extracts Actions**: Parses YAML to find all `uses:` references to third-party actions
3. **Filters**: Excludes `actions/*`, `github/*`, and `octokit/*` organizations (these already publish immutable releases)
4. **Checks Immutability**: For each third-party action:
   - **Full 40-character SHA references** (e.g., `user/action@abc123...def`) are considered inherently immutable (no API check needed)
   - For tag/branch references, attempts to fetch the release via GitHub API
   - Checks the `immutable` property of the release
   - Reports actions without releases as mutable (e.g., major tags like `v3`, non-immutable SemVer releases, and branch references)
5. **Reports Results**: Creates a summary with all findings
6. **Optionally Fails**: If `fail-on-mutable` is true, fails the workflow when mutable actions are found

## What's Considered Immutable?

- ✅ **Full 40-character SHA**: `user/action@1234567890abcdef1234567890abcdef12345678` - Cryptographic hash that cannot change
- ✅ **Immutable release tags**: Release tags that have been marked as immutable via GitHub API
- ✅ **Actions from trusted organizations**: `actions/*`, `github/*`, and `octokit/*` organizations [already publish immutable releases](https://github.com/github/codeql/blob/main/actions/ql/extensions/immutable-actions-list/ext/immutable_actions.yml) and are excluded from checks
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

You can test the action locally by setting environment variables:

```bash
export INPUT_GITHUB_TOKEN="ghp_your_token_here"
export INPUT_FAIL_ON_MUTABLE="true"
export INPUT_WORKFLOWS="ci.yml"
export GITHUB_WORKSPACE="/path/to/your/repo"
node src/index.js
```

## License

MIT - See [LICENSE](LICENSE) for details
