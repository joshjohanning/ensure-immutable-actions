/**
 * Ensure Immutable Actions GitHub Action
 * Validates that third-party actions in workflows are using immutable releases
 *
 * Local Development & Testing:
 *
 * Uses core.getInput() which reads INPUT_<NAME> env vars (hyphens preserved).
 * Since shell variables can't contain hyphens, set these via env(1):
 *
 *    env 'INPUT_GITHUB-TOKEN=ghp_xxx' 'INPUT_FAIL-ON-MUTABLE=true' node src/index.js
 *
 * Set workspace directory environment variable (optional, defaults to process.cwd()):
 *    export GITHUB_WORKSPACE="/path/to/repo"
 */

import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';

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
 * Detect unsupported uses formats so they can be reported instead of silently ignored
 * @param {string} uses - Raw uses string from a workflow job or step
 * @returns {Object|null} Unsupported reference details or null when supported/unknown
 */
export function getUnsupportedReference(uses) {
  if (!uses || typeof uses !== 'string') {
    return null;
  }

  if (uses.includes('://')) {
    const protocol = uses.split('://')[0];
    return {
      unsupportedType: 'protocol',
      message: `Unsupported reference type: ${protocol}://`
    };
  }

  return null;
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
 * Resolve the metadata file for a local action directory
 * @param {string} actionDir - Local action directory path
 * @returns {string|null} Path to action metadata file or null if not found
 */
export function findLocalActionMetadataFile(actionDir) {
  const candidates = ['action.yml', 'action.yaml'];
  for (const filename of candidates) {
    const metadataPath = path.join(actionDir, filename);
    if (fs.existsSync(metadataPath)) {
      return metadataPath;
    }
  }

  return null;
}

/**
 * Resolve a local action path from either the current action directory or workspace root
 * @param {string} uses - Raw local action reference
 * @param {string} workspaceDir - Repository workspace root
 * @param {string} baseDir - Directory to resolve nested local actions from
 * @returns {string} Normalized local action directory path
 */
export function resolveLocalActionDirectory(uses, workspaceDir, baseDir) {
  const candidateDirs = [path.resolve(baseDir, uses), path.resolve(workspaceDir, uses)];

  for (const candidateDir of candidateDirs) {
    if (fs.existsSync(candidateDir)) {
      return candidateDir;
    }
  }

  return candidateDirs[0];
}

/**
 * Create an unsupported local action record
 * @param {string} uses - Raw local action reference
 * @param {Object} metadata - Workflow metadata for the reference
 * @param {string} message - Unsupported message
 * @returns {Object} Unsupported action record
 */
export function createUnsupportedLocalAction(uses, metadata, message) {
  return {
    uses,
    ...metadata,
    supported: false,
    unsupportedType: 'local-action',
    message
  };
}

/**
 * Extract nested references from a local composite action
 * @param {string} uses - Raw local action reference
 * @param {Object} metadata - Workflow metadata for the reference
 * @param {string} workspaceDir - Repository workspace root
 * @param {string} baseDir - Directory to resolve nested local actions from
 * @param {Set<string>} visitedLocalActions - Set of visited local action directories
 * @returns {Array} Extracted nested action references or unsupported fallback
 */
export function extractActionsFromLocalAction(uses, metadata, workspaceDir, baseDir, visitedLocalActions = new Set()) {
  const localActionDir = resolveLocalActionDirectory(uses, workspaceDir, baseDir);

  if (visitedLocalActions.has(localActionDir)) {
    core.warning(`Skipping recursive local action cycle: ${uses}`);
    return [];
  }

  const metadataFile = findLocalActionMetadataFile(localActionDir);
  if (!metadataFile) {
    return [createUnsupportedLocalAction(uses, metadata, 'Unsupported local action: action.yml not found')];
  }

  try {
    const content = fs.readFileSync(metadataFile, 'utf8');
    const actionDefinition = YAML.parse(content);
    const actionType = actionDefinition?.runs?.using;

    if (actionType !== 'composite') {
      return [
        createUnsupportedLocalAction(uses, metadata, `Unsupported local action type: ${actionType || 'unknown'}`)
      ];
    }

    const nestedActions = [];
    const nextVisitedLocalActions = new Set(visitedLocalActions);
    nextVisitedLocalActions.add(localActionDir);

    for (const step of actionDefinition?.runs?.steps || []) {
      if (step?.uses) {
        addParsedAction(
          nestedActions,
          step.uses,
          {
            ...metadata,
            stepName: step.name || metadata.stepName || 'unnamed step'
          },
          {
            workspaceDir,
            baseDir: localActionDir,
            visitedLocalActions: nextVisitedLocalActions
          }
        );
      }
    }

    return nestedActions;
  } catch (error) {
    core.warning(`Failed to parse local action ${metadataFile}: ${error.message}`);
    return [createUnsupportedLocalAction(uses, metadata, 'Unsupported local action: failed to parse action.yml')];
  }
}

/**
 * Add a workflow action reference to the collection, including unsupported references
 * @param {Array} actions - Mutable collection of extracted action references
 * @param {string} uses - Raw uses string from a workflow job or step
 * @param {Object} metadata - Additional metadata to attach to the extracted action
 * @param {Object} options - Resolution options for local action recursion
 */
export function addParsedAction(actions, uses, metadata, options = {}) {
  const workspaceDir = options.workspaceDir || process.env.GITHUB_WORKSPACE || process.cwd();
  const baseDir = options.baseDir || workspaceDir;
  const visitedLocalActions = options.visitedLocalActions || new Set();

  if (uses.startsWith('./')) {
    actions.push(...extractActionsFromLocalAction(uses, metadata, workspaceDir, baseDir, visitedLocalActions));
    return;
  }

  const unsupported = getUnsupportedReference(uses);
  if (unsupported) {
    actions.push({
      uses,
      ...metadata,
      supported: false,
      ...unsupported
    });
    return;
  }

  const parsed = parseActionReference(uses);
  if (!parsed) {
    return;
  }

  actions.push({
    uses,
    ...parsed,
    ...metadata,
    supported: true,
    isFirstParty: shouldExcludeAction(parsed.owner)
  });
}

/**
 * Extract all action references from a workflow file
 * @param {string} workflowPath - Path to workflow YAML file
 * @param {string} workspaceDir - Repository workspace root
 * @returns {Array} Array of action references
 */
export function extractActionsFromWorkflow(workflowPath, workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd()) {
  try {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const workflow = YAML.parse(content);
    const workflowFile = path.basename(workflowPath);

    const actions = [];
    const jobs = workflow?.jobs || {};

    for (const [jobName, job] of Object.entries(jobs)) {
      if (job?.uses) {
        addParsedAction(
          actions,
          job.uses,
          {
            workflowFile,
            jobName,
            sourceWorkflowFile: workflowFile,
            sourceJobName: jobName
          },
          {
            workspaceDir
          }
        );
      }

      const steps = job?.steps || [];
      for (const step of steps) {
        if (step?.uses) {
          addParsedAction(
            actions,
            step.uses,
            {
              workflowFile,
              jobName,
              stepName: step.name || 'unnamed step',
              sourceWorkflowFile: workflowFile,
              sourceJobName: jobName,
              sourceStepName: step.name || 'unnamed step'
            },
            {
              workspaceDir
            }
          );
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
 * Format a caller-side source location for summary reporting
 * @param {Object} sourceLocation - Caller-side source location
 * @param {string} repository - GitHub repository in owner/name form
 * @param {string} sha - Git commit SHA for summary links
 * @returns {string} Human-readable location text
 */
export function formatSourceLocationLink(sourceLocation, repository, sha) {
  const locationText = sourceLocation?.workflowFile || 'workflow';

  if (!repository || !sha || !sourceLocation?.workflowFile) {
    return locationText;
  }

  const workflowPath = `.github/workflows/${sourceLocation.workflowFile}`;
  const url = `https://github.com/${repository}/blob/${sha}/${workflowPath}`;
  return `[${locationText}](${url})`;
}

/**
 * Append caller-side source locations to a summary message when useful
 * @param {string} message - Base status message
 * @param {Array} sourceLocations - Caller-side source locations
 * @param {boolean} linkSources - Whether to render source locations as links
 * @returns {string} Message with optional source location details
 */
export function formatSummaryMessage(message, sourceLocations = [], linkSources = false) {
  if (!Array.isArray(sourceLocations) || sourceLocations.length === 0) {
    return message;
  }

  const formattedSources = Array.from(
    new Set(
      sourceLocations.map(source =>
        linkSources
          ? formatSourceLocationLink(source, process.env.GITHUB_REPOSITORY, process.env.GITHUB_SHA)
          : source?.workflowFile || 'workflow'
      )
    )
  );

  const bulletList = formattedSources.map(source => `- ${source}`).join('<br>');
  return `${message}<br>${bulletList}`;
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
 * @param {boolean} includeFirstParty - Whether to include first-party actions in checks
 * @returns {Promise<Object>} { mutable: Array, immutable: Array, unsupported: Array, firstParty: Array, byWorkflow: Object }
 */
export async function checkAllActions(octokit, actions, includeFirstParty = false) {
  const mutable = [];
  const immutable = [];
  const unsupported = [];
  const firstParty = [];
  const byWorkflow = {};

  const unsupportedActions = actions.filter(a => a.supported === false);

  // Separate first-party actions from actions to check
  // When includeFirstParty is true, check all actions for immutability
  const supportedActions = actions.filter(a => a.supported !== false);
  const actionsToCheck = includeFirstParty ? supportedActions : supportedActions.filter(a => !a.isFirstParty);
  const excludedFirstPartyActions = includeFirstParty ? [] : supportedActions.filter(a => a.isFirstParty);
  const allFirstPartyActions = supportedActions.filter(a => a.isFirstParty);

  // Create a cache for immutability results
  const immutabilityCache = new Map();

  // Process unsupported actions - deduplicate by uses string
  const uniqueUnsupportedActions = Array.from(new Map(unsupportedActions.map(a => [a.uses, a])).values());
  for (const action of uniqueUnsupportedActions) {
    const actionInfo = {
      uses: action.uses,
      supported: false,
      sourceLocations: [
        {
          workflowFile: action.sourceWorkflowFile || action.workflowFile,
          jobName: action.sourceJobName || action.jobName,
          stepName: action.sourceStepName || action.stepName
        }
      ],
      unsupportedType: action.unsupportedType,
      message: action.message
    };
    unsupported.push(actionInfo);
    immutabilityCache.set(action.uses, actionInfo);
  }

  // Process excluded first-party actions (no API check needed) - deduplicate by uses string
  const uniqueExcludedFirstParty = Array.from(new Map(excludedFirstPartyActions.map(a => [a.uses, a])).values());
  for (const action of uniqueExcludedFirstParty) {
    const actionInfo = {
      uses: action.uses,
      owner: action.owner,
      repo: action.repo,
      ref: action.ref,
      isFirstParty: true,
      immutable: true,
      releaseFound: false,
      message: 'Excluded (first-party)',
      allowed: true,
      excluded: true
    };
    firstParty.push(actionInfo);

    // Cache result for workflow grouping
    immutabilityCache.set(action.uses, {
      immutable: true,
      releaseFound: false,
      message: 'Excluded (first-party)'
    });
  }

  // Deduplicate actions being checked by uses string for API calls, but preserve workflow info
  const uniqueActions = Array.from(new Map(actionsToCheck.map(a => [a.uses, a])).values());

  for (const action of uniqueActions) {
    core.info(`Checking ${action.owner}/${action.repo}@${action.ref}...`);

    const result = await checkReleaseImmutability(octokit, action.owner, action.repo, action.ref);
    immutabilityCache.set(action.uses, result);

    const actionInfo = {
      uses: action.uses,
      owner: action.owner,
      repo: action.repo,
      ref: action.ref,
      isFirstParty: action.isFirstParty || false,
      ...result
    };

    if (result.immutable) {
      immutable.push(actionInfo);
    } else {
      mutable.push(actionInfo);
    }
  }

  // Add checked first-party actions to the firstParty output with allowed/reason
  if (includeFirstParty) {
    const uniqueCheckedFirstParty = Array.from(new Map(allFirstPartyActions.map(a => [a.uses, a])).values());
    for (const action of uniqueCheckedFirstParty) {
      const cachedResult = immutabilityCache.get(action.uses);
      firstParty.push({
        uses: action.uses,
        owner: action.owner,
        repo: action.repo,
        ref: action.ref,
        isFirstParty: true,
        ...cachedResult,
        allowed: cachedResult.immutable,
        excluded: false
      });
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
    byWorkflow[workflowFile] = { mutable: [], immutable: [], unsupported: [], firstParty: [] };

    // Deduplicate by uses string within this workflow
    const uniqueWorkflowActions = Array.from(
      workflowActions
        .reduce((groupedActions, action) => {
          const sourceLocation = {
            workflowFile: action.sourceWorkflowFile || action.workflowFile,
            jobName: action.sourceJobName || action.jobName,
            stepName: action.sourceStepName || action.stepName
          };
          const sourceKey = `${sourceLocation.workflowFile || ''}\u0000${sourceLocation.jobName || ''}\u0000${sourceLocation.stepName || ''}`;

          if (!groupedActions.has(action.uses)) {
            groupedActions.set(action.uses, {
              action,
              sourceLocations: new Map()
            });
          }

          groupedActions.get(action.uses).sourceLocations.set(sourceKey, sourceLocation);
          return groupedActions;
        }, new Map())
        .values()
    ).map(({ action, sourceLocations }) => ({
      ...action,
      sourceLocations: Array.from(sourceLocations.values())
    }));

    for (const action of uniqueWorkflowActions) {
      const cachedResult = immutabilityCache.get(action.uses);
      const actionInfo = {
        uses: action.uses,
        owner: action.owner,
        repo: action.repo,
        ref: action.ref,
        workflowFile: action.workflowFile,
        sourceLocations: action.sourceLocations || [],
        supported: action.supported !== false,
        isFirstParty: action.isFirstParty || false,
        ...cachedResult
      };

      if (action.supported === false) {
        byWorkflow[workflowFile].unsupported.push(actionInfo);
      } else if (!includeFirstParty && action.isFirstParty) {
        byWorkflow[workflowFile].firstParty.push(actionInfo);
      } else if (cachedResult.immutable) {
        byWorkflow[workflowFile].immutable.push(actionInfo);
      } else {
        byWorkflow[workflowFile].mutable.push(actionInfo);
      }
    }
  }

  return { mutable, immutable, unsupported, firstParty, byWorkflow };
}

/**
 * Main action logic
 */
export async function run() {
  try {
    // Get inputs
    const githubToken = core.getInput('github-token');
    const failOnMutable = core.getBooleanInput('fail-on-mutable');
    const includeFirstParty = core.getBooleanInput('include-first-party');
    const workflowsInput = core.getInput('workflows');
    const excludeWorkflowsInput = core.getInput('exclude-workflows');

    if (!githubToken) {
      core.setFailed('github-token is required (defaults to github.token)');
      return;
    }

    core.info('Starting Ensure Immutable Actions...');
    core.info(`Fail on mutable: ${failOnMutable}`);
    core.info(`Include first-party: ${includeFirstParty}`);

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
      core.setOutput('unsupported-actions', '[]');
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
      const actions = extractActionsFromWorkflow(workflowFile, workspaceDir);
      core.info(`  Found ${actions.length} action(s)`);
      allActions.push(...actions);
    }

    if (allActions.length === 0) {
      core.info('No actions found in workflows');
      core.setOutput('all-passed', true);
      core.setOutput('workflows-checked', JSON.stringify(workflowBasenames));
      core.setOutput('mutable-actions', '[]');
      core.setOutput('immutable-actions', '[]');
      core.setOutput('unsupported-actions', '[]');
      core.setOutput('first-party-actions', '[]');

      // Create summary
      try {
        await core.summary
          .addRaw('# ✅ Immutable Actions Check - All Passed\n\n')
          .addRaw(`No actions found in checked workflows.`)
          .write();
      } catch {
        core.info('✅ All checks passed (no actions found)');
      }

      return;
    }

    core.info(`Total action references found: ${allActions.length}`);

    // Initialize Octokit
    const octokit = new Octokit({ auth: githubToken });

    // Check all actions
    const { mutable, immutable, unsupported, firstParty, byWorkflow } = await checkAllActions(
      octokit,
      allActions,
      includeFirstParty
    );

    // Set outputs
    core.setOutput('workflows-checked', JSON.stringify(workflowBasenames));
    core.setOutput('mutable-actions', JSON.stringify(mutable));
    core.setOutput('immutable-actions', JSON.stringify(immutable));
    core.setOutput('unsupported-actions', JSON.stringify(unsupported));
    core.setOutput('first-party-actions', JSON.stringify(firstParty));
    core.setOutput('all-passed', mutable.length === 0 && unsupported.length === 0);

    // Create summary with separate tables per workflow
    try {
      let summary = core.summary;

      if (mutable.length === 0 && unsupported.length === 0) {
        summary = summary.addRaw('# ✅ Immutable Actions Check - All Passed\n\n');
      } else {
        summary = summary.addRaw('# ❌ Immutable Actions Check - Failed\n\n');
      }

      const excludedCount = firstParty.filter(a => a.excluded).length;

      summary = summary
        .addRaw(`**Workflows Checked:** ${workflowBasenames.join(', ')}\n\n`)
        .addRaw(
          `**Summary:** ${excludedCount} excluded, ${immutable.length} immutable, ${mutable.length} mutable, ${unsupported.length} unsupported\n\n`
        );

      // Add a table for each workflow
      for (const workflowFile of workflowBasenames) {
        const workflowData = byWorkflow[workflowFile];

        if (
          !workflowData ||
          (workflowData.immutable.length === 0 &&
            workflowData.mutable.length === 0 &&
            workflowData.unsupported.length === 0 &&
            workflowData.firstParty.length === 0)
        ) {
          continue;
        }

        const workflowMutableCount = workflowData.mutable.length;
        const workflowImmutableCount = workflowData.immutable.length;
        const workflowUnsupportedCount = workflowData.unsupported.length;
        const workflowFirstPartyCount = workflowData.firstParty.length;
        const workflowStatus = workflowMutableCount === 0 && workflowUnsupportedCount === 0 ? '✅' : '❌';

        summary = summary.addRaw(`### ${workflowStatus} ${workflowFile}\n\n`);
        summary = summary.addRaw(
          `**Actions:** ${workflowFirstPartyCount} excluded, ${workflowImmutableCount} immutable, ${workflowMutableCount} mutable, ${workflowUnsupportedCount} unsupported\n\n`
        );

        // Build markdown table
        let markdownTable = '| Action | Status | Message / Found In |\n';
        markdownTable += '|--------|--------|--------------------|\n';

        // Iterate each category separately so status reflects check results, not just isFirstParty flag
        for (const action of workflowData.firstParty) {
          const actionRef = formatActionReference(action.owner, action.repo, action.ref);
          markdownTable += `| ${actionRef} | ✅ First-party | ${action.message} |\n`;
        }
        for (const action of workflowData.immutable) {
          const actionRef = formatActionReference(action.owner, action.repo, action.ref);
          markdownTable += `| ${actionRef} | ✅ Immutable | ${action.message} |\n`;
        }
        for (const action of workflowData.mutable) {
          const actionRef = formatActionReference(action.owner, action.repo, action.ref);
          const message = formatSummaryMessage(action.message, action.sourceLocations, true);
          markdownTable += `| ${actionRef} | ❌ Mutable | ${message} |\n`;
        }
        for (const action of workflowData.unsupported) {
          const message = formatSummaryMessage(action.message, action.sourceLocations, true);
          markdownTable += `| ${action.uses} | ⚠️ Unsupported | ${message} |\n`;
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
      core.info(`   Unsupported: ${unsupported.length}`);
    }

    // Log results
    if (immutable.length > 0) {
      core.info(`\n✅ ${immutable.length} action(s) using immutable releases:`);
      for (const action of immutable) {
        core.info(`   - ${action.owner}/${action.repo}@${action.ref}`);
      }
    }

    if (mutable.length > 0) {
      core.info(`\n❌ ${mutable.length} action(s) using mutable releases:`);
      for (const action of mutable) {
        core.notice(`${action.owner}/${action.repo}@${action.ref} (${action.message})`);
      }
    }

    if (unsupported.length > 0) {
      core.warning(`Found ${unsupported.length} unsupported action reference(s):`);
      for (const action of unsupported) {
        core.warning(`${action.uses} (${action.message})`);
      }
    }

    // Fail if needed
    if (failOnMutable && mutable.length > 0) {
      core.setFailed(
        `Found ${mutable.length} action(s) using mutable releases. ` +
          `Please use immutable releases for supply chain security.`
      );
    } else if (mutable.length === 0 && unsupported.length === 0) {
      core.info('\n✅ All actions are using immutable releases!');
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
