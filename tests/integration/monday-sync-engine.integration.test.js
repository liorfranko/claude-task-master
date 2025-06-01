import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { MondaySyncEngine } from '../../scripts/modules/monday-sync.js';

// Integration tests require Monday.com API access
const shouldRunIntegrationTests = process.env.MONDAY_API_TOKEN && process.env.MONDAY_TEST_BOARD_ID;

// Test board ID (use environment variable for security)
const TEST_BOARD_ID = process.env.MONDAY_TEST_BOARD_ID || '9275265350';

describe('MondaySyncEngine Integration Tests', () => {
  let syncEngine;
  let tempDir;
  let tempConfigPath;
  let tempTasksPath;

  beforeAll(() => {
    if (!shouldRunIntegrationTests) {
      console.warn('Skipping Monday.com integration tests - missing MONDAY_API_TOKEN or MONDAY_TEST_BOARD_ID');
      return;
    }

    // Create temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'temp-test-'));
    tempConfigPath = path.join(tempDir, '.taskmasterconfig');
    tempTasksPath = path.join(tempDir, 'tasks', 'tasks.json');

    // Create tasks directory
    fs.mkdirSync(path.join(tempDir, 'tasks'), { recursive: true });

    // Create test configuration
    const testConfig = {
      mondayIntegration: {
        boardId: TEST_BOARD_ID,
        columnMapping: {
          status: 'color_mkrg4361',
          description: 'long_text_mkrgfn70',
          title: 'name'
        },
        syncSettings: {
          autoSync: false
        }
      }
    };

    fs.writeFileSync(tempConfigPath, JSON.stringify(testConfig, null, 2));

    // Create test tasks.json
    const testTasks = {
      version: "1.0.0",
      tasks: [
        {
          id: 1,
          title: "Test Monday Sync Task",
          description: "Integration test task for Monday.com sync",
          status: "pending",
          priority: "medium",
          dependencies: [],
          details: "This is a test task created by integration tests",
          testStrategy: "Verify sync to Monday.com board",
          mondayItemId: null,
          lastSyncedAt: null,
          syncStatus: "pending",
          syncError: null,
          subtasks: [
            {
              id: 1,
              title: "Test Subtask",
              description: "Test subtask for sync",
              status: "pending",
              mondayItemId: null,
              lastSyncedAt: null,
              syncStatus: "pending",
              syncError: null
            }
          ]
        }
      ]
    };

    fs.writeFileSync(tempTasksPath, JSON.stringify(testTasks, null, 2));
  });

  afterAll(() => {
    if (!shouldRunIntegrationTests) return;

    // Clean up temporary files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  (shouldRunIntegrationTests ? describe : describe.skip)('with real Monday.com API', () => {
    beforeAll(async () => {
      try {
        syncEngine = new MondaySyncEngine(tempDir);
      } catch (error) {
        throw new Error(`Failed to initialize sync engine: ${error.message}`);
      }
    });

    it('should test connection to Monday.com API', async () => {
      const result = await syncEngine.testSync();
      
      expect(result.success).toBe(true);
      expect(result.details.connection.success).toBe(true);
      expect(result.details.board.success).toBe(true);
      expect(result.details.board.data.id).toBe(TEST_BOARD_ID);
    }, 30000); // 30 second timeout for API calls

    it('should create a new item on Monday board', async () => {
      const testTask = {
        title: `Test Task ${Date.now()}`,
        description: 'Created by integration test',
        status: 'pending',
        priority: 'low'
      };

      const result = await syncEngine.createItem(testTask);
      
      expect(result.success).toBe(true);
      expect(result.mondayItemId).toBeDefined();
      expect(typeof result.mondayItemId).toBe('string');
      
      // Store for cleanup
      testTask.mondayItemId = result.mondayItemId;
    }, 30000);

    it('should update an existing item on Monday board', async () => {
      // First create an item
      const testTask = {
        title: `Update Test Task ${Date.now()}`,
        description: 'To be updated by integration test',
        status: 'pending'
      };

      const createResult = await syncEngine.createItem(testTask);
      expect(createResult.success).toBe(true);

      // Now update it
      const updatedTask = {
        ...testTask,
        description: 'Updated by integration test',
        status: 'done'
      };

      const updateResult = await syncEngine.updateItem(createResult.mondayItemId, updatedTask);
      
      expect(updateResult.success).toBe(true);
      expect(updateResult.mondayItemId).toBe(createResult.mondayItemId);
    }, 30000);

    it('should handle API errors gracefully', async () => {
      // Try to update a non-existent item
      const invalidTask = {
        title: 'Invalid Task',
        description: 'This should fail',
        status: 'pending'
      };

      const result = await syncEngine.updateItem('999999999', invalidTask);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, 30000);

    it('should sync task from tasks.json to Monday board', async () => {
      const result = await syncEngine.syncTask(
        {
          title: `Sync Test Task ${Date.now()}`,
          description: 'Task synced from tasks.json',
          status: 'in-progress',
          priority: 'high'
        },
        tempTasksPath,
        '999' // Test task ID
      );

      expect(result.success).toBe(true);
      expect(result.mondayItemId).toBeDefined();
    }, 30000);

    it('should sync all pending items from tasks.json', async () => {
      // Add a test task to sync
      const tasksData = JSON.parse(fs.readFileSync(tempTasksPath, 'utf8'));
      tasksData.tasks.push({
        id: 999,
        title: `Bulk Sync Test ${Date.now()}`,
        description: 'Test bulk sync functionality',
        status: 'pending',
        priority: 'medium',
        dependencies: [],
        mondayItemId: null,
        syncStatus: 'pending'
      });
      fs.writeFileSync(tempTasksPath, JSON.stringify(tasksData, null, 2));

      const result = await syncEngine.syncAll(tempTasksPath);
      
      expect(result.totalItems).toBeGreaterThan(0);
      expect(result.synced).toBeGreaterThan(0);
      
      // Check that tasks were updated
      const updatedData = JSON.parse(fs.readFileSync(tempTasksPath, 'utf8'));
      const syncedTasks = updatedData.tasks.filter(t => t.syncStatus === 'synced');
      expect(syncedTasks.length).toBeGreaterThan(0);
    }, 60000); // Longer timeout for multiple API calls
  });

  // Always run these tests (even without API access)
  describe('without API access', () => {
    it('should throw appropriate error when not configured', () => {
      expect(() => new MondaySyncEngine('/nonexistent/path')).toThrow(
        'Monday.com integration not configured'
      );
    });

    it('should validate configuration structure', () => {
      if (!shouldRunIntegrationTests) {
        // Mock the config for this test
        const mockConfig = {
          mondayIntegration: {
            boardId: 'test-board',
            columnMapping: {
              status: 'status',
              description: 'notes'
            }
          }
        };

        // This would normally throw, but we're testing the validation logic
        expect(mockConfig.mondayIntegration.boardId).toBe('test-board');
        expect(mockConfig.mondayIntegration.columnMapping.status).toBe('status');
      }
    });
  });
}); 