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
      getReleaseByTag: jest.fn()
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
  getWorkflowFiles,
  checkReleaseImmutability,
  checkAllActions,
  getInput,
  getBooleanInput,
  isFullSHA
} = await import('../src/index.js');

describe('Ensure Immutable Actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset Octokit mock
    mockOctokit.rest.repos.getReleaseByTag.mockClear();

    // Set default inputs
    mockCore.getInput.mockImplementation(name => {
      const inputs = {
        'github-token': 'test-token',
        'fail-on-mutable': 'true',
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
        ref: 'v4'
      });
    });

    test('should parse action with path', () => {
      const result = parseActionReference('owner/repo/path@v1');
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'v1'
      });
    });

    test('should parse action with full 40-char SHA reference', () => {
      // GitHub Actions requires full 40-char SHA for commit references
      const result = parseActionReference('actions/checkout@1234567890abcdef1234567890abcdef12345678');
      expect(result).toEqual({
        owner: 'actions',
        repo: 'checkout',
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

      // Should only include third-party actions (not actions/*)
      expect(actions).toHaveLength(2);
      expect(actions[0].owner).toBe('joshjohanning');
      expect(actions[0].repo).toBe('npm-version-check-action');
      expect(actions[0].ref).toBe('v1');
      expect(actions[0].stepName).toBe('Check npm version');

      expect(actions[1].owner).toBe('third-party');

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

    test('should skip local and docker actions', () => {
      const workflowContent = `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./local-action
      - uses: docker://alpine:3.8
      - uses: third-party/action@v1
`;

      const tempFile = '/tmp/test-workflow-mixed.yml';
      fs.writeFileSync(tempFile, workflowContent);

      const actions = extractActionsFromWorkflow(tempFile);
      expect(actions).toHaveLength(1);
      expect(actions[0].owner).toBe('third-party');

      fs.unlinkSync(tempFile);
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

    test('should warn when specified workflow not found', () => {
      const files = getWorkflowFiles('nonexistent.yml', '', testWorkspaceDir);
      expect(files).toHaveLength(0);
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    test('should warn when workflows directory not found', () => {
      const files = getWorkflowFiles('', '', '/nonexistent/workspace');
      expect(files).toHaveLength(0);
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('not found'));
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
          ref: 'v1'
        },
        {
          uses: 'owner2/repo2@v2',
          owner: 'owner2',
          repo: 'repo2',
          ref: 'v2'
        },
        {
          uses: 'owner3/repo3@v3',
          owner: 'owner3',
          repo: 'repo3',
          ref: 'v3'
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
    });

    test('should deduplicate actions by uses string', async () => {
      const actions = [
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1'
        },
        {
          uses: 'owner/repo@v1',
          owner: 'owner',
          repo: 'repo',
          ref: 'v1'
        },
        {
          uses: 'owner/repo@v2',
          owner: 'owner',
          repo: 'repo',
          ref: 'v2'
        }
      ];

      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { immutable: true }
      });

      await checkAllActions(mockOctokit, actions);

      // Should only call API twice (for v1 and v2), not three times
      expect(mockOctokit.rest.repos.getReleaseByTag).toHaveBeenCalledTimes(2);
    });
  });

  describe('getInput and getBooleanInput', () => {
    test('getInput should work with core.getInput', () => {
      mockCore.getInput.mockReturnValue('test-value');
      expect(getInput('test-input')).toBe('test-value');
    });

    test('getInput should fallback to environment variable', () => {
      mockCore.getInput.mockReturnValue('');
      process.env.INPUT_TEST_INPUT = 'env-value';
      expect(getInput('test-input')).toBe('env-value');
      delete process.env.INPUT_TEST_INPUT;
    });

    test('getBooleanInput should handle true values', () => {
      mockCore.getInput.mockReturnValue('true');
      expect(getBooleanInput('test')).toBe(true);

      mockCore.getInput.mockReturnValue('1');
      expect(getBooleanInput('test')).toBe(true);

      mockCore.getInput.mockReturnValue('yes');
      expect(getBooleanInput('test')).toBe(true);
    });

    test('getBooleanInput should handle false values', () => {
      mockCore.getInput.mockReturnValue('false');
      expect(getBooleanInput('test')).toBe(false);

      mockCore.getInput.mockReturnValue('0');
      expect(getBooleanInput('test')).toBe(false);

      mockCore.getInput.mockReturnValue('');
      expect(getBooleanInput('test')).toBe(false);
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
      mockCore.getInput.mockImplementation(name => {
        const inputs = {
          'github-token': 'test-token',
          'fail-on-mutable': 'true'
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
      mockCore.getInput.mockImplementation(name => {
        const inputs = {
          'github-token': 'test-token',
          'fail-on-mutable': 'false'
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

      expect(mockCore.setFailed).toHaveBeenCalledWith('github-token is required');
    });

    test('should handle no workflows found', async () => {
      // Remove workflows directory
      fs.rmSync(testWorkflowsDir, { recursive: true, force: true });

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('No workflow files found'));
      expect(mockCore.setOutput).toHaveBeenCalledWith('all-passed', true);
    });

    test('should handle workflows with no third-party actions', async () => {
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

      expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('No third-party actions found'));
      expect(mockCore.setOutput).toHaveBeenCalledWith('all-passed', true);
    });
  });
});
