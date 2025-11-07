/**
 * Ensure Immutable Actions GitHub Action
 * Validates that third-party actions in workflows are using immutable releases
 *
 * Local Development & Testing:
 *
 * 1. Set environment variables to simulate GitHub Actions inputs:
 *    export INPUT_GITHUB_TOKEN="ghp_your_token_here"
 *    export INPUT_FAIL_ON_MUTABLE="true"
 *    export INPUT_WORKFLOWS="ci.yml,deploy.yml"  # Optional: specific workflows
 *    export INPUT_EXCLUDE_WORKFLOWS="experimental.yml"  # Optional: workflows to exclude
 *    export INPUT_CHECK_REUSABLE_WORKFLOWS="true"
 *
 * 2. Set GitHub context environment variables:
 *    export GITHUB_REPOSITORY="owner/repo-name"
 *    export GITHUB_WORKSPACE="/path/to/repo"
 *
 * 3. Run locally:
 *    node src/index.js
 */

import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';

/**
 * Get input value (works reliably in both GitHub Actions and local environments)
 * @param {string} name - Input name (with dashes)
 * @returns {string} Input value
 */
export function getInput(name) {
  // Try core.getInput first (works in GitHub Actions)
  let value = core.getInput(name);

  // Fallback: try direct environment variable access (for local development)
  if (!value) {
    const envName = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
    value = process.env[envName] || '';
  }

  return value;
}

/**
 * Convert string input to boolean (more permissive than core.getBooleanInput)
 * @param {string} name - Input name
 * @returns {boolean} Boolean value
 */
export function getBooleanInput(name) {
  const input = getInput(name).toLowerCase();
  return input === 'true' || input === '1' || input === 'yes';
}

/**
 * Parse action reference from uses: field
 * @param {string} uses - The uses string (e.g., "actions/checkout@v4" or "owner/repo/path@ref")
 * @returns {Object|null} Parsed action { owner, repo, ref } or null if invalid
 */
export function parseActionReference(uses) {
  if (!uses || typeof uses !== 'string') {
    return null;
  }

  // Skip local actions (starting with ./)
  if (uses.startsWith('./')) {
    return null;
  }

  // Handle docker:// and other special formats
  if (uses.includes('://')) {
    return null;
  }

  // Parse format: owner/repo@ref or owner/repo/path@ref
  const match = uses.match(/^([^/]+)\/([^/@]+)(?:\/[^@]*)?@(.+)$/);
  if (!match) {
    return null;
  }

  const [, owner, repo, ref] = match;
  return { owner, repo, ref };
}

/**
 * Check if an action should be excluded from checks (GitHub and actions orgs)
 * @param {string} owner - Action owner
 * @returns {boolean} True if should be excluded
 */
export function shouldExcludeAction(owner) {
  return owner === 'actions' || owner === 'github';
}

/**
 * Extract all action references from a workflow file
 * @param {string} workflowPath - Path to workflow YAML file
 * @returns {Array} Array of action references
 */
export function extractActionsFromWorkflow(workflowPath) {
  try {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const workflow = YAML.parse(content);

    const actions = [];
    const jobs = workflow?.jobs || {};

    for (const [jobName, job] of Object.entries(jobs)) {
      const steps = job?.steps || [];
      for (const step of steps) {
        if (step?.uses) {
          const parsed = parseActionReference(step.uses);
          if (parsed && !shouldExcludeAction(parsed.owner)) {
            actions.push({
              uses: step.uses,
              ...parsed,
              jobName,
              stepName: step.name || 'unnamed step'
            });
          }
        }
      }
    }

    return actions;
  } catch (error) {
    core.warning(`Failed to parse workflow ${workflowPath}: ${error.message}`);
    return [];
  }
}

/**
 * Get list of workflow files to check
 * @param {string} workflowsInput - Comma-separated workflow files (optional)
 * @param {string} excludeWorkflowsInput - Comma-separated workflows to exclude (optional)
 * @param {string} workspaceDir - Workspace directory path
 * @returns {Array<string>} Array of workflow file paths
 */
export function getWorkflowFiles(workflowsInput, excludeWorkflowsInput, workspaceDir) {
  const workflowsDir = path.join(workspaceDir, '.github', 'workflows');

  if (!fs.existsSync(workflowsDir)) {
    core.warning(`Workflows directory not found: ${workflowsDir}`);
    return [];
  }

  let workflowFiles = [];

  if (workflowsInput) {
    // Check specific workflows
    const specified = workflowsInput
      .split(',')
      .map(w => w.trim())
      .filter(Boolean);
    for (const workflow of specified) {
      const fullPath = path.join(workflowsDir, workflow);
      if (fs.existsSync(fullPath)) {
        workflowFiles.push(fullPath);
      } else {
        core.warning(`Specified workflow file not found: ${workflow}`);
      }
    }
  } else {
    // Get all workflow files
    const allFiles = fs.readdirSync(workflowsDir);
    workflowFiles = allFiles
      .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map(f => path.join(workflowsDir, f));

    // Apply exclusions
    if (excludeWorkflowsInput) {
      const excludes = excludeWorkflowsInput
        .split(',')
        .map(w => w.trim())
        .filter(Boolean);
      workflowFiles = workflowFiles.filter(f => {
        const basename = path.basename(f);
        return !excludes.includes(basename);
      });
    }
  }

  return workflowFiles;
}

/**
 * Check if a release is immutable via GitHub API
 * Note: The 'immutable' property is a GitHub feature that indicates whether a release
 * can be modified or deleted. This only applies to tag-based releases.
 * @param {Octokit} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} ref - Git ref (tag, SHA, branch) - only tags can have releases
 * @returns {Promise<Object>} { immutable: boolean, releaseFound: boolean, message: string }
 */
export async function checkReleaseImmutability(octokit, owner, repo, ref) {
  try {
    // Try to get release by tag
    // Note: getReleaseByTag only works with tag names, not SHAs or branches
    const { data: release } = await octokit.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag: ref
    });

    // Check if immutable property exists and is true
    // The 'immutable' property is returned by the GitHub API when a release
    // has been marked as immutable (cannot be modified or deleted)
    const isImmutable = release.immutable === true;

    return {
      immutable: isImmutable,
      releaseFound: true,
      message: isImmutable ? 'Immutable release' : 'Mutable release'
    };
  } catch (error) {
    if (error.status === 404) {
      // No release found for this tag
      // This is expected for: commit SHAs, branch names, or tags without releases
      return {
        immutable: false,
        releaseFound: false,
        message: 'No release found for this reference'
      };
    }

    // Other API errors
    core.warning(`API error checking ${owner}/${repo}@${ref}: ${error.message}`);
    return {
      immutable: false,
      releaseFound: false,
      message: `API error: ${error.message}`
    };
  }
}

/**
 * Check all actions from workflows
 * @param {Octokit} octokit - Octokit instance
 * @param {Array} actions - Array of action references
 * @returns {Promise<Object>} { mutable: Array, immutable: Array }
 */
export async function checkAllActions(octokit, actions) {
  const mutable = [];
  const immutable = [];

  // Deduplicate actions by uses string
  const uniqueActions = Array.from(new Map(actions.map(a => [a.uses, a])).values());

  for (const action of uniqueActions) {
    core.info(`Checking ${action.owner}/${action.repo}@${action.ref}...`);

    const result = await checkReleaseImmutability(octokit, action.owner, action.repo, action.ref);

    const actionInfo = {
      uses: action.uses,
      owner: action.owner,
      repo: action.repo,
      ref: action.ref,
      ...result
    };

    if (result.immutable) {
      immutable.push(actionInfo);
    } else {
      mutable.push(actionInfo);
    }
  }

  return { mutable, immutable };
}

/**
 * Main action logic
 */
