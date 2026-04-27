/**
 * Tests for the Ensure Immutable Actions Action
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

// Mock the @actions/core module
const mockCore = {
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  notice: jest.fn(),
  setSecret: jest.fn(),
  summary: {
    addHeading: jest.fn().mockReturnThis(),
    addTable: jest.fn().mockReturnThis(),
    addRaw: jest.fn().mockReturnThis(),
    write: jest.fn().mockResolvedValue(undefined)
  }
};

// Mock octokit instance
const mockOctokit = {
  rest: {
    repos: {
      getReleaseByTag: jest.fn(),
      getContent: jest.fn()
    }
  }
};

// Mock the modules before importing the main module
jest.unstable_mockModule('@actions/core', () => mockCore);
jest.unstable_mockModule('@octokit/rest', () => ({
  Octokit: jest.fn(() => mockOctokit)
}));

// Import the main module and helper functions after mocking
const {
  default: run,
  parseActionReference,
  shouldExcludeAction,
  extractActionsFromWorkflow,
  expandActionReferences,
  expandRemoteReference,
  fetchRemoteFile,
  findLocalActionMetadataFile,
  formatActionReference,
  formatSourceLocationLink,
  formatSummaryMessage,
  formatTraversalHint,
  getUnsupportedReference,
  getWorkflowFiles,
  isLocalReusableWorkflowReference,
  isReusableWorkflowReference,
  resolveLocalActionDirectory,
  resolveLocalReusableWorkflowPath,
  checkReleaseImmutability,
  checkAllActions,
  isFullSHA,
  getActionCacheKey,
  matchesPattern
} = await import('../src/index.js');

describe('Ensure Immutable Actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset Octokit mock
    mockOctokit.rest.repos.getReleaseByTag.mockClear();
    mockOctokit.rest.repos.getContent.mockClear();

    // Set default inputs
    mockCore.getBooleanInput.mockImplementation(name => {
      if (name === 'fail-on-mutable') return true;
      if (name === 'include-first-party') return false;
      return true;
    });
    mockCore.getInput.mockImplementation(name => {
      const inputs = {
        'github-token': 'test-token',
        workflows: '',
        'exclude-workflows': ''
      };
      return inputs[name] || '';
    });
  });

  describe('parseActionReference', () => {
    test('should parse standard action reference', () => {
      const result = parseActionReference('actions/checkout@v4');
      expect(result).toEqual({
        owner: 'actions',
        repo: 'checkout',
        actionPath: '',
        ref: 'v4'
      });
    });

    test('should parse action with path', () => {
      const result = parseActionReference('owner/repo/path@v1');
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        actionPath: 'path',
        ref: 'v1'
      });
    });

    test('should parse action with multi-segment path', () => {
      const result = parseActionReference('owner/repo/path/to/action@v1');
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        actionPath: 'path/to/action',
        ref: 'v1'
      });
    });

    test('should parse action with full 40-char SHA reference', () => {
      // GitHub Actions requires full 40-char SHA for commit references
      const result = parseActionReference('actions/checkout@1234567890abcdef1234567890abcdef12345678');
      expect(result).toEqual({
        owner: 'actions',
        repo: 'checkout',
        actionPath: '',
        ref: '1234567890abcdef1234567890abcdef12345678'
      });
    });

    test('should return null for local actions', () => {
      const result = parseActionReference('./local-action');
      expect(result).toBeNull();
    });

    test('should return null for docker actions', () => {
      const result = parseActionReference('docker://alpine:3.8');
      expect(result).toBeNull();
    });

    test('should return null for invalid format', () => {
      expect(parseActionReference('invalid')).toBeNull();
      expect(parseActionReference('no-at-sign')).toBeNull();
      expect(parseActionReference('')).toBeNull();
      expect(parseActionReference(null)).toBeNull();
      expect(parseActionReference('owner/repo@')).toBeNull();
      expect(parseActionReference('@ref')).toBeNull();
      expect(parseActionReference('owner//@ref')).toBeNull();
      expect(parseActionReference('owner/repo/path/@ref')).toBeNull();
    });
  });

  describe('getUnsupportedReference', () => {
    test('should detect protocol-based references as unsupported', () => {
      expect(getUnsupportedReference('docker://alpine:3.8')).toEqual({
        unsupportedType: 'protocol',
        message: 'Unsupported reference type: docker://'
      });
    });

    test('should return null for supported references', () => {
      expect(getUnsupportedReference('actions/checkout@v4')).toBeNull();
      expect(getUnsupportedReference('./local-action')).toBeNull();
    });
  });

  describe('findLocalActionMetadataFile', () => {
    test('should find action metadata file in local action directory', () => {
      const actionDir = '/tmp/test-local-action-metadata';
      fs.mkdirSync(actionDir, { recursive: true });
      fs.writeFileSync(path.join(actionDir, 'action.yml'), 'name: Test');

      const metadataFile = findLocalActionMetadataFile(actionDir);
      expect(metadataFile).toBe(path.join(actionDir, 'action.yml'));

      fs.rmSync(actionDir, { recursive: true, force: true });
    });
  });

  describe('isReusableWorkflowReference', () => {
    test('should detect reusable workflow paths', () => {
      expect(
        isReusableWorkflowReference({
          actionPath: '.github/workflows/reusable.yml'
        })
      ).toBe(true);
    });

    test('should not treat normal action paths as reusable workflows', () => {
      expect(
        isReusableWorkflowReference({
          actionPath: 'path/to/action'
        })
      ).toBe(false);
    });
  });

  describe('isLocalReusableWorkflowReference', () => {
    test('should detect local reusable workflow paths', () => {
      expect(isLocalReusableWorkflowReference('./.github/workflows/reusable.yml')).toBe(true);
    });

    test('should not treat local action directories as reusable workflows', () => {
      expect(isLocalReusableWorkflowReference('./.github/actions/composite')).toBe(false);
    });

    test('should not treat yml files outside .github/workflows as reusable workflows', () => {
      expect(isLocalReusableWorkflowReference('./some-dir/workflow.yml')).toBe(false);
    });
  });

  describe('resolveLocalReusableWorkflowPath', () => {
    test('should fall back to the workspace root for local reusable workflow references', () => {
      const workspaceDir = '/tmp/test-resolve-local-reusable-workflow';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');

      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'child.yml'), 'name: Child');

      const resolved = resolveLocalReusableWorkflowPath('./.github/workflows/child.yml', workspaceDir, workflowsDir);

      expect(resolved).toBe(path.join(workspaceDir, '.github', 'workflows', 'child.yml'));

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    test('should reject path traversal outside workspace', () => {
      const workspaceDir = '/tmp/test-resolve-traversal';
      const outsideDir = '/tmp/test-resolve-traversal-outside';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');

      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'evil.yml'), 'name: Evil');

      const resolved = resolveLocalReusableWorkflowPath(
        './.github/workflows/../../../../../../tmp/test-resolve-traversal-outside/evil.yml',
        workspaceDir,
        workflowsDir
      );

      expect(resolved).toBeNull();

      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });
  });

  describe('resolveLocalActionDirectory', () => {
    test('should resolve workflow local actions from the workspace root', () => {
      const workspaceDir = '/tmp/test-resolve-local-action-workflow';
      const rootActionDir = workspaceDir;

      fs.mkdirSync(path.join(workspaceDir, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(rootActionDir, 'action.yml'), 'name: Root Action');

      const resolved = resolveLocalActionDirectory('./', workspaceDir, workspaceDir);

      expect(resolved).toBe(rootActionDir);

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });
  });

  describe('getActionCacheKey', () => {
    test('should distinguish supported and unsupported records', () => {
      expect(getActionCacheKey({ uses: 'owner/repo@v1', supported: true })).toBe('supported:owner/repo@v1');
      expect(
        getActionCacheKey({
          uses: 'owner/repo@v1',
          supported: false,
          message: 'Unsupported remote action type: docker'
        })
      ).toBe('unsupported:owner/repo@v1:Unsupported remote action type: docker');
    });
  });

  describe('shouldExcludeAction', () => {
    test('should exclude actions organization', () => {
      expect(shouldExcludeAction('actions')).toBe(true);
    });

    test('should exclude github organization', () => {
      expect(shouldExcludeAction('github')).toBe(true);
    });

    test('should exclude octokit organization', () => {
      expect(shouldExcludeAction('octokit')).toBe(true);
    });

    test('should not exclude other organizations', () => {
      expect(shouldExcludeAction('joshjohanning')).toBe(false);
      expect(shouldExcludeAction('microsoft')).toBe(false);
      expect(shouldExcludeAction('third-party')).toBe(false);
    });
  });

  describe('extractActionsFromWorkflow', () => {
    test('should extract actions from valid workflow', () => {
      const workflowContent = `
name: CI
on: push
jobs:
  reusable:
    uses: owner/platform-workflows/.github/workflows/test.yml@v1
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: joshjohanning/npm-version-check-action@v1
        name: Check npm version
      - uses: third-party/action@v2
`;

      const tempFile = '/tmp/test-workflow.yml';
      fs.writeFileSync(tempFile, workflowContent);

      const actions = extractActionsFromWorkflow(tempFile);

      // Should now include reusable workflows plus step-level actions
      expect(actions).toHaveLength(4);

      // Reusable workflow should be extracted from the job
      expect(actions[0].owner).toBe('owner');
      expect(actions[0].repo).toBe('platform-workflows');
      expect(actions[0].ref).toBe('v1');
      expect(actions[0].jobName).toBe('reusable');
      expect(actions[0].stepName).toBeUndefined();
      expect(actions[0].isFirstParty).toBe(false);
      expect(actions[0].workflowFile).toBe('test-workflow.yml');

      // First step action should be first-party
      expect(actions[1].owner).toBe('actions');
      expect(actions[1].repo).toBe('checkout');
      expect(actions[1].ref).toBe('v4');
      expect(actions[1].isFirstParty).toBe(true);
      expect(actions[1].workflowFile).toBe('test-workflow.yml');

      // Second step action should be third-party
      expect(actions[2].owner).toBe('joshjohanning');
      expect(actions[2].repo).toBe('npm-version-check-action');
      expect(actions[2].ref).toBe('v1');
      expect(actions[2].stepName).toBe('Check npm version');
      expect(actions[2].isFirstParty).toBe(false);
      expect(actions[2].workflowFile).toBe('test-workflow.yml');

      // Third step action should be third-party
      expect(actions[3].owner).toBe('third-party');
      expect(actions[3].isFirstParty).toBe(false);
      expect(actions[3].workflowFile).toBe('test-workflow.yml');

      fs.unlinkSync(tempFile);
    });

    test('should extract reusable workflows without steps', () => {
      const workflowContent = `
name: Deploy
on: workflow_dispatch
jobs:
  deploy:
    uses: owner/reusable-workflows/.github/workflows/deploy.yml@v2
`;

      const tempFile = '/tmp/test-workflow-reusable.yml';
      fs.writeFileSync(tempFile, workflowContent);

      const actions = extractActionsFromWorkflow(tempFile);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        uses: 'owner/reusable-workflows/.github/workflows/deploy.yml@v2',
        owner: 'owner',
        repo: 'reusable-workflows',
        ref: 'v2',
        jobName: 'deploy',
        workflowFile: 'test-workflow-reusable.yml',
        isFirstParty: false
      });
      expect(actions[0].stepName).toBeUndefined();

      fs.unlinkSync(tempFile);
    });

    test('should handle workflow with no actions', () => {
      const workflowContent = `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Hello"
`;

      const tempFile = '/tmp/test-workflow-no-actions.yml';
      fs.writeFileSync(tempFile, workflowContent);

      const actions = extractActionsFromWorkflow(tempFile);
      expect(actions).toHaveLength(0);

      fs.unlinkSync(tempFile);
    });

    test('should handle invalid workflow file gracefully', () => {
      const actions = extractActionsFromWorkflow('/nonexistent/file.yml');
      expect(actions).toHaveLength(0);
      expect(mockCore.warning).toHaveBeenCalled();
    });

    test('should recurse into local composite actions and keep docker references unsupported', () => {
      const workspaceDir = '/tmp/test-workflow-local-composite';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');
      const localActionDir = path.join(workspaceDir, '.github', 'actions', 'composite');

      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.mkdirSync(localActionDir, { recursive: true });

      const workflowContent = `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/composite
      - uses: docker://alpine:3.8
      - uses: third-party/action@v1
`;
      const actionContent = `
name: Composite
runs:
  using: composite
  steps:
    - uses: actions/checkout@v4
    - uses: nested-owner/nested-action@v2
`;

      const tempFile = path.join(workflowsDir, 'ci.yml');
      fs.writeFileSync(tempFile, workflowContent);
      fs.writeFileSync(path.join(localActionDir, 'action.yml'), actionContent);

      const actions = extractActionsFromWorkflow(tempFile, workspaceDir);
      expect(actions).toHaveLength(4);
      expect(actions[0]).toMatchObject({
        uses: 'actions/checkout@v4',
        supported: true,
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4'
      });
      expect(actions[1]).toMatchObject({
        uses: 'nested-owner/nested-action@v2',
        supported: true,
        owner: 'nested-owner',
        repo: 'nested-action',
        ref: 'v2'
      });
      expect(actions[2]).toMatchObject({
        uses: 'docker://alpine:3.8',
        supported: false,
        unsupportedType: 'protocol',
        message: 'Unsupported reference type: docker://'
      });
      expect(actions[3]).toMatchObject({
        uses: 'third-party/action@v1',
        supported: true,
        owner: 'third-party',
        repo: 'action',
        ref: 'v1'
      });

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    test('should recurse into nested local composite actions', () => {
      const workspaceDir = '/tmp/test-workflow-nested-local-composite';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');
      const parentActionDir = path.join(workspaceDir, '.github', 'actions', 'parent');
      const childActionDir = path.join(parentActionDir, 'child');

      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.mkdirSync(childActionDir, { recursive: true });

      fs.writeFileSync(
        path.join(workflowsDir, 'ci.yml'),
        `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/parent
`
      );

      fs.writeFileSync(
        path.join(parentActionDir, 'action.yml'),
        `
name: Parent
runs:
  using: composite
  steps:
    - uses: ./child
`
      );

      fs.writeFileSync(
        path.join(childActionDir, 'action.yml'),
        `
name: Child
runs:
  using: composite
  steps:
    - uses: child-owner/child-action@v3
`
      );

      const actions = extractActionsFromWorkflow(path.join(workflowsDir, 'ci.yml'), workspaceDir);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        uses: 'child-owner/child-action@v3',
        supported: true,
        owner: 'child-owner',
        repo: 'child-action',
        ref: 'v3'
      });

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    test('should keep non-composite local actions unsupported', () => {
      const workspaceDir = '/tmp/test-workflow-local-javascript-action';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');
      const localActionDir = path.join(workspaceDir, '.github', 'actions', 'javascript');

      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.mkdirSync(localActionDir, { recursive: true });

      fs.writeFileSync(
        path.join(workflowsDir, 'ci.yml'),
        `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/javascript
`
      );

      fs.writeFileSync(
        path.join(localActionDir, 'action.yml'),
        `
name: JavaScript Action
runs:
  using: node24
  main: index.js
`
      );

      const actions = extractActionsFromWorkflow(path.join(workflowsDir, 'ci.yml'), workspaceDir);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        uses: './.github/actions/javascript',
        supported: false,
        unsupportedType: 'local-action',
        message: 'Unsupported local action type: node24'
      });

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    test('should recurse into local reusable workflows', () => {
      const workspaceDir = '/tmp/test-workflow-local-reusable';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');
      const localActionDir = path.join(workspaceDir, '.github', 'actions', 'composite');

      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.mkdirSync(localActionDir, { recursive: true });

      fs.writeFileSync(
        path.join(workflowsDir, 'ci.yml'),
        `
name: CI
on: push
jobs:
  reusable:
    uses: ./.github/workflows/test-suite.yml
`
      );

      fs.writeFileSync(
        path.join(workflowsDir, 'test-suite.yml'),
        `
name: Test Suite
on:
  workflow_call:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/composite
`
      );

      fs.writeFileSync(
        path.join(localActionDir, 'action.yml'),
        `
name: Composite
runs:
  using: composite
  steps:
    - uses: nested-owner/nested-action@v2
`
      );

      const actions = extractActionsFromWorkflow(path.join(workflowsDir, 'ci.yml'), workspaceDir);

      expect(actions).toHaveLength(2);
      expect(actions[0]).toMatchObject({
        uses: 'actions/checkout@v4',
        supported: true,
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4'
      });
      expect(actions[1]).toMatchObject({
        uses: 'nested-owner/nested-action@v2',
        supported: true,
        owner: 'nested-owner',
        repo: 'nested-action',
        ref: 'v2'
      });
      expect(mockCore.warning).not.toHaveBeenCalledWith(expect.stringContaining('action.yml not found'));

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    test('should resolve local workflow actions from the repository root', () => {
      const workspaceDir = '/tmp/test-workflow-root-local-action';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');

      fs.mkdirSync(workflowsDir, { recursive: true });

      fs.writeFileSync(
        path.join(workspaceDir, 'action.yml'),
        `
name: Root Action
runs:
  using: composite
  steps:
    - uses: nested-owner/nested-action@v1
`
      );

      fs.writeFileSync(
        path.join(workflowsDir, 'ci.yml'),
        `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./
`
      );

      const actions = extractActionsFromWorkflow(path.join(workflowsDir, 'ci.yml'), workspaceDir);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        uses: 'nested-owner/nested-action@v1',
        supported: true,
        owner: 'nested-owner',
        repo: 'nested-action',
        ref: 'v1'
      });
      expect(mockCore.warning).not.toHaveBeenCalledWith(expect.stringContaining('action.yml not found'));

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    test('should recurse into nested local reusable workflows', () => {
      const workspaceDir = '/tmp/test-workflow-nested-local-reusable';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');

      fs.mkdirSync(workflowsDir, { recursive: true });

      fs.writeFileSync(
        path.join(workflowsDir, 'ci.yml'),
        `
name: CI
on: push
jobs:
  reusable:
    uses: ./.github/workflows/parent.yml
`
      );

      fs.writeFileSync(
        path.join(workflowsDir, 'parent.yml'),
        `
name: Parent
on:
  workflow_call:
jobs:
  child:
    uses: ./.github/workflows/child.yml
`
      );

      fs.writeFileSync(
        path.join(workflowsDir, 'child.yml'),
        `
name: Child
on:
  workflow_call:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: child-owner/child-action@v3
`
      );

      const actions = extractActionsFromWorkflow(path.join(workflowsDir, 'ci.yml'), workspaceDir);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        uses: 'child-owner/child-action@v3',
        supported: true,
        owner: 'child-owner',
        repo: 'child-action',
        ref: 'v3'
      });

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    test('should skip excluded nested local reusable workflows', () => {
      const workspaceDir = '/tmp/test-workflow-excluded-nested-local-reusable';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');

      fs.mkdirSync(workflowsDir, { recursive: true });

      fs.writeFileSync(
        path.join(workflowsDir, 'ci.yml'),
        `
name: CI
on: push
jobs:
  reusable:
    uses: ./.github/workflows/example.yml
`
      );

      fs.writeFileSync(
        path.join(workflowsDir, 'example.yml'),
        `
name: Example
on:
  workflow_call:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: child-owner/child-action@v3
`
      );

      const actions = extractActionsFromWorkflow(path.join(workflowsDir, 'ci.yml'), workspaceDir, {
        excludeWorkflowPatterns: ['example.yml']
      });

      expect(actions).toHaveLength(0);

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    test('should skip excluded remote reusable workflows during extraction', () => {
      const workspaceDir = '/tmp/test-workflow-excluded-remote-reusable';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');

      fs.mkdirSync(workflowsDir, { recursive: true });

      fs.writeFileSync(
        path.join(workflowsDir, 'ci.yml'),
        `
name: CI
on: push
jobs:
  reusable:
    uses: owner/repo/.github/workflows/example.yml@v1
`
      );

      const actions = extractActionsFromWorkflow(path.join(workflowsDir, 'ci.yml'), workspaceDir, {
        excludeWorkflowPatterns: ['example.yml']
      });

      expect(actions).toHaveLength(0);

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    test('should detect and skip circular local reusable workflow references', () => {
      const workspaceDir = '/tmp/test-workflow-circular-local-reusable';
      const workflowsDir = path.join(workspaceDir, '.github', 'workflows');

      fs.mkdirSync(workflowsDir, { recursive: true });

      fs.writeFileSync(
        path.join(workflowsDir, 'ci.yml'),
        `
name: CI
on: push
jobs:
  reusable:
    uses: ./.github/workflows/a.yml
`
      );

      fs.writeFileSync(
        path.join(workflowsDir, 'a.yml'),
        `
name: A
on:
  workflow_call:
jobs:
  call-b:
    uses: ./.github/workflows/b.yml
`
      );

      fs.writeFileSync(
        path.join(workflowsDir, 'b.yml'),
        `
name: B
on:
  workflow_call:
jobs:
  call-a:
    uses: ./.github/workflows/a.yml
`
      );

      const actions = extractActionsFromWorkflow(path.join(workflowsDir, 'ci.yml'), workspaceDir);

      expect(actions).toHaveLength(0);
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('Skipping recursive local workflow cycle'));

      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });
  });

  describe('getWorkflowFiles', () => {
    const testWorkspaceDir = '/tmp/test-workspace';
    const testWorkflowsDir = path.join(testWorkspaceDir, '.github', 'workflows');

    beforeEach(() => {
      // Create test directory structure
      if (!fs.existsSync(testWorkflowsDir)) {
        fs.mkdirSync(testWorkflowsDir, { recursive: true });
      }

      // Create test workflow files
      fs.writeFileSync(path.join(testWorkflowsDir, 'ci.yml'), 'test');
      fs.writeFileSync(path.join(testWorkflowsDir, 'deploy.yml'), 'test');
      fs.writeFileSync(path.join(testWorkflowsDir, 'test.yaml'), 'test');
    });

    afterEach(() => {
      // Clean up test files
      if (fs.existsSync(testWorkspaceDir)) {
        fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
      }
    });

    test('should get all workflow files when no input specified', () => {
      const files = getWorkflowFiles('', '', testWorkspaceDir);
      expect(files).toHaveLength(3);
      expect(files.some(f => f.endsWith('ci.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('deploy.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('test.yaml'))).toBe(true);
    });

    test('should get specific workflow files', () => {
      const files = getWorkflowFiles('ci.yml,deploy.yml', '', testWorkspaceDir);
      expect(files).toHaveLength(2);
      expect(files.some(f => f.endsWith('ci.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('deploy.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('test.yaml'))).toBe(false);
    });

    test('should exclude specified workflows', () => {
      const files = getWorkflowFiles('', 'test.yaml', testWorkspaceDir);
      expect(files).toHaveLength(2);
      expect(files.some(f => f.endsWith('ci.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('deploy.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('test.yaml'))).toBe(false);
    });

    test('should apply exclude-workflows even when workflows is specified', () => {
      const files = getWorkflowFiles('ci.yml,deploy.yml', 'deploy.yml', testWorkspaceDir);
      expect(files).toHaveLength(1);
      expect(files.some(f => f.endsWith('ci.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('deploy.yml'))).toBe(false);
    });

    test('should warn when specified workflow not found', () => {
      const files = getWorkflowFiles('nonexistent.yml', '', testWorkspaceDir);
      expect(files).toHaveLength(0);
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('No workflow files matched'));
    });

    test('should warn when workflows directory not found', () => {
      const files = getWorkflowFiles('', '', '/nonexistent/workspace');
      expect(files).toHaveLength(0);
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    test('should support glob patterns in workflows input', () => {
      // Add more files for glob testing
      fs.writeFileSync(path.join(testWorkflowsDir, 'deploy-staging.yml'), 'test');
      fs.writeFileSync(path.join(testWorkflowsDir, 'deploy-prod.yml'), 'test');

      const files = getWorkflowFiles('deploy-*.yml', '', testWorkspaceDir);
      expect(files).toHaveLength(2);
      expect(files.some(f => f.endsWith('deploy-staging.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('deploy-prod.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('ci.yml'))).toBe(false);
    });

    test('should support glob patterns in exclude-workflows input', () => {
      fs.writeFileSync(path.join(testWorkflowsDir, 'experimental-a.yml'), 'test');
      fs.writeFileSync(path.join(testWorkflowsDir, 'experimental-b.yml'), 'test');

      const files = getWorkflowFiles('', 'experimental-*.yml', testWorkspaceDir);
      expect(files).toHaveLength(3);
      expect(files.some(f => f.endsWith('ci.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('deploy.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('test.yaml'))).toBe(true);
      expect(files.some(f => f.endsWith('experimental-a.yml'))).toBe(false);
      expect(files.some(f => f.endsWith('experimental-b.yml'))).toBe(false);
    });

    test('should support mixing exact names and glob patterns', () => {
      fs.writeFileSync(path.join(testWorkflowsDir, 'deploy-staging.yml'), 'test');
      fs.writeFileSync(path.join(testWorkflowsDir, 'deploy-prod.yml'), 'test');

      const files = getWorkflowFiles('ci.yml,deploy-*.yml', '', testWorkspaceDir);
      expect(files).toHaveLength(3);
      expect(files.some(f => f.endsWith('ci.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('deploy-staging.yml'))).toBe(true);
      expect(files.some(f => f.endsWith('deploy-prod.yml'))).toBe(true);
    });

    test('should warn when glob pattern matches no files', () => {
      const files = getWorkflowFiles('nonexistent-*.yml', '', testWorkspaceDir);
      expect(files).toHaveLength(0);
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('No workflow files matched'));
    });

    test('should not duplicate files when glob and exact match overlap', () => {
      const files = getWorkflowFiles('ci.yml,*.yml', '', testWorkspaceDir);
      const ciFiles = files.filter(f => f.endsWith('ci.yml'));
      expect(ciFiles).toHaveLength(1);
    });

    test('should warn and return empty for invalid workflows input', () => {
      const files = getWorkflowFiles(',, ,', '', testWorkspaceDir);
      expect(files).toHaveLength(0);
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('Invalid workflows input'));
    });
  });

  describe('matchesPattern', () => {
    test('should match exact filenames', () => {
      expect(matchesPattern('ci.yml', 'ci.yml')).toBe(true);
      expect(matchesPattern('ci.yml', 'deploy.yml')).toBe(false);
    });

    test('should match glob patterns with wildcard', () => {
      expect(matchesPattern('deploy-staging.yml', 'deploy-*.yml')).toBe(true);
      expect(matchesPattern('deploy-prod.yml', 'deploy-*.yml')).toBe(true);
      expect(matchesPattern('ci.yml', 'deploy-*.yml')).toBe(false);
    });

    test('should match glob patterns with question mark', () => {
      expect(matchesPattern('ci1.yml', 'ci?.yml')).toBe(true);
      expect(matchesPattern('ci.yml', 'ci?.yml')).toBe(false);
    });

    test('should exact-match filenames containing glob metacharacters', () => {
      expect(matchesPattern('ci[1].yml', 'ci[1].yml')).toBe(true);
      expect(matchesPattern('ci{a,b}.yml', 'ci{a,b}.yml')).toBe(true);
    });
  });

  describe('isFullSHA', () => {
    test('should return true for valid 40-char SHA', () => {
      expect(isFullSHA('1234567890abcdef1234567890abcdef12345678')).toBe(true);
      expect(isFullSHA('ABCDEF1234567890abcdef1234567890ABCDEF12')).toBe(true);
    });

    test('should return false for non-SHA references', () => {
      expect(isFullSHA('v1.0.0')).toBe(false);
      expect(isFullSHA('main')).toBe(false);
      expect(isFullSHA('abc123')).toBe(false); // short SHA
      expect(isFullSHA('1234567890abcdef1234567890abcdef1234567g')).toBe(false); // invalid char
      expect(isFullSHA('1234567890abcdef1234567890abcdef123456')).toBe(false); // too short
    });
  });

  describe('formatActionReference', () => {
    test('should not add hyperlink for full SHA references', () => {
      const result = formatActionReference('owner', 'repo', '1234567890abcdef1234567890abcdef12345678');
      expect(result).toBe('owner/repo@1234567890abcdef1234567890abcdef12345678');
      expect(result).not.toContain('[');
      expect(result).not.toContain('](');
    });

    test('should add hyperlink for tag references', () => {
      const result = formatActionReference('owner', 'repo', 'v1.0.0');
      expect(result).toBe('[owner/repo@v1.0.0](https://github.com/owner/repo/tree/v1.0.0)');
    });

    test('should add hyperlink for branch references', () => {
      const result = formatActionReference('owner', 'repo', 'main');
      expect(result).toBe('[owner/repo@main](https://github.com/owner/repo/tree/main)');
    });

    test('should include the path for path-based references', () => {
      const result = formatActionReference('owner', 'repo', 'v1', '.github/workflows/reusable.yml');
      expect(result).toBe(
        '[owner/repo/.github/workflows/reusable.yml@v1](https://github.com/owner/repo/blob/v1/.github/workflows/reusable.yml)'
      );
    });
  });

  describe('summary source formatting', () => {
    const savedEnv = {};

    beforeEach(() => {
      savedEnv.GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
      savedEnv.GITHUB_SHA = process.env.GITHUB_SHA;
    });

    afterEach(() => {
      if (savedEnv.GITHUB_REPOSITORY === undefined) {
        delete process.env.GITHUB_REPOSITORY;
      } else {
        process.env.GITHUB_REPOSITORY = savedEnv.GITHUB_REPOSITORY;
      }
      if (savedEnv.GITHUB_SHA === undefined) {
        delete process.env.GITHUB_SHA;
      } else {
        process.env.GITHUB_SHA = savedEnv.GITHUB_SHA;
      }
    });

    test('should format source locations as workflow links when repository context is available', () => {
      expect(
        formatSourceLocationLink(
          {
            workflowFile: 'targets-mutable.yml',
            jobName: 'test',
            stepName: 'Check npm version'
          },
          'Wuodan/ensure-immutable-actions-test',
          '1234567890abcdef1234567890abcdef12345678'
        )
      ).toBe(
        '[targets-mutable.yml](https://github.com/Wuodan/ensure-immutable-actions-test/blob/1234567890abcdef1234567890abcdef12345678/.github/workflows/targets-mutable.yml)'
      );
    });

    test('should append linked source locations to summary messages', () => {
      process.env.GITHUB_REPOSITORY = 'Wuodan/ensure-immutable-actions-test';
      process.env.GITHUB_SHA = '1234567890abcdef1234567890abcdef12345678';

      expect(
        formatSummaryMessage(
          'No release found for this reference',
          [{ workflowFile: 'targets-mutable.yml', jobName: 'test', stepName: 'Check npm version' }],
          true
        )
      ).toBe(
        'No release found for this reference<br>- [targets-mutable.yml](https://github.com/Wuodan/ensure-immutable-actions-test/blob/1234567890abcdef1234567890abcdef12345678/.github/workflows/targets-mutable.yml)'
      );
    });

    test('should deduplicate identical workflow links in summary messages', () => {
      process.env.GITHUB_REPOSITORY = 'Wuodan/ensure-immutable-actions-test';
      process.env.GITHUB_SHA = '1234567890abcdef1234567890abcdef12345678';

      expect(
        formatSummaryMessage(
          'No release found for this reference',
          [
            { workflowFile: 'targets-mutable.yml', jobName: 'job-a', stepName: 'step-a' },
            { workflowFile: 'targets-mutable.yml', jobName: 'job-b', stepName: 'step-b' }
          ],
          true
        )
      ).toBe(
        'No release found for this reference<br>- [targets-mutable.yml](https://github.com/Wuodan/ensure-immutable-actions-test/blob/1234567890abcdef1234567890abcdef12345678/.github/workflows/targets-mutable.yml)'
      );
    });

    test('should format a traversal hint for recursive mutable findings', () => {
      expect(
        formatTraversalHint({
          uses: 'owner/nested-action@main',
          entrypointUses: 'owner/repo/.github/workflows/reusable.yml@main',
          sourceWorkflowFile: 'targets-mutable.yml',
          sourceJobName: 'remote-reusable',
          sourceStepName: 'unnamed step'
        })
      ).toBe('owner/nested-action@main reached via targets-mutable.yml');
    });
  });

  describe('fetchRemoteFile', () => {
    test('should decode base64 file content', async () => {
      mockOctokit.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('name: test', 'utf8').toString('base64')
        }
      });

      const result = await fetchRemoteFile(mockOctokit, 'owner', 'repo', 'action.yml', 'v1');
      expect(result).toEqual({
        found: true,
        content: 'name: test'
      });
    });
  });

  describe('checkReleaseImmutability', () => {
    test('should return immutable true for full SHA references', async () => {
      const result = await checkReleaseImmutability(
        mockOctokit,
        'owner',
        'repo',
        '1234567890abcdef1234567890abcdef12345678'
      );

      expect(result).toEqual({
        immutable: true,
        releaseFound: false,
        message: 'Immutable (full SHA reference)'
      });
      // Should not call API for SHA references
      expect(mockOctokit.rest.repos.getReleaseByTag).not.toHaveBeenCalled();
    });

    test('should return immutable true for immutable release', async () => {
      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: true }
      });

      const result = await checkReleaseImmutability(mockOctokit, 'owner', 'repo', 'v1.0.0');

      expect(result).toEqual({
        immutable: true,
        releaseFound: true,
        message: 'Immutable release'
      });
    });

    test('should return immutable false for mutable release', async () => {
      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: false }
      });

      const result = await checkReleaseImmutability(mockOctokit, 'owner', 'repo', 'v1.0.0');

      expect(result).toEqual({
        immutable: false,
        releaseFound: true,
        message: 'Mutable release'
      });
    });

    test('should handle release not found', async () => {
      mockOctokit.rest.repos.getReleaseByTag.mockRejectedValue({
        status: 404,
        message: 'Not Found'
      });

      const result = await checkReleaseImmutability(mockOctokit, 'owner', 'repo', 'v1.0.0');

      expect(result).toEqual({
        immutable: false,
        releaseFound: false,
        message: 'No release found for this reference'
      });
    });

    test('should handle API errors', async () => {
      mockOctokit.rest.repos.getReleaseByTag.mockRejectedValue({
        status: 500,
        message: 'Server Error'
      });

      const result = await checkReleaseImmutability(mockOctokit, 'owner', 'repo', 'v1.0.0');

      expect(result).toEqual({
        immutable: false,
        releaseFound: false,
        message: 'API error: Server Error'
      });
      expect(mockCore.warning).toHaveBeenCalled();
    });
  });

  describe('checkAllActions', () => {
    test('should check multiple actions and categorize them', async () => {
      const actions = [
        {
          uses: 'owner1/repo1@v1',
          owner: 'owner1',
          repo: 'repo1',
          ref: 'v1',
          workflowFile: 'workflow1.yml'
        },
        {
          uses: 'owner2/repo2@v2',
          owner: 'owner2',
          repo: 'repo2',
          ref: 'v2',
          workflowFile: 'workflow1.yml'
        },
        {
          uses: 'owner3/repo3@v3',
          owner: 'owner3',
          repo: 'repo3',
          ref: 'v3',
          workflowFile: 'workflow2.yml'
        }
      ];

      mockOctokit.rest.repos.getReleaseByTag
        .mockResolvedValueOnce({ data: { immutable: true } })
        .mockResolvedValueOnce({ data: { immutable: false } })
        .mockRejectedValueOnce({ status: 404 });

      const result = await checkAllActions(mockOctokit, actions);

      expect(result.immutable).toHaveLength(1);
      expect(result.mutable).toHaveLength(2);
      expect(result.immutable[0].owner).toBe('owner1');
      expect(result.mutable[0].owner).toBe('owner2');
      expect(result.mutable[1].owner).toBe('owner3');

      // Check byWorkflow grouping
      expect(result.byWorkflow).toBeDefined();
      expect(result.byWorkflow['workflow1.yml']).toBeDefined();
      expect(result.byWorkflow['workflow1.yml'].immutable).toHaveLength(1);
      expect(result.byWorkflow['workflow1.yml'].mutable).toHaveLength(1);
      expect(result.byWorkflow['workflow2.yml']).toBeDefined();
      expect(result.byWorkflow['workflow2.yml'].immutable).toHaveLength(0);
      expect(result.byWorkflow['workflow2.yml'].mutable).toHaveLength(1);
    });

    test('should deduplicate actions by uses string', async () => {
      const actions = [
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow1.yml'
        },
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow1.yml'
        },
        {
          uses: 'owner/repo@v2',
          owner: 'owner',
          repo: 'repo',
          ref: 'v2',
          workflowFile: 'workflow2.yml'
        }
      ];

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: true }
      });

      await checkAllActions(mockOctokit, actions);

      // Should only call API twice (for v1 and v2), not three times
      expect(mockOctokit.rest.repos.getReleaseByTag).toHaveBeenCalledTimes(2);
    });

    test('should group same action appearing in multiple workflows', async () => {
      const actions = [
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow1.yml'
        },
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow2.yml'
        }
      ];

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: true }
      });

      const result = await checkAllActions(mockOctokit, actions);

      // Should only call API once (same action)
      expect(mockOctokit.rest.repos.getReleaseByTag).toHaveBeenCalledTimes(1);

      // But should appear in both workflows
      expect(result.byWorkflow['workflow1.yml'].immutable).toHaveLength(1);
      expect(result.byWorkflow['workflow2.yml'].immutable).toHaveLength(1);
    });

    test('should handle first-party actions without API calls', async () => {
      const actions = [
        {
          uses: 'actions/checkout@v4',
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          workflowFile: 'workflow1.yml',
          isFirstParty: true
        },
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow1.yml',
          isFirstParty: false
        }
      ];

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: true }
      });

      const result = await checkAllActions(mockOctokit, actions);

      // Should only call API once (for third-party action)
      expect(mockOctokit.rest.repos.getReleaseByTag).toHaveBeenCalledTimes(1);

      // First-party actions should be in firstParty array with allowed/reason
      expect(result.firstParty).toHaveLength(1);
      expect(result.firstParty[0].owner).toBe('actions');
      expect(result.firstParty[0].message).toBe('Excluded (first-party)');
      expect(result.firstParty[0].isFirstParty).toBe(true);
      expect(result.firstParty[0].allowed).toBe(true);

      // Third-party action should be in immutable array
      expect(result.immutable).toHaveLength(1);
      expect(result.immutable[0].owner).toBe('owner');

      // Check byWorkflow grouping includes firstParty
      expect(result.byWorkflow['workflow1.yml'].firstParty).toHaveLength(1);
      expect(result.byWorkflow['workflow1.yml'].immutable).toHaveLength(1);
    });

    test('should deduplicate same action used multiple times within a workflow', async () => {
      const actions = [
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow1.yml',
          isFirstParty: false
        },
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow1.yml',
          isFirstParty: false
        },
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow1.yml',
          isFirstParty: false
        }
      ];

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: true }
      });

      const result = await checkAllActions(mockOctokit, actions);

      // Should only call API once (same action)
      expect(mockOctokit.rest.repos.getReleaseByTag).toHaveBeenCalledTimes(1);

      // Global array should have 1 entry (deduplicated across all)
      expect(result.immutable).toHaveLength(1);

      // byWorkflow should also have 1 entry (deduplicated within workflow)
      expect(result.byWorkflow['workflow1.yml'].immutable).toHaveLength(1);
      expect(result.byWorkflow['workflow1.yml'].immutable[0].uses).toBe('owner/repo@v1');
    });

    test('should preserve all caller-side source locations when deduplicating within a workflow', async () => {
      const actions = [
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow1.yml',
          jobName: 'lint',
          stepName: 'First use',
          sourceWorkflowFile: 'workflow1.yml',
          sourceJobName: 'lint',
          sourceStepName: 'First use',
          isFirstParty: false
        },
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow1.yml',
          jobName: 'test',
          stepName: 'Second use',
          sourceWorkflowFile: 'workflow1.yml',
          sourceJobName: 'test',
          sourceStepName: 'Second use',
          isFirstParty: false
        }
      ];

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: true }
      });

      const result = await checkAllActions(mockOctokit, actions);

      expect(result.byWorkflow['workflow1.yml'].immutable).toHaveLength(1);
      expect(result.byWorkflow['workflow1.yml'].immutable[0].sourceLocations).toEqual([
        {
          workflowFile: 'workflow1.yml',
          jobName: 'lint',
          stepName: 'First use'
        },
        {
          workflowFile: 'workflow1.yml',
          jobName: 'test',
          stepName: 'Second use'
        }
      ]);
    });

    test('should deduplicate first-party actions within a workflow', async () => {
      const actions = [
        {
          uses: 'actions/checkout@v4',
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          workflowFile: 'ci.yml',
          isFirstParty: true
        },
        {
          uses: 'actions/checkout@v4',
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          workflowFile: 'ci.yml',
          isFirstParty: true
        },
        {
          uses: 'actions/setup-node@v4',
          owner: 'actions',
          repo: 'setup-node',
          ref: 'v4',
          workflowFile: 'ci.yml',
          isFirstParty: true
        }
      ];

      const result = await checkAllActions(mockOctokit, actions);

      // Should not call API for first-party actions
      expect(mockOctokit.rest.repos.getReleaseByTag).not.toHaveBeenCalled();

      // Global firstParty array should have 2 unique entries
      expect(result.firstParty).toHaveLength(2);
      expect(result.firstParty[0].uses).toBe('actions/checkout@v4');
      expect(result.firstParty[1].uses).toBe('actions/setup-node@v4');

      // byWorkflow should also have 2 unique entries (deduplicated within workflow)
      expect(result.byWorkflow['ci.yml'].firstParty).toHaveLength(2);
      expect(result.byWorkflow['ci.yml'].firstParty[0].uses).toBe('actions/checkout@v4');
      expect(result.byWorkflow['ci.yml'].firstParty[1].uses).toBe('actions/setup-node@v4');
    });

    test('should check first-party actions via API when includeFirstParty is true', async () => {
      const actions = [
        {
          uses: 'actions/checkout@v4',
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          workflowFile: 'workflow1.yml',
          isFirstParty: true
        },
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          workflowFile: 'workflow1.yml',
          isFirstParty: false
        }
      ];

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: true }
      });

      const result = await checkAllActions(mockOctokit, actions, true);

      // Should call API for both actions
      expect(mockOctokit.rest.repos.getReleaseByTag).toHaveBeenCalledTimes(2);

      // firstParty array should contain the checked first-party action with allowed/reason
      expect(result.firstParty).toHaveLength(1);
      expect(result.firstParty[0].owner).toBe('actions');
      expect(result.firstParty[0].allowed).toBe(true);
      expect(result.firstParty[0].message).toBe('Immutable release');

      // Both should be in immutable array
      expect(result.immutable).toHaveLength(2);

      // First-party action should preserve isFirstParty flag
      const checkoutAction = result.immutable.find(a => a.owner === 'actions');
      expect(checkoutAction.isFirstParty).toBe(true);
      const thirdPartyAction = result.immutable.find(a => a.owner === 'owner');
      expect(thirdPartyAction.isFirstParty).toBe(false);

      // byWorkflow should have no firstParty, both in immutable
      expect(result.byWorkflow['workflow1.yml'].firstParty).toHaveLength(0);
      expect(result.byWorkflow['workflow1.yml'].immutable).toHaveLength(2);
    });

    test('should report first-party actions as mutable when includeFirstParty is true and release is mutable', async () => {
      const actions = [
        {
          uses: 'actions/checkout@v4',
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          workflowFile: 'ci.yml',
          isFirstParty: true
        }
      ];

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: false }
      });

      const result = await checkAllActions(mockOctokit, actions, true);

      // firstParty should have the action with allowed: false
      expect(result.firstParty).toHaveLength(1);
      expect(result.firstParty[0].allowed).toBe(false);
      expect(result.firstParty[0].message).toBe('Mutable release');
      expect(result.mutable).toHaveLength(1);
      expect(result.mutable[0].owner).toBe('actions');
      expect(result.byWorkflow['ci.yml'].mutable).toHaveLength(1);
    });

    test('should report unsupported references separately', async () => {
      const actions = [
        {
          uses: './local-action',
          supported: false,
          unsupportedType: 'local-action',
          message: 'Unsupported reference type: local action',
          workflowFile: 'workflow1.yml'
        },
        {
          uses: 'docker://alpine:3.8',
          supported: false,
          unsupportedType: 'protocol',
          message: 'Unsupported reference type: docker://',
          workflowFile: 'workflow1.yml'
        },
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1',
          supported: true,
          workflowFile: 'workflow1.yml',
          isFirstParty: false
        }
      ];

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: true }
      });

      const result = await checkAllActions(mockOctokit, actions);

      expect(result.unsupported).toHaveLength(2);
      expect(result.unsupported[0].uses).toBe('./local-action');
      expect(result.unsupported[1].uses).toBe('docker://alpine:3.8');
      expect(result.immutable).toHaveLength(1);
      expect(result.mutable).toHaveLength(0);
      expect(result.byWorkflow['workflow1.yml'].unsupported).toHaveLength(2);
    });
  });

  describe('expandActionReferences', () => {
    test('should recurse into remote composite actions', async () => {
      mockOctokit.rest.repos.getContent.mockImplementation(async ({ path: remotePath }) => {
        const files = {
          'path/to/action/action.yml': `
name: Remote Composite
runs:
  using: composite
  steps:
    - uses: owner/nested-action@v2
`,
          'action.yml': `
name: Nested Action
runs:
  using: node24
  main: index.js
`
        };

        if (!files[remotePath]) {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }

        return {
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(files[remotePath], 'utf8').toString('base64')
          }
        };
      });

      const actions = [
        {
          uses: 'owner/repo/path/to/action@v1',
          owner: 'owner',
          repo: 'repo',
          actionPath: 'path/to/action',
          ref: 'v1',
          workflowFile: 'ci.yml',
          supported: true,
          isFirstParty: false
        }
      ];

      const result = await expandActionReferences(mockOctokit, actions, {
        workspaceDir: '/tmp/workspace',
        expansionCache: new Map(),
        expansionStack: new Set()
      });

      expect(result).toHaveLength(2);
      expect(result[1]).toMatchObject({
        uses: 'owner/nested-action@v2',
        owner: 'owner',
        repo: 'nested-action',
        actionPath: '',
        ref: 'v2',
        workflowFile: 'ci.yml',
        supported: true
      });
    });

    test('should recurse into remote reusable workflows', async () => {
      mockOctokit.rest.repos.getContent.mockImplementation(async ({ path: remotePath }) => {
        const files = {
          '.github/workflows/reusable.yml': `
name: Reusable
on:
  workflow_call:
jobs:
  nested:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/nested-action@v2
`,
          'action.yml': `
name: Nested Action
runs:
  using: node24
  main: index.js
`
        };

        if (!files[remotePath]) {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }

        return {
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(files[remotePath], 'utf8').toString('base64')
          }
        };
      });

      const actions = [
        {
          uses: 'owner/repo/.github/workflows/reusable.yml@v1',
          owner: 'owner',
          repo: 'repo',
          actionPath: '.github/workflows/reusable.yml',
          ref: 'v1',
          workflowFile: 'ci.yml',
          sourceWorkflowFile: 'ci.yml',
          sourceJobName: 'call-reusable',
          supported: true,
          isFirstParty: false
        }
      ];

      const result = await expandActionReferences(mockOctokit, actions, {
        workspaceDir: '/tmp/workspace',
        expansionCache: new Map(),
        expansionStack: new Set()
      });

      expect(result).toHaveLength(2);
      expect(result[1]).toMatchObject({
        uses: 'owner/nested-action@v2',
        owner: 'owner',
        repo: 'nested-action',
        actionPath: '',
        ref: 'v2',
        workflowFile: 'ci.yml',
        entrypointUses: 'owner/repo/.github/workflows/reusable.yml@v1',
        jobName: 'nested',
        stepName: 'unnamed step',
        sourceWorkflowFile: 'ci.yml',
        sourceJobName: 'call-reusable',
        supported: true
      });
    });

    test('should respect excluded workflows throughout remote reusable traversal', async () => {
      mockOctokit.rest.repos.getContent.mockImplementation(async ({ path: remotePath }) => {
        const files = {
          '.github/workflows/reusable.yml': `
name: Reusable
on:
  workflow_call:
jobs:
  direct:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/direct-action@v2
  nested:
    uses: owner/repo/.github/workflows/excluded-child.yml@v1
`,
          'action.yml': `
name: Nested Action
runs:
  using: node24
  main: index.js
`
        };

        if (!files[remotePath]) {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }

        return {
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(files[remotePath], 'utf8').toString('base64')
          }
        };
      });

      const actions = [
        {
          uses: 'owner/repo/.github/workflows/reusable.yml@v1',
          owner: 'owner',
          repo: 'repo',
          actionPath: '.github/workflows/reusable.yml',
          ref: 'v1',
          workflowFile: 'ci.yml',
          sourceWorkflowFile: 'ci.yml',
          sourceJobName: 'call-reusable',
          supported: true,
          isFirstParty: false
        }
      ];

      const result = await expandActionReferences(mockOctokit, actions, {
        workspaceDir: '/tmp/workspace',
        excludeWorkflowPatterns: ['excluded-child.yml'],
        expansionCache: new Map(),
        expansionStack: new Set()
      });

      expect(result).toHaveLength(2);
      expect(result[0].uses).toBe('owner/repo/.github/workflows/reusable.yml@v1');
      expect(result[1]).toMatchObject({
        uses: 'owner/direct-action@v2',
        owner: 'owner',
        repo: 'direct-action',
        actionPath: '',
        ref: 'v2',
        workflowFile: 'ci.yml',
        entrypointUses: 'owner/repo/.github/workflows/reusable.yml@v1',
        jobName: 'direct',
        stepName: 'unnamed step',
        sourceWorkflowFile: 'ci.yml',
        sourceJobName: 'call-reusable',
        supported: true
      });
    });

    test('should resolve remote composite local paths relative to the remote repo root', async () => {
      mockOctokit.rest.repos.getContent.mockImplementation(async ({ path: remotePath }) => {
        const files = {
          'actions/parent/action.yml': `
name: Parent
runs:
  using: composite
  steps:
    - uses: ./.github/actions/child
`,
          '.github/actions/child/action.yml': `
name: Child
runs:
  using: composite
  steps:
    - uses: child-owner/child-action@v3
`,
          'action.yml': `
name: Terminal Action
runs:
  using: node24
  main: index.js
`
        };

        if (!files[remotePath]) {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }

        return {
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(files[remotePath], 'utf8').toString('base64')
          }
        };
      });

      const actions = [
        {
          uses: 'owner/repo/actions/parent@v1',
          owner: 'owner',
          repo: 'repo',
          actionPath: 'actions/parent',
          ref: 'v1',
          workflowFile: 'ci.yml',
          supported: true,
          isFirstParty: false
        }
      ];

      const result = await expandActionReferences(mockOctokit, actions, {
        workspaceDir: '/tmp/workspace',
        expansionCache: new Map(),
        expansionStack: new Set()
      });

      expect(result.some(action => action.uses === 'child-owner/child-action@v3')).toBe(true);
      expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          path: '.github/actions/child/action.yml',
          ref: 'v1'
        })
      );
    });

    test('should resolve reusable workflow local paths relative to the remote repo', async () => {
      mockOctokit.rest.repos.getContent.mockImplementation(async ({ path: remotePath }) => {
        const files = {
          '.github/workflows/reusable.yml': `
name: Reusable
on:
  workflow_call:
jobs:
  nested:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/local-from-workflow
`,
          '.github/actions/local-from-workflow/action.yml': `
name: Local From Workflow
runs:
  using: composite
  steps:
    - uses: local-owner/local-action@v4
`
        };

        if (!files[remotePath]) {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }

        return {
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(files[remotePath], 'utf8').toString('base64')
          }
        };
      });

      const actions = [
        {
          uses: 'owner/repo/.github/workflows/reusable.yml@v1',
          owner: 'owner',
          repo: 'repo',
          actionPath: '.github/workflows/reusable.yml',
          ref: 'v1',
          workflowFile: 'ci.yml',
          supported: true,
          isFirstParty: false
        }
      ];

      const result = await expandActionReferences(mockOctokit, actions, {
        workspaceDir: '/tmp/phase4-reusable-local-workspace',
        expansionCache: new Map(),
        expansionStack: new Set()
      });

      expect(result.some(action => action.uses === 'local-owner/local-action@v4')).toBe(true);
    });

    test('should skip remote docker actions without reporting as unsupported', async () => {
      mockOctokit.rest.repos.getContent.mockImplementation(async ({ path: remotePath }) => {
        const files = {
          'action.yml': `
name: Docker Action
runs:
  using: docker
  image: Dockerfile
`
        };

        if (!files[remotePath]) {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }

        return {
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(files[remotePath], 'utf8').toString('base64')
          }
        };
      });

      const actions = [
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          actionPath: '',
          ref: 'v1',
          workflowFile: 'ci.yml',
          supported: true,
          isFirstParty: false
        }
      ];

      const result = await expandRemoteReference(mockOctokit, actions[0], {
        workspaceDir: '/tmp/workspace',
        expansionCache: new Map(),
        expansionStack: new Set()
      });

      expect(result).toEqual([]);
    });

    test('should not report node-based remote actions as unsupported', async () => {
      mockOctokit.rest.repos.getContent.mockImplementation(async ({ path: remotePath }) => {
        const files = {
          'action.yml': `
name: Node Action
runs:
  using: node24
  main: index.js
`
        };

        if (!files[remotePath]) {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }

        return {
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(files[remotePath], 'utf8').toString('base64')
          }
        };
      });

      const actions = [
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          actionPath: '',
          ref: 'v1',
          workflowFile: 'ci.yml',
          supported: true,
          isFirstParty: false
        }
      ];

      const result = await expandRemoteReference(mockOctokit, actions[0], {
        workspaceDir: '/tmp/workspace',
        expansionCache: new Map(),
        expansionStack: new Set()
      });

      expect(result).toEqual([]);
    });
  });

  describe('Action execution', () => {
    const testWorkspaceDir = '/tmp/test-action-workspace';
    const testWorkflowsDir = path.join(testWorkspaceDir, '.github', 'workflows');

    beforeEach(() => {
      // Set workspace
      process.env.GITHUB_WORKSPACE = testWorkspaceDir;

      // Create test directory structure
      if (!fs.existsSync(testWorkflowsDir)) {
        fs.mkdirSync(testWorkflowsDir, { recursive: true });
      }

      // Create a test workflow
      const workflowContent = `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: third-party/action@v1
`;
      fs.writeFileSync(path.join(testWorkflowsDir, 'ci.yml'), workflowContent);
    });

    afterEach(() => {
      // Clean up
      if (fs.existsSync(testWorkspaceDir)) {
        fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
      }
      delete process.env.GITHUB_WORKSPACE;
    });

    test('should complete successfully with immutable actions', async () => {
      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: true }
      });

      await run();

      expect(mockCore.setOutput).toHaveBeenCalledWith('all-passed', true);
      expect(mockCore.setOutput).toHaveBeenCalledWith('mutable-actions', expect.stringContaining('[]'));
      expect(mockCore.setFailed).not.toHaveBeenCalled();
    });

    test('should fail with mutable actions when fail-on-mutable is true', async () => {
      mockCore.getBooleanInput.mockImplementation(name => {
        if (name === 'fail-on-mutable') return true;
        if (name === 'include-first-party') return false;
        return true;
      });
      mockCore.getInput.mockImplementation(name => {
        const inputs = {
          'github-token': 'test-token'
        };
        return inputs[name] || '';
      });

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: false }
      });

      await run();

      expect(mockCore.setOutput).toHaveBeenCalledWith('all-passed', false);
      expect(mockCore.setFailed).toHaveBeenCalled();
    });

    test('should not fail with mutable actions when fail-on-mutable is false', async () => {
      mockCore.getBooleanInput.mockImplementation(name => {
        if (name === 'fail-on-mutable') return false;
        if (name === 'include-first-party') return false;
        return true;
      });
      mockCore.getInput.mockImplementation(name => {
        const inputs = {
          'github-token': 'test-token'
        };
        return inputs[name] || '';
      });

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: false }
      });

      await run();

      expect(mockCore.setOutput).toHaveBeenCalledWith('all-passed', false);
      expect(mockCore.setFailed).not.toHaveBeenCalled();
    });

    test('should fail when github-token is not provided', async () => {
      mockCore.getInput.mockReturnValue('');
      // Clear environment variable to ensure no fallback
      delete process.env.INPUT_GITHUB_TOKEN;

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith('github-token is required (defaults to github.token)');
    });

    test('should handle no workflows found', async () => {
      // Remove workflows directory
      fs.rmSync(testWorkflowsDir, { recursive: true, force: true });

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('No workflow files found'));
      expect(mockCore.setOutput).toHaveBeenCalledWith('all-passed', true);
    });

    test('should handle workflows with only first-party actions', async () => {
      // Create workflow with only actions/* actions
      const workflowContent = `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
`;
      fs.writeFileSync(path.join(testWorkflowsDir, 'ci.yml'), workflowContent);

      await run();

      // Should now process first-party actions
      expect(mockCore.info).not.toHaveBeenCalledWith(expect.stringContaining('No third-party actions found'));
      expect(mockCore.setOutput).toHaveBeenCalledWith('all-passed', true);
    });

    test('should report unsupported references without failing on mutable-only policy', async () => {
      const workflowContent = `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./local-action
      - uses: docker://alpine:3.8
      - uses: owner/repo@1234567890abcdef1234567890abcdef12345678
`;
      fs.writeFileSync(path.join(testWorkflowsDir, 'ci.yml'), workflowContent);

      await run();

      expect(mockCore.setOutput).toHaveBeenCalledWith('all-passed', false);
      const unsupportedCall = mockCore.setOutput.mock.calls.find(c => c[0] === 'unsupported-actions');
      const unsupportedOutput = JSON.parse(unsupportedCall[1]);
      expect(unsupportedOutput).toHaveLength(2);
      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('unsupported action reference'));
    });

    test('should recurse into local composite actions during action execution', async () => {
      const localActionDir = path.join(testWorkspaceDir, '.github', 'actions', 'composite');
      fs.mkdirSync(localActionDir, { recursive: true });

      fs.writeFileSync(
        path.join(testWorkflowsDir, 'ci.yml'),
        `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/composite
`
      );

      fs.writeFileSync(
        path.join(localActionDir, 'action.yml'),
        `
name: Composite
runs:
  using: composite
  steps:
    - uses: owner/repo@1234567890abcdef1234567890abcdef12345678
`
      );

      mockOctokit.rest.repos.getContent.mockImplementation(async ({ owner, repo, path: remotePath }) => {
        if (owner === 'owner' && repo === 'repo' && remotePath === 'action.yml') {
          return {
            data: {
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(
                `
name: Terminal Action
runs:
  using: node24
  main: index.js
`,
                'utf8'
              ).toString('base64')
            }
          };
        }

        const error = new Error('Not Found');
        error.status = 404;
        throw error;
      });

      await run();

      const allPassedCall = mockCore.setOutput.mock.calls.find(c => c[0] === 'all-passed');
      expect(allPassedCall).toEqual(['all-passed', true]);
      const immutableCall = mockCore.setOutput.mock.calls.find(c => c[0] === 'immutable-actions');
      const immutableOutput = JSON.parse(immutableCall[1]);
      expect(immutableOutput).toHaveLength(1);
      expect(immutableOutput[0].uses).toBe('owner/repo@1234567890abcdef1234567890abcdef12345678');
      const unsupportedCall = mockCore.setOutput.mock.calls.find(c => c[0] === 'unsupported-actions');
      expect(JSON.parse(unsupportedCall[1])).toHaveLength(0);
    });

    test('should check first-party actions when include-first-party is true', async () => {
      mockCore.getBooleanInput.mockImplementation(name => {
        if (name === 'fail-on-mutable') return true;
        if (name === 'include-first-party') return true;
        return true;
      });

      // Create workflow with only first-party actions
      const workflowContent = `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
      fs.writeFileSync(path.join(testWorkflowsDir, 'ci.yml'), workflowContent);

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: false }
      });

      await run();

      // First-party action should be API-checked
      expect(mockOctokit.rest.repos.getReleaseByTag).toHaveBeenCalledTimes(1);

      // Should fail since the first-party action has a mutable release
      expect(mockCore.setOutput).toHaveBeenCalledWith('all-passed', false);
      expect(mockCore.setFailed).toHaveBeenCalled();

      // first-party-actions should contain the action with allowed/reason
      const firstPartyCall = mockCore.setOutput.mock.calls.find(c => c[0] === 'first-party-actions');
      const firstPartyOutput = JSON.parse(firstPartyCall[1]);
      expect(firstPartyOutput).toHaveLength(1);
      expect(firstPartyOutput[0].allowed).toBe(false);
      expect(firstPartyOutput[0].message).toBe('Mutable release');
    });
  });
});
