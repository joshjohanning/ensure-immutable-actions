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
import { minimatch } from 'minimatch';
import * as path from 'path';
import YAML from 'yaml';

/**
 * Parse action reference from uses: field
 * @param {string} uses - The uses string (e.g., "actions/checkout@v4" or "owner/repo/path@ref")
 * @returns {Object|null} Parsed action { owner, repo, actionPath, ref } or null if invalid
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

  // Parse format: owner/repo@ref or owner/repo/path@ref without regex backtracking
  const atIndex = uses.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === uses.length - 1) {
    return null;
  }

  const repoPath = uses.slice(0, atIndex);
  const ref = uses.slice(atIndex + 1);
  const pathParts = repoPath.split('/');

  if (pathParts.length < 2) {
    return null;
  }

  const [owner, repo, ...actionPathParts] = pathParts;
  if (!owner || !repo || repo.includes('@') || actionPathParts.some(part => part.length === 0)) {
    return null;
  }

  const actionPath = actionPathParts.join('/');
  return { owner, repo, actionPath, ref };
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
 * Build a stable key for deduplication and cache lookups
 * @param {Object} action - Action or unsupported record
 * @returns {string} Stable cache key
 */
export function getActionCacheKey(action) {
  if (action.supported === false) {
    return `unsupported:${action.uses}:${action.message}`;
  }

  return `supported:${action.uses}`;
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
 * Resolve a local action path from the current base directory with workspace-root fallback
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
 * Resolve a local reusable workflow path from the workspace root
 * @param {string} uses - Raw local workflow reference
 * @param {string} workspaceDir - Repository workspace root
 * @returns {string | null} Normalized local reusable workflow path or null when invalid
 */
export function resolveLocalReusableWorkflowPath(uses, workspaceDir) {
  const candidatePaths = [path.resolve(workspaceDir, uses)];
  const normalizedWorkspace = path.resolve(workspaceDir);

  for (const candidatePath of candidatePaths) {
    if (candidatePath.startsWith(normalizedWorkspace + path.sep) && fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  // Ensure fallback is also within workspace to prevent path traversal
  const fallback = candidatePaths[0];
  if (!fallback.startsWith(normalizedWorkspace + path.sep)) {
    return null;
  }
  return fallback;
}

/**
 * Parse workflow include/exclude input into individual patterns
 * @param {string} patternsInput - Comma-separated workflow patterns
 * @returns {Array<string>} Normalized workflow patterns
 */
export function parseWorkflowPatterns(patternsInput) {
  return (patternsInput || '')
    .split(',')
    .map(pattern => pattern.trim())
    .filter(Boolean);
}

/**
 * Check whether a workflow basename matches any configured exclude pattern
 * @param {string} workflowFile - Workflow basename
 * @param {Array<string>} excludeWorkflowPatterns - Exclude patterns
 * @returns {boolean} True when the workflow should be skipped
 */
export function isExcludedWorkflow(workflowFile, excludeWorkflowPatterns = []) {
  return excludeWorkflowPatterns.some(pattern => matchesPattern(workflowFile, pattern));
}

/**
 * Check if a local uses reference points to a reusable workflow file
 * @param {string} uses - Raw local uses reference
 * @returns {boolean} True when the reference targets a local reusable workflow
 */
export function isLocalReusableWorkflowReference(uses) {
  return (
    typeof uses === 'string' &&
    uses.startsWith('./.github/workflows/') &&
    (uses.endsWith('.yml') || uses.endsWith('.yaml'))
  );
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
 * Extract nested references from a local reusable workflow
 * @param {string} uses - Raw local workflow reference
 * @param {Object} metadata - Workflow metadata for the reference
 * @param {string} workspaceDir - Repository workspace root
 * @param {string} baseDir - Directory to resolve nested local references from
 * @returns {Array} Extracted nested action references
 */
export function extractActionsFromLocalReusableWorkflow(
  uses,
  metadata,
  workspaceDir,
  baseDir,
  excludeWorkflowPatterns = [],
  visitedWorkflows = new Set()
) {
  const workflowPath = resolveLocalReusableWorkflowPath(uses, workspaceDir);
  if (!workflowPath || !fs.existsSync(workflowPath)) {
    return [createUnsupportedLocalAction(uses, metadata, 'Unsupported local reusable workflow: file not found')];
  }

  if (visitedWorkflows.has(workflowPath)) {
    core.warning(`Skipping recursive local workflow cycle: ${uses}`);
    return [];
  }

  try {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const workflow = YAML.parse(content);
    const nestedActions = [];
    const jobs = workflow?.jobs || {};
    const workflowFile = path.basename(workflowPath);
    if (isExcludedWorkflow(workflowFile, excludeWorkflowPatterns)) {
      return [];
    }
    const nextVisitedWorkflows = new Set(visitedWorkflows);
    nextVisitedWorkflows.add(workflowPath);

    for (const [jobName, job] of Object.entries(jobs)) {
      if (job?.uses) {
        addParsedAction(
          nestedActions,
          job.uses,
          {
            workflowFile,
            jobName,
            entrypointUses: metadata.entrypointUses || uses,
            sourceWorkflowFile: metadata.sourceWorkflowFile || metadata.workflowFile,
            sourceJobName: metadata.sourceJobName || metadata.jobName,
            sourceStepName: metadata.sourceStepName || metadata.stepName
          },
          {
            workspaceDir,
            excludeWorkflowPatterns,
            visitedWorkflows: nextVisitedWorkflows
          }
        );
      }

      for (const step of job?.steps || []) {
        if (step?.uses) {
          addParsedAction(
            nestedActions,
            step.uses,
            {
              workflowFile,
              jobName,
              stepName: step.name || 'unnamed step',
              entrypointUses: metadata.entrypointUses || uses,
              sourceWorkflowFile: metadata.sourceWorkflowFile || metadata.workflowFile,
              sourceJobName: metadata.sourceJobName || metadata.jobName,
              sourceStepName: metadata.sourceStepName || metadata.stepName
            },
            {
              workspaceDir,
              excludeWorkflowPatterns,
              visitedWorkflows: nextVisitedWorkflows
            }
          );
        }
      }
    }

    return nestedActions;
  } catch (error) {
    core.warning(`Failed to parse local reusable workflow ${workflowPath}: ${error.message}`);
    return [createUnsupportedLocalAction(uses, metadata, 'Unsupported local reusable workflow: failed to parse file')];
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
  const excludeWorkflowPatterns = options.excludeWorkflowPatterns || [];
  const visitedWorkflows = options.visitedWorkflows || new Set();

  if (uses.startsWith('./')) {
    if (isLocalReusableWorkflowReference(uses)) {
      actions.push(
        ...extractActionsFromLocalReusableWorkflow(
          uses,
          metadata,
          workspaceDir,
          baseDir,
          excludeWorkflowPatterns,
          visitedWorkflows
        )
      );
      return;
    }
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

  if (
    isReusableWorkflowReference(parsed) &&
    isExcludedWorkflow(path.posix.basename(parsed.actionPath), excludeWorkflowPatterns)
  ) {
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
 * @param {Object} options - Workflow extraction options
 * @returns {Array} Array of action references
 */
export function extractActionsFromWorkflow(
  workflowPath,
  workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd(),
  options = {}
) {
  try {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const workflow = YAML.parse(content);
    const workflowFile = path.basename(workflowPath);
    const excludeWorkflowPatterns = options.excludeWorkflowPatterns || [];

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
            entrypointUses: job.uses,
            sourceWorkflowFile: workflowFile,
            sourceJobName: jobName
          },
          {
            workspaceDir,
            excludeWorkflowPatterns
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
              entrypointUses: step.uses,
              sourceWorkflowFile: workflowFile,
              sourceJobName: jobName,
              sourceStepName: step.name || 'unnamed step'
            },
            {
              workspaceDir,
              excludeWorkflowPatterns
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
 * Determine whether a remote reference points to a reusable workflow file
 * @param {Object} action - Parsed action reference
 * @returns {boolean} True when the reference targets a reusable workflow
 */
export function isReusableWorkflowReference(action) {
  return (
    typeof action.actionPath === 'string' &&
    action.actionPath.startsWith('.github/workflows/') &&
    (action.actionPath.endsWith('.yml') || action.actionPath.endsWith('.yaml'))
  );
}

/**
 * Fetch file content from a remote repository at a given ref
 * @param {Octokit} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} filePath - Path in the repository
 * @param {string} ref - Git ref
 * @returns {Promise<Object>} Remote file result
 */
export async function fetchRemoteFile(octokit, owner, repo, filePath, ref) {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref
    });

    const file = response.data;
    if (!file || Array.isArray(file) || file.type !== 'file' || typeof file.content !== 'string') {
      return {
        found: false,
        message: `Remote path is not a file: ${filePath}`
      };
    }

    return {
      found: true,
      content: Buffer.from(file.content, file.encoding || 'base64').toString('utf8')
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        found: false,
        message: `Remote file not found: ${filePath}`
      };
    }

    return {
      found: false,
      message: `Failed to fetch remote file ${filePath}: ${error.message}`
    };
  }
}

/**
 * Build an unsupported record for remote recursion boundaries
 * @param {Object} action - Parsed action reference
 * @param {string} message - Unsupported message
 * @returns {Object} Unsupported action record
 */
export function createUnsupportedRemoteAction(action, message) {
  return {
    uses: action.uses,
    workflowFile: action.workflowFile,
    jobName: action.jobName,
    stepName: action.stepName,
    sourceWorkflowFile: action.sourceWorkflowFile || action.workflowFile,
    sourceJobName: action.sourceJobName || action.jobName,
    sourceStepName: action.sourceStepName || action.stepName,
    supported: false,
    unsupportedType: 'remote-recursion',
    message
  };
}

/**
 * Clone a cached expansion template with caller workflow metadata
 * @param {Object} template - Cached action template
 * @param {Object} parentAction - Action being expanded
 * @returns {Object} Instantiated action record
 */
export function instantiateExpandedAction(template, parentAction) {
  return {
    ...template,
    workflowFile: parentAction.workflowFile,
    jobName: template.jobName || parentAction.jobName,
    stepName: template.stepName || parentAction.stepName,
    entrypointUses: parentAction.entrypointUses || parentAction.uses,
    sourceWorkflowFile: parentAction.sourceWorkflowFile || parentAction.workflowFile,
    sourceJobName: parentAction.sourceJobName || parentAction.jobName,
    sourceStepName: parentAction.sourceStepName || parentAction.stepName
  };
}

/**
 * Expand a fetched remote reusable workflow into nested action templates
 * @param {Octokit} octokit - Octokit instance
 * @param {Object} action - Parsed action reference
 * @param {string} content - Workflow file content
 * @param {Object} options - Expansion options and caches
 * @returns {Promise<Array>} Nested action templates
 */
export async function expandRemoteReusableWorkflow(octokit, action, content, options) {
  try {
    const workflow = YAML.parse(content);
    const nestedTemplates = [];
    const jobs = workflow?.jobs || {};

    for (const [jobName, job] of Object.entries(jobs)) {
      if (job?.uses) {
        let nestedUses = job.uses;
        if (nestedUses.startsWith('./')) {
          const resolvedPath = path.posix.normalize(nestedUses);
          nestedUses = `${action.owner}/${action.repo}/${resolvedPath}@${action.ref}`;
        }
        addParsedAction(
          nestedTemplates,
          nestedUses,
          {
            jobName,
            entrypointUses: action.entrypointUses || action.uses,
            sourceWorkflowFile: action.sourceWorkflowFile || action.workflowFile,
            sourceJobName: action.sourceJobName || action.jobName,
            sourceStepName: action.sourceStepName || action.stepName
          },
          {
            workspaceDir: options.workspaceDir,
            excludeWorkflowPatterns: options.excludeWorkflowPatterns
          }
        );
      }

      for (const step of job?.steps || []) {
        if (step?.uses) {
          let nestedUses = step.uses;
          if (nestedUses.startsWith('./')) {
            const resolvedPath = path.posix.normalize(nestedUses);
            nestedUses = `${action.owner}/${action.repo}/${resolvedPath}@${action.ref}`;
          }
          addParsedAction(
            nestedTemplates,
            nestedUses,
            {
              jobName,
              stepName: step.name || 'unnamed step',
              entrypointUses: action.entrypointUses || action.uses,
              sourceWorkflowFile: action.sourceWorkflowFile || action.workflowFile,
              sourceJobName: action.sourceJobName || action.jobName,
              sourceStepName: action.sourceStepName || action.stepName
            },
            {
              workspaceDir: options.workspaceDir,
              excludeWorkflowPatterns: options.excludeWorkflowPatterns
            }
          );
        }
      }
    }

    return await expandActionReferences(octokit, nestedTemplates, options);
  } catch (error) {
    return [createUnsupportedRemoteAction(action, `Failed to parse remote reusable workflow: ${error.message}`)];
  }
}

/**
 * Expand a fetched remote composite action into nested action templates
 * @param {Octokit} octokit - Octokit instance
 * @param {Object} action - Parsed action reference
 * @param {string} content - Action metadata content
 * @param {Object} options - Expansion options and caches
 * @returns {Promise<Array>} Nested action templates
 */
export async function expandRemoteCompositeAction(octokit, action, content, options) {
  try {
    const actionDefinition = YAML.parse(content);
    const actionType = actionDefinition?.runs?.using;

    if (typeof actionType === 'string' && actionType.startsWith('node')) {
      return [];
    }

    if (actionType === 'docker') {
      return [];
    }

    if (actionType !== 'composite') {
      return [createUnsupportedRemoteAction(action, `Unsupported remote action type: ${actionType || 'unknown'}`)];
    }

    const nestedTemplates = [];

    for (const step of actionDefinition?.runs?.steps || []) {
      if (!step?.uses) {
        continue;
      }

      let nestedUses = step.uses;
      if (nestedUses.startsWith('./')) {
        const resolvedPath = path.posix.normalize(nestedUses);
        nestedUses = `${action.owner}/${action.repo}/${resolvedPath}@${action.ref}`;
      }

      addParsedAction(
        nestedTemplates,
        nestedUses,
        {
          stepName: step.name || 'unnamed step',
          entrypointUses: action.entrypointUses || action.uses,
          sourceWorkflowFile: action.sourceWorkflowFile || action.workflowFile,
          sourceJobName: action.sourceJobName || action.jobName,
          sourceStepName: action.sourceStepName || action.stepName
        },
        {
          workspaceDir: options.workspaceDir,
          excludeWorkflowPatterns: options.excludeWorkflowPatterns
        }
      );
    }

    return await expandActionReferences(octokit, nestedTemplates, options);
  } catch (error) {
    return [createUnsupportedRemoteAction(action, `Failed to parse remote action metadata: ${error.message}`)];
  }
}

/**
 * Expand a remote reference into nested action templates
 * @param {Octokit} octokit - Octokit instance
 * @param {Object} action - Parsed action reference
 * @param {Object} options - Expansion options and caches
 * @returns {Promise<Array>} Expanded templates
 */
export async function expandRemoteReference(octokit, action, options) {
  const cacheKey = action.uses;
  if (options.expansionCache.has(cacheKey)) {
    return options.expansionCache.get(cacheKey);
  }

  if (options.expansionStack.has(cacheKey)) {
    core.warning(`Skipping recursive remote reference cycle: ${action.uses}`);
    return [];
  }

  const nextOptions = {
    ...options,
    expansionStack: new Set(options.expansionStack)
  };
  nextOptions.expansionStack.add(cacheKey);

  let expandedTemplates = [];

  if (isReusableWorkflowReference(action)) {
    const workflowFile = await fetchRemoteFile(octokit, action.owner, action.repo, action.actionPath, action.ref);
    expandedTemplates = workflowFile.found
      ? await expandRemoteReusableWorkflow(octokit, action, workflowFile.content, nextOptions)
      : [createUnsupportedRemoteAction(action, workflowFile.message)];
  } else {
    const metadataPaths = action.actionPath
      ? [`${action.actionPath}/action.yml`, `${action.actionPath}/action.yaml`]
      : ['action.yml', 'action.yaml'];

    let metadataResult = null;
    for (const metadataPath of metadataPaths) {
      const candidate = await fetchRemoteFile(octokit, action.owner, action.repo, metadataPath, action.ref);
      if (candidate.found) {
        metadataResult = candidate;
        break;
      }

      if (!metadataResult) {
        metadataResult = candidate;
      }
    }

    expandedTemplates = metadataResult?.found
      ? await expandRemoteCompositeAction(octokit, action, metadataResult.content, nextOptions)
      : [createUnsupportedRemoteAction(action, metadataResult?.message || 'Remote action metadata not found')];
  }

  options.expansionCache.set(cacheKey, expandedTemplates);
  return expandedTemplates;
}

/**
 * Expand action references by recursing into remote composite actions and reusable workflows
 * @param {Octokit} octokit - Octokit instance
 * @param {Array} actions - Action references to expand
 * @param {Object} options - Expansion options and caches
 * @returns {Promise<Array>} Expanded action references
 */
export async function expandActionReferences(octokit, actions, options) {
  const expandedActions = [];

  for (const action of actions) {
    expandedActions.push(action);

    if (action.supported === false) {
      continue;
    }

    const nestedTemplates = await expandRemoteReference(octokit, action, options);
    for (const template of nestedTemplates) {
      expandedActions.push(instantiateExpandedAction(template, action));
    }
  }

  return expandedActions;
}

/**
 * Check if a filename matches a pattern (exact match or glob)
 * @param {string} filename - The filename to test
 * @param {string} pattern - Exact filename or glob pattern
 * @returns {boolean} True if the filename matches the pattern
 */
export function matchesPattern(filename, pattern) {
  if (filename === pattern) {
    return true;
  }
  return minimatch(filename, pattern);
}

/**
 * Get list of workflow files to check
 * @param {string} workflowsInput - Comma-separated workflow files or glob patterns (optional)
 * @param {string} excludeWorkflowsInput - Comma-separated workflows or glob patterns to exclude (optional)
 * @param {string} workspaceDir - Workspace directory path
 * @returns {Array<string>} Array of workflow file paths
 */
export function getWorkflowFiles(workflowsInput, excludeWorkflowsInput, workspaceDir) {
  const workflowsDir = path.join(workspaceDir, '.github', 'workflows');

  if (!fs.existsSync(workflowsDir)) {
    core.warning(`Workflows directory not found: ${workflowsDir}`);
    return [];
  }

  const allFiles = fs.readdirSync(workflowsDir);
  const allWorkflowFiles = allFiles.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  let workflowFiles = [];

  if (workflowsInput) {
    // Check specific workflows (exact names or glob patterns)
    const patterns = workflowsInput
      .split(',')
      .map(w => w.trim())
      .filter(Boolean);
    if (patterns.length === 0) {
      core.warning(`Invalid workflows input: ${workflowsInput}`);
      return [];
    }
    const matched = new Set();
    for (const pattern of patterns) {
      const matches = allWorkflowFiles.filter(f => matchesPattern(f, pattern));
      if (matches.length === 0) {
        core.warning(`No workflow files matched: ${pattern}`);
      }
      for (const m of matches) {
        matched.add(m);
      }
    }
    workflowFiles = [...matched].map(f => path.join(workflowsDir, f));
  } else {
    // Get all workflow files
    workflowFiles = allWorkflowFiles.map(f => path.join(workflowsDir, f));
  }

  // Apply exclusions (exact names or glob patterns)
  if (excludeWorkflowsInput) {
    const excludePatterns = parseWorkflowPatterns(excludeWorkflowsInput);
    workflowFiles = workflowFiles.filter(f => {
      const basename = path.basename(f);
      return !excludePatterns.some(pattern => matchesPattern(basename, pattern));
    });
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
 * @param {string} actionPath - Optional path within the repository
 * @returns {string} Markdown formatted action reference with link
 */
export function formatActionReference(owner, repo, ref, actionPath = '') {
  const repositoryPath = actionPath ? `${owner}/${repo}/${actionPath}` : `${owner}/${repo}`;
  const actionRef = `${repositoryPath}@${ref}`;

  // SHAs already get hyperlinked by GitHub automatically, so just return plain text
  if (isFullSHA(ref)) {
    return actionRef;
  }

  // For tags and branches, create a hyperlink to the repository
  if (actionPath) {
    const linkType = /\.ya?ml$/.test(actionPath) ? 'blob' : 'tree';
    const url = `https://github.com/${owner}/${repo}/${linkType}/${ref}/${actionPath}`;
    return `[${actionRef}](${url})`;
  }
  const url = `https://github.com/${owner}/${repo}/tree/${ref}`;
  return `[${actionRef}](${url})`;
}

/**
 * Format an action reference without markdown for logs and outputs
 * @param {Object} action - Action-like object with owner/repo/ref/actionPath
 * @returns {string} Plain text action reference
 */
export function formatActionReferenceText(action) {
  if (!action?.owner || !action?.repo || !action?.ref) {
    return action?.uses || '';
  }

  const repositoryPath = action.actionPath
    ? `${action.owner}/${action.repo}/${action.actionPath}`
    : `${action.owner}/${action.repo}`;
  return `${repositoryPath}@${action.ref}`;
}

/**
 * Format a caller-side source location for summary reporting
 * @param {Object} sourceLocation - Caller-side source location
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
 * Format a low-impact traversal hint for recursive mutable findings
 * @param {Object} action - Mutable action info
 * @returns {string|null} Traversal hint or null when not needed
 */
export function formatTraversalHint(action) {
  if (!action?.entrypointUses || action.entrypointUses === action.uses) {
    return null;
  }

  const workflowFile = action.sourceWorkflowFile || action.workflowFile;
  return `${formatActionReferenceText(action)} reached via ${workflowFile}`;
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
  const uniqueUnsupportedActions = Array.from(new Map(unsupportedActions.map(a => [getActionCacheKey(a), a])).values());
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
    immutabilityCache.set(getActionCacheKey(action), actionInfo);
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
    immutabilityCache.set(getActionCacheKey(action), {
      immutable: true,
      releaseFound: false,
      message: 'Excluded (first-party)'
    });
  }

  // Deduplicate actions being checked by uses string for API calls, but preserve workflow info
  const uniqueActions = Array.from(new Map(actionsToCheck.map(a => [getActionCacheKey(a), a])).values());

  for (const action of uniqueActions) {
    core.info(`Checking ${formatActionReferenceText(action)}...`);

    const result = await checkReleaseImmutability(octokit, action.owner, action.repo, action.ref);
    immutabilityCache.set(getActionCacheKey(action), result);

    const actionInfo = {
      uses: action.uses,
      owner: action.owner,
      repo: action.repo,
      actionPath: action.actionPath || '',
      ref: action.ref,
      entrypointUses: action.entrypointUses || action.uses,
      sourceWorkflowFile: action.sourceWorkflowFile || action.workflowFile,
      sourceJobName: action.sourceJobName || action.jobName,
      sourceStepName: action.sourceStepName || action.stepName,
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
      const cachedResult = immutabilityCache.get(getActionCacheKey(action));
      firstParty.push({
        uses: action.uses,
        owner: action.owner,
        repo: action.repo,
        actionPath: action.actionPath || '',
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
          const cacheKey = getActionCacheKey(action);
          const sourceLocation = {
            workflowFile: action.sourceWorkflowFile || action.workflowFile,
            jobName: action.sourceJobName || action.jobName,
            stepName: action.sourceStepName || action.stepName
          };
          const sourceKey = `${sourceLocation.workflowFile || ''}\u0000${sourceLocation.jobName || ''}\u0000${sourceLocation.stepName || ''}`;

          if (!groupedActions.has(cacheKey)) {
            groupedActions.set(cacheKey, {
              action,
              sourceLocations: new Map()
            });
          }

          groupedActions.get(cacheKey).sourceLocations.set(sourceKey, sourceLocation);
          return groupedActions;
        }, new Map())
        .values()
    ).map(({ action, sourceLocations }) => ({
      ...action,
      sourceLocations: Array.from(sourceLocations.values())
    }));

    for (const action of uniqueWorkflowActions) {
      const cachedResult = immutabilityCache.get(getActionCacheKey(action));
      const actionInfo = {
        uses: action.uses,
        owner: action.owner,
        repo: action.repo,
        actionPath: action.actionPath || '',
        ref: action.ref,
        workflowFile: action.workflowFile,
        supported: action.supported !== false,
        isFirstParty: action.isFirstParty || false,
        ...cachedResult,
        sourceLocations: action.sourceLocations || []
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
    const excludeWorkflowPatterns = parseWorkflowPatterns(excludeWorkflowsInput);

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
      const actions = extractActionsFromWorkflow(workflowFile, workspaceDir, {
        excludeWorkflowPatterns
      });
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

    const skippedFirstPartyActions = includeFirstParty ? [] : allActions.filter(action => action.isFirstParty);
    const actionsToExpand = includeFirstParty ? allActions : allActions.filter(action => !action.isFirstParty);

    const expandedNonFirstPartyActions = await expandActionReferences(octokit, actionsToExpand, {
      workspaceDir,
      excludeWorkflowPatterns,
      expansionCache: new Map(),
      expansionStack: new Set()
    });
    const expandedActions = [...skippedFirstPartyActions, ...expandedNonFirstPartyActions];

    // Check all actions
    const { mutable, immutable, unsupported, firstParty, byWorkflow } = await checkAllActions(
      octokit,
      expandedActions,
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
          const actionRef = formatActionReference(action.owner, action.repo, action.ref, action.actionPath);
          markdownTable += `| ${actionRef} | ✅ First-party | ${action.message} |\n`;
        }
        for (const action of workflowData.immutable) {
          const actionRef = formatActionReference(action.owner, action.repo, action.ref, action.actionPath);
          markdownTable += `| ${actionRef} | ✅ Immutable | ${action.message} |\n`;
        }
        for (const action of workflowData.mutable) {
          const actionRef = formatActionReference(action.owner, action.repo, action.ref, action.actionPath);
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
        core.info(`   - ${formatActionReferenceText(action)}`);
      }
    }

    if (mutable.length > 0) {
      core.info(`\n❌ ${mutable.length} action(s) using mutable releases:`);
      for (const action of mutable) {
        core.notice(`${formatActionReferenceText(action)} (${action.message})`);
        const traversalHint = formatTraversalHint(action);
        if (traversalHint) {
          core.notice(traversalHint);
        }
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