export async function run() {
  try {
    // Get inputs
    const githubToken = getInput('github-token');
    const failOnMutable = getBooleanInput('fail-on-mutable');
    const workflowsInput = getInput('workflows');
    const excludeWorkflowsInput = getInput('exclude-workflows');
    // Note: check-reusable-workflows is read for logging but all .yml/.yaml files
    // in .github/workflows are checked by default (reusable workflows are just
    // regular workflow files that can be called from other workflows)
    const checkReusableWorkflows = getBooleanInput('check-reusable-workflows');

    if (!githubToken) {
      core.setFailed('github-token is required');
      return;
    }

    core.info('Starting Ensure Immutable Actions...');
    core.info(`Fail on mutable: ${failOnMutable}`);
    core.info(`Check reusable workflows: ${checkReusableWorkflows}`);

    // Get workspace directory
    const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
    core.info(`Workspace directory: ${workspaceDir}`);

    // Get workflow files to check
    const workflowFiles = getWorkflowFiles(workflowsInput, excludeWorkflowsInput, workspaceDir);

    if (workflowFiles.length === 0) {
      core.warning('No workflow files found to check');
      core.setOutput('all-passed', true);
      core.setOutput('workflows-checked', '[]');
      core.setOutput('mutable-actions', '[]');
      core.setOutput('immutable-actions', '[]');
      return;
    }

    core.info(`Found ${workflowFiles.length} workflow file(s) to check`);
    const workflowBasenames = workflowFiles.map(f => path.basename(f));
    core.info(`Workflows: ${workflowBasenames.join(', ')}`);

    // Extract all actions from workflows
    const allActions = [];
    for (const workflowFile of workflowFiles) {
      const basename = path.basename(workflowFile);
      core.info(`Parsing workflow: ${basename}`);
      const actions = extractActionsFromWorkflow(workflowFile);
      core.info(`  Found ${actions.length} third-party action(s)`);
      allActions.push(...actions);
    }

    if (allActions.length === 0) {
      core.info('No third-party actions found in workflows');
      core.setOutput('all-passed', true);
      core.setOutput('workflows-checked', JSON.stringify(workflowBasenames));
      core.setOutput('mutable-actions', '[]');
      core.setOutput('immutable-actions', '[]');

      // Create summary
      try {
        await core.summary
          .addHeading('✅ Immutable Actions Check - All Passed')
          .addRaw(`No third-party actions found in checked workflows.`)
          .write();
      } catch {
        core.info('✅ All checks passed (no third-party actions found)');
      }

      return;
    }

    core.info(`Total actions to check: ${allActions.length}`);

    // Initialize Octokit
    const octokit = new Octokit({ auth: githubToken });

    // Check all actions
    const { mutable, immutable } = await checkAllActions(octokit, allActions);

    // Set outputs
    core.setOutput('workflows-checked', JSON.stringify(workflowBasenames));
    core.setOutput('mutable-actions', JSON.stringify(mutable));
    core.setOutput('immutable-actions', JSON.stringify(immutable));
    core.setOutput('all-passed', mutable.length === 0);

    // Create summary table
    const summaryRows = [
      [
        { data: 'Action', header: true },
        { data: 'Status', header: true },
        { data: 'Message', header: true }
      ]
    ];

    // Add immutable actions
    for (const action of immutable) {
      summaryRows.push([`${action.owner}/${action.repo}@${action.ref}`, '✅ Immutable', action.message]);
    }

    // Add mutable actions
    for (const action of mutable) {
      summaryRows.push([`${action.owner}/${action.repo}@${action.ref}`, '❌ Mutable', action.message]);
    }

    // Create summary
    try {
      let summary = core.summary;

      if (mutable.length === 0) {
        summary = summary.addHeading('✅ Immutable Actions Check - All Passed');
      } else {
        summary = summary.addHeading('❌ Immutable Actions Check - Failed');
      }

      summary = summary
        .addRaw(`\n**Workflows Checked:** ${workflowBasenames.join(', ')}\n\n`)
        .addRaw(`**Summary:** ${immutable.length} immutable, ${mutable.length} mutable\n\n`)
        .addTable(summaryRows);

      await summary.write();
    } catch {
      // Fallback for local development
      core.info('📊 Immutable Actions Check Results:');
      core.info(`   Workflows: ${workflowBasenames.join(', ')}`);
      core.info(`   Immutable: ${immutable.length}`);
      core.info(`   Mutable: ${mutable.length}`);
    }

    // Log results
    if (immutable.length > 0) {
      core.info(`\n✅ ${immutable.length} action(s) using immutable releases:`);
      for (const action of immutable) {
        core.info(`   - ${action.owner}/${action.repo}@${action.ref}`);
      }
    }

    if (mutable.length > 0) {
      core.warning(`\n❌ ${mutable.length} action(s) using mutable releases:`);
      for (const action of mutable) {
        core.warning(`   - ${action.owner}/${action.repo}@${action.ref} (${action.message})`);
      }
    }

    // Fail if needed
    if (failOnMutable && mutable.length > 0) {
      core.setFailed(
        `Found ${mutable.length} action(s) using mutable releases. ` +
          `Please use immutable releases for supply chain security.`
      );
    } else if (mutable.length === 0) {
      core.info('\n✅ All third-party actions are using immutable releases!');
    }
  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

// Execute the action (only when run directly, not when imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}

// Export as default for testing
export default run;
