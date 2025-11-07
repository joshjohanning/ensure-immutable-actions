# ensure-immutable-actions

[![GitHub release](https://img.shields.io/github/release/joshjohanning/ensure-immutable-actions.svg?logo=github&labelColor=333)](https://github.com/joshjohanning/ensure-immutable-actions/releases)
[![GitHub marketplace](https://img.shields.io/badge/marketplace-Ensure%20Immutable%20Actions-blue?logo=github&labelColor=333)](https://github.com/marketplace/actions/ensure-immutable-actions)
[![CI](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/ci.yml/badge.svg)](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/ci.yml)
[![Publish GitHub Action](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/publish.yml/badge.svg)](https://github.com/joshjohanning/ensure-immutable-actions/actions/workflows/publish.yml)
![Coverage](./badges/coverage.svg)

A GitHub Action that validates third-party actions in your workflows are using immutable releases, enhancing supply chain security.

## What it does

This action scans your workflow files and ensures that all third-party actions (excluding `actions/*` and `github/*` organizations) are referencing immutable releases. This prevents supply chain attacks where a release could be modified after you've started using it.

## Usage

### Check all workflows (default)

```yaml
name: Check Action Immutability
on:
  pull_request:
    paths:
      - '.github/workflows/**'
  push:
    branches:
      - main

jobs:
  check-immutable:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Ensure immutable actions
        uses: joshjohanning/ensure-immutable-actions@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Check specific workflows only

```yaml
- name: Ensure immutable actions
  uses: joshjohanning/ensure-immutable-actions@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    workflows: 'ci.yml,deploy.yml,release.yml'
```

### Check all except certain workflows

```yaml
- name: Ensure immutable actions
  uses: joshjohanning/ensure-immutable-actions@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    exclude-workflows: 'experimental.yml,temp-workflow.yml'
```

## Inputs

| Input                      | Description                                                                                                                                        | Required | Default       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| `github-token`             | GitHub token for API calls                                                                                                                         | Yes      | -             |
| `fail-on-mutable`          | Fail the workflow if mutable actions are found                                                                                                     | No       | `true`        |
| `workflows`                | Specific workflow files to check (comma-separated, e.g., `ci.yml,deploy.yml`). **If not specified, checks ALL workflows in `.github/workflows/`.** | No       | All workflows |
| `exclude-workflows`        | Workflow files to exclude from checks (comma-separated). Only applies when `workflows` is not specified.                                           | No       | -             |
| `check-reusable-workflows` | Also check reusable workflow files in `.github/workflows`                                                                                          | No       | `true`        |

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
    github-token: ${{ secrets.GITHUB_TOKEN }}
    fail-on-mutable: true # This is the default
```

### Report only (don't fail)

```yaml
- uses: joshjohanning/ensure-immutable-actions@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    fail-on-mutable: false
```

### Check only CI/CD workflows

```yaml
- uses: joshjohanning/ensure-immutable-actions@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    workflows: 'ci.yml,cd.yml,build.yml'
```

## How it Works

1. **Scans Workflows**: Reads all workflow files (or specified ones) from `.github/workflows/`
2. **Extracts Actions**: Parses YAML to find all `uses:` references to third-party actions
3. **Filters**: Excludes `actions/*` and `github/*` organizations (official GitHub actions)
4. **Checks Immutability**: For each third-party action:
   - Attempts to fetch the release via GitHub API
   - Checks the `immutable` property of the release
   - Reports actions without releases as mutable (e.g., major tags like `v3`)
5. **Reports Results**: Creates a summary with all findings
6. **Optionally Fails**: If `fail-on-mutable` is true, fails the workflow when mutable actions are found

## What are Immutable Releases?

Immutable releases are GitHub releases that cannot be modified or deleted after creation. This is a security feature that helps prevent supply chain attacks where an attacker could modify a release that your workflows depend on.

Actions using major version tags (like `v3`) or branch names typically don't have releases and are considered mutable since the underlying code can change. It's recommended to:

1. Use specific release tags (e.g., `v1.2.3`) with immutable releases
2. Or use commit SHAs (e.g., `abc123def456...`) for maximum security

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
