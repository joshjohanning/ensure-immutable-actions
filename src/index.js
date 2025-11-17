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
 * Check if an action should be excluded from checks (organizations that already publish immutable releases)
 * @param {string} owner - Action owner
 * @returns {boolean} True if should be excluded
 */
export function shouldExcludeAction(owner) {
  return owner === 'actions' || owner === 'github' || owner === 'octokit';
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
    const workflowFile = path.basename(workflowPath);

    const actions = [];
    const jobs = workflow?.jobs || {};

    for (const [jobName, job] of Object.entries(jobs)) {
      const steps = job?.steps || [];
      for (const step of steps) {
        if (step?.uses) {
          const parsed = parseActionReference(step.uses);
          if (parsed) {
            const isFirstParty = shouldExcludeAction(parsed.owner);
            actions.push({
              uses: step.uses,
              ...parsed,
              workflowFile,
              jobName,
              stepName: step.name || 'unnamed step',
              isFirstParty
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
 * Check if a reference is a full 40-character SHA
 * @param {string} ref - Git ref to check
 * @returns {boolean} True if ref is a 40-char SHA
 */
export function isFullSHA(ref) {
  return /^[a-f0-9]{40}$/i.test(ref);
}

/**
 * Format action reference with hyperlink to GitHub
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} ref - Git ref (tag, SHA, branch)
 * @returns {string} Markdown formatted action reference with link
 */
export function formatActionReference(owner, repo, ref) {
  const actionRef = `${owner}/${repo}@${ref}`;

  // SHAs already get hyperlinked by GitHub automatically, so just return plain text
  if (isFullSHA(ref)) {
    return actionRef;
  }

  // For tags and branches, create a hyperlink to the repository
  const url = `https://github.com/${owner}/${repo}/tree/${ref}`;
  return `[${actionRef}](${url})`;
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
  // Full 40-char SHAs are inherently immutable (cryptographic hash can't change)
  if (isFullSHA(ref)) {
    return {
      immutable: true,
      releaseFound: false,
      message: 'Immutable (full SHA reference)'
    };
  }

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
 * @returns {Promise<Object>} { mutable: Array, immutable: Array, firstParty: Array, byWorkflow: Object }
 */
export async function checkAllActions(octokit, actions) {
  const mutable = [];
  const immutable = [];
  const firstParty = [];
  const byWorkflow = {};

  // Separate first-party actions from third-party actions
  const thirdPartyActions = actions.filter(a => !a.isFirstParty);
  const firstPartyActions = actions.filter(a => a.isFirstParty);

  // Create a cache for immutability results
  const immutabilityCache = new Map();

  // Process first-party actions (no API check needed) - deduplicate by uses string
  const uniqueFirstPartyActions = Array.from(new Map(firstPartyActions.map(a => [a.uses, a])).values());
  for (const action of uniqueFirstPartyActions) {
    const actionInfo = {
      uses: action.uses,
      owner: action.owner,
      repo: action.repo,
      ref: action.ref,
      isFirstParty: true,
      immutable: true,
      releaseFound: false,
      message: 'First-party action'
    };
    firstParty.push(actionInfo);

    // Cache result for workflow grouping
    immutabilityCache.set(action.uses, {
      immutable: true,
      releaseFound: false,
      message: 'First-party action'
    });
  }

  // Deduplicate third-party actions by uses string for API calls, but preserve workflow info
  const uniqueActions = Array.from(new Map(thirdPartyActions.map(a => [a.uses, a])).values());

  for (const action of uniqueActions) {
    core.info(`Checking ${action.owner}/${action.repo}@${action.ref}...`);

    const result = await checkReleaseImmutability(octokit, action.owner, action.repo, action.ref);
    immutabilityCache.set(action.uses, result);

    const actionInfo = {
      uses: action.uses,
      owner: action.owner,
      repo: action.repo,
      ref: action.ref,
      isFirstParty: false,
      ...result
    };

    if (result.immutable) {
      immutable.push(actionInfo);
    } else {
      mutable.push(actionInfo);
    }
  }

  // Group all actions by workflow (deduplicate within each workflow)
  // First, group actions by workflow file
  const actionsByWorkflow = {};
  for (const action of actions) {
    const workflowFile = action.workflowFile;
    if (!actionsByWorkflow[workflowFile]) {
      actionsByWorkflow[workflowFile] = [];
    }
    actionsByWorkflow[workflowFile].push(action);
  }

  // Then, deduplicate within each workflow and categorize
  for (const [workflowFile, workflowActions] of Object.entries(actionsByWorkflow)) {
    byWorkflow[workflowFile] = { mutable: [], immutable: [], firstParty: [] };

    // Deduplicate by uses string within this workflow
    const uniqueWorkflowActions = Array.from(new Map(workflowActions.map(a => [a.uses, a])).values());

    for (const action of uniqueWorkflowActions) {
      const cachedResult = immutabilityCache.get(action.uses);
      const actionInfo = {
        uses: action.uses,
        owner: action.owner,
        repo: action.repo,
        ref: action.ref,
        workflowFile: action.workflowFile,
        isFirstParty: action.isFirstParty || false,
        ...cachedResult
      };

      if (action.isFirstParty) {
        byWorkflow[workflowFile].firstParty.push(actionInfo);
      } else if (cachedResult.immutable) {
        byWorkflow[workflowFile].immutable.push(actionInfo);
      } else {
        byWorkflow[workflowFile].mutable.push(actionInfo);
      }
    }
  }

  return { mutable, immutable, firstParty, byWorkflow };
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

    if (!githubToken) {
      core.setFailed('github-token is required (defaults to github.token)');
      return;
    }

    core.info('Starting Ensure Immutable Actions...');
    core.info(`Fail on mutable: ${failOnMutable}`);

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
      core.info(`  Found ${actions.length} action(s)`);
      allActions.push(...actions);
    }

    if (allActions.length === 0) {
      core.info('No actions found in workflows');
      core.setOutput('all-passed', true);
      core.setOutput('workflows-checked', JSON.stringify(workflowBasenames));
      core.setOutput('mutable-actions', '[]');
      core.setOutput('immutable-actions', '[]');

      // Create summary
      try {
        await core.summary
          .addHeading('✅ Immutable Actions Check - All Passed')
          .addRaw(`No actions found in checked workflows.`)
          .write();
      } catch {
        core.info('✅ All checks passed (no actions found)');
      }

      return;
    }

    core.info(`Total actions to check: ${allActions.length}`);

    // Initialize Octokit
    const octokit = new Octokit({ auth: githubToken });

    // Check all actions
    const { mutable, immutable, firstParty, byWorkflow } = await checkAllActions(octokit, allActions);

    // Set outputs
    core.setOutput('workflows-checked', JSON.stringify(workflowBasenames));
    core.setOutput('mutable-actions', JSON.stringify(mutable));
    core.setOutput('immutable-actions', JSON.stringify(immutable));
    core.setOutput('first-party-actions', JSON.stringify(firstParty));
    core.setOutput('all-passed', mutable.length === 0);

    // Create summary with separate tables per workflow
    try {
      let summary = core.summary;

      if (mutable.length === 0) {
        summary = summary.addHeading('✅ Immutable Actions Check - All Passed');
      } else {
        summary = summary.addHeading('❌ Immutable Actions Check - Failed');
      }

      summary = summary
        .addRaw(`\n**Workflows Checked:** ${workflowBasenames.join(', ')}\n\n`)
        .addRaw(
          `**Summary:** ${firstParty.length} first-party, ${immutable.length} immutable, ${mutable.length} mutable\n\n`
        );

      // Add a table for each workflow
      for (const workflowFile of workflowBasenames) {
        const workflowData = byWorkflow[workflowFile];

        if (
          !workflowData ||
          (workflowData.immutable.length === 0 &&
            workflowData.mutable.length === 0 &&
            workflowData.firstParty.length === 0)
        ) {
          continue;
        }

        const workflowMutableCount = workflowData.mutable.length;
        const workflowImmutableCount = workflowData.immutable.length;
        const workflowFirstPartyCount = workflowData.firstParty.length;
        const workflowStatus = workflowMutableCount === 0 ? '✅' : '❌';

        summary = summary.addHeading(`${workflowStatus} ${workflowFile}`, 3);
        summary = summary.addRaw(
          `**Actions:** ${workflowFirstPartyCount} first-party, ${workflowImmutableCount} immutable, ${workflowMutableCount} mutable\n\n`
        );

        // Build markdown table
        let markdownTable = '| Action | Status | Message |\n';
        markdownTable += '|--------|--------|----------|\n';

        // Sort: first-party first, then immutable, then mutable
        const workflowActions = [...workflowData.firstParty, ...workflowData.immutable, ...workflowData.mutable];
        const sortedActions = workflowActions.sort((a, b) => {
          if (a.isFirstParty && !b.isFirstParty) return -1;
          if (!a.isFirstParty && b.isFirstParty) return 1;
          if (a.immutable === b.immutable) return 0;
          return a.immutable ? -1 : 1;
        });

        for (const action of sortedActions) {
          let status;
          let message;
          if (action.isFirstParty) {
            status = '✅ First-party';
            message = action.message;
          } else if (action.immutable) {
            status = '✅ Immutable';
            message = action.message;
          } else {
            status = '❌ Mutable';
            message = action.message;
          }
          const actionRef = formatActionReference(action.owner, action.repo, action.ref);
          markdownTable += `| ${actionRef} | ${status} | ${message} |\n`;
        }

        summary = summary.addRaw(markdownTable).addRaw('\n');
      }

      await summary.write();
    } catch {
      // Fallback for local development
      core.info('📊 Immutable Actions Check Results:');
      core.info(`   Workflows: ${workflowBasenames.join(', ')}`);
      core.info(`   First-party: ${firstParty.length}`);
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
