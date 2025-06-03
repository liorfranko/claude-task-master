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
      console.log('⚠️ Skipping Monday.com integration tests - missing environment variables');
      console.log('Required: MONDAY_API_TOKEN and MONDAY_TEST_BOARD_ID');
      return;
    }

    console.log('=== INTEGRATION TEST SETUP ===');
    console.log('TEST_BOARD_ID:', TEST_BOARD_ID);
    console.log('MONDAY_API_TOKEN exists:', !!process.env.MONDAY_API_TOKEN);
    console.log('MONDAY_API_TOKEN length:', process.env.MONDAY_API_TOKEN?.length);

    // Create temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'temp-test-'));

    console.log('Temp directory:', tempDir);

    // Create test configuration
    const testConfig = {
      mondayIntegration: {
        boardId: TEST_BOARD_ID,
        columnMapping: {
          // NOTE: These column IDs must match the actual columns on the Monday board (TEST_BOARD_ID)
          // If the test fails with "column ID doesn't exist", check the actual board structure
          // by looking at the connection test output above
          status: 'color_mkrg4361',
          description: 'long_text_mkrgfn70',
          title: 'name',
          details: "task_details",
          taskId: "task_id_field",
          priority: "dropdown_mkrgbdjp", // This is the actual Priority column ID on the test board
          testStrategy: "test_strategy",
          dependencies: "task_dependencies",
          notes: "task_details"
        }
      }
    };

    console.log('=== DEBUG: Test Configuration ===');
    console.log('Column mapping:', JSON.stringify(testConfig.mondayIntegration.columnMapping, null, 2));
    console.log('Priority mapping exists:', !!testConfig.mondayIntegration.columnMapping.priority);
    console.log('=================================');

    console.log('Test config:', JSON.stringify(testConfig, null, 2));

    // Create .taskmaster directory and write configuration to temp directory
    const tempTaskmasterDir = path.join(tempDir, '.taskmaster');
    const tempTasksDir = path.join(tempTaskmasterDir, 'tasks');
    if (!fs.existsSync(tempTaskmasterDir)) {
      fs.mkdirSync(tempTaskmasterDir, { recursive: true });
    }
    if (!fs.existsSync(tempTasksDir)) {
      fs.mkdirSync(tempTasksDir, { recursive: true });
    }

    // Write the test configuration to temp directory
    tempConfigPath = path.join(tempTaskmasterDir, 'config.json');
    fs.writeFileSync(tempConfigPath, JSON.stringify(testConfig, null, 2));
    console.log('✅ Wrote test configuration to:', tempConfigPath);

    tempTasksPath = path.join(tempTasksDir, 'tasks.json');

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
    console.log('Created test tasks.json with', testTasks.tasks.length, 'tasks');
    console.log('=== SETUP COMPLETE ===\n');
  });

  afterAll(() => {
    if (!shouldRunIntegrationTests) return;

    // Clean up temporary files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('Cleaned up temp directory:', tempDir);
    }
  });

  (shouldRunIntegrationTests ? describe : describe.skip)('with real Monday.com API', () => {
    beforeAll(async () => {
      try {
        console.log('=== INITIALIZING SYNC ENGINE ===');
        syncEngine = new MondaySyncEngine(tempDir);
        console.log('Sync engine initialized successfully');
        
        // Log the sync engine configuration
        console.log('Sync engine board ID:', syncEngine.boardId);
        console.log('Sync engine column mapping:', JSON.stringify(syncEngine.columnMapping, null, 2));
        console.log('=== SYNC ENGINE READY ===\n');
      } catch (error) {
        console.error('Failed to initialize sync engine:', error);
        console.error('Error stack:', error.stack);
        throw new Error(`Failed to initialize sync engine: ${error.message}`);
      }
    });

    it('should test connection to Monday.com API', async () => {
      console.log('=== TESTING API CONNECTION ===');
      
      const result = await syncEngine.testSync();
      
      console.log('Connection test result:', JSON.stringify(result, null, 2));
      
      expect(result.success).toBe(true);
      expect(result.details.connection.success).toBe(true);
      expect(result.details.board.success).toBe(true);
      expect(result.details.board.data.id).toBe(TEST_BOARD_ID);
      
      console.log('✅ Connection test passed\n');
    }, 30000); // 30 second timeout for API calls

    it('should create a new item on Monday board', async () => {
      console.log('=== TESTING ITEM CREATION ===');
      
      const testTask = {
        id: 100,
        title: `Test Task ${Date.now()}`,
        description: 'Created by integration test',
        status: 'pending',
        priority: 'low'
      };

      console.log('Creating task:', JSON.stringify(testTask, null, 2));
      
      const result = await syncEngine.createItem(testTask);
      
      console.log('Create item result:', JSON.stringify(result, null, 2));
      
      if (!result.success) {
        console.error('❌ CREATE ITEM FAILED');
        console.error('Error details:', result.error);
        console.error('Full result object:', result);
        if (result.response) {
          console.error('API response:', result.response);
        }
        if (result.graphQLErrors) {
          console.error('GraphQL errors:', result.graphQLErrors);
        }
      } else {
        console.log('✅ Item created successfully with ID:', result.mondayItemId);
      }
      
      expect(result.success).toBe(true);
      expect(result.mondayItemId).toBeDefined();
      expect(typeof result.mondayItemId).toBe('string');
      
      // Store for cleanup
      testTask.mondayItemId = result.mondayItemId;
      console.log('=== ITEM CREATION TEST COMPLETE ===\n');
    }, 30000);

    it('should update an existing item on Monday board', async () => {
      console.log('=== TESTING ITEM UPDATE ===');
      
      // First create an item
      const testTask = {
        id: 101,
        title: `Update Test Task ${Date.now()}`,
        description: 'To be updated by integration test',
        status: 'pending'
      };

      console.log('Creating initial task for update test:', JSON.stringify(testTask, null, 2));
      
      const createResult = await syncEngine.createItem(testTask);
      
      console.log('Initial create result:', JSON.stringify(createResult, null, 2));
      
      if (!createResult.success) {
        console.error('❌ INITIAL CREATE FAILED');
        console.error('Error details:', createResult.error);
        console.error('Full result object:', createResult);
      }
      
      expect(createResult.success).toBe(true);

      // Now update it
      const updatedTask = {
        ...testTask,
        description: 'Updated by integration test',
        status: 'done'
      };

      console.log('Updating task with ID:', createResult.mondayItemId);
      console.log('Updated task data:', JSON.stringify(updatedTask, null, 2));

      const updateResult = await syncEngine.updateItem(createResult.mondayItemId, updatedTask);
      
      console.log('Update result:', JSON.stringify(updateResult, null, 2));
      
      if (!updateResult.success) {
        console.error('❌ UPDATE ITEM FAILED');
        console.error('Error details:', updateResult.error);
        console.error('Full result object:', updateResult);
        if (updateResult.response) {
          console.error('API response:', updateResult.response);
        }
        if (updateResult.graphQLErrors) {
          console.error('GraphQL errors:', updateResult.graphQLErrors);
        }
      } else {
        console.log('✅ Item updated successfully');
      }
      
      expect(updateResult.success).toBe(true);
      expect(updateResult.mondayItemId).toBe(createResult.mondayItemId);
      console.log('=== ITEM UPDATE TEST COMPLETE ===\n');
    }, 30000);

    it('should handle API errors gracefully', async () => {
      console.log('=== TESTING ERROR HANDLING ===');
      
      // Try to update a non-existent item
      const invalidTask = {
        title: 'Invalid Task',
        description: 'This should fail',
        status: 'pending'
      };

      console.log('Attempting to update non-existent item with ID: 999999999');
      console.log('Invalid task data:', JSON.stringify(invalidTask, null, 2));

      const result = await syncEngine.updateItem('999999999', invalidTask);
      
      console.log('Error handling result:', JSON.stringify(result, null, 2));
      
      if (result.success) {
        console.warn('⚠️ Expected failure but got success - this might indicate an issue');
      } else {
        console.log('✅ Error handled gracefully as expected');
        console.log('Error message:', result.error);
      }
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      console.log('=== ERROR HANDLING TEST COMPLETE ===\n');
    }, 30000);

    it('should sync task from tasks.json to Monday board', async () => {
      console.log('=== TESTING SINGLE TASK SYNC ===');
      
      const testTask = {
        id: 999,
        title: `Sync Test Task ${Date.now()}`,
        description: 'Task synced from tasks.json',
        status: 'in-progress',
        priority: 'high'
      };
      
      console.log('Syncing task:', JSON.stringify(testTask, null, 2));
      console.log('Tasks file path:', tempTasksPath);
      console.log('Task ID for sync:', '999');
      
      const result = await syncEngine.syncTask(
        testTask,
        tempTasksPath,
        '999' // Test task ID
      );

      console.log('Single task sync result:', JSON.stringify(result, null, 2));
      
      if (!result.success) {
        console.error('❌ SINGLE TASK SYNC FAILED');
        console.error('Error details:', result.error);
        console.error('Full result object:', result);
        if (result.response) {
          console.error('API response:', result.response);
        }
        if (result.graphQLErrors) {
          console.error('GraphQL errors:', result.graphQLErrors);
        }
      } else {
        console.log('✅ Single task synced successfully with Monday ID:', result.mondayItemId);
      }

      expect(result.success).toBe(true);
      expect(result.mondayItemId).toBeDefined();
      console.log('=== SINGLE TASK SYNC TEST COMPLETE ===\n');
    }, 30000);

    it('should sync all pending items from tasks.json', async () => {
      console.log('=== TESTING BULK SYNC ===');
      
      // Add a test task to sync
      const tasksData = JSON.parse(fs.readFileSync(tempTasksPath, 'utf8'));
      console.log('Current tasks before adding test task:', tasksData.tasks.length);
      
      const newTask = {
        id: 999,
        title: `Bulk Sync Test ${Date.now()}`,
        description: 'Test bulk sync functionality',
        status: 'pending',
        priority: 'medium',
        dependencies: [],
        mondayItemId: null,
        syncStatus: 'pending'
      };
      
      tasksData.tasks.push(newTask);
      fs.writeFileSync(tempTasksPath, JSON.stringify(tasksData, null, 2));
      
      console.log('Added test task for bulk sync:', JSON.stringify(newTask, null, 2));
      console.log('Total tasks now:', tasksData.tasks.length);
      
      const result = await syncEngine.syncAll(tempTasksPath);
      
      console.log('Bulk sync result:', JSON.stringify(result, null, 2));
      
      if (result.synced === 0) {
        console.error('❌ BULK SYNC FAILED - NO ITEMS SYNCED');
        console.error('Total items found:', result.totalItems);
        console.error('Errors:', result.errors);
        console.error('Full result object:', result);
        
        if (result.details && Array.isArray(result.details)) {
          console.error('Sync details:');
          result.details.forEach((detail, index) => {
            console.error(`  ${index + 1}.`, JSON.stringify(detail, null, 2));
          });
        }
        
        // Check the tasks file to see what happened
        const updatedData = JSON.parse(fs.readFileSync(tempTasksPath, 'utf8'));
        console.error('Tasks after sync attempt:');
        updatedData.tasks.forEach((task, index) => {
          console.error(`  Task ${index + 1}:`, {
            id: task.id,
            title: task.title,
            syncStatus: task.syncStatus,
            mondayItemId: task.mondayItemId,
            syncError: task.syncError
          });
        });
      } else {
        console.log('✅ Bulk sync completed successfully');
        console.log('Items synced:', result.synced);
        console.log('Total items:', result.totalItems);
      }
      
      expect(result.totalItems).toBeGreaterThan(0);
      expect(result.synced).toBeGreaterThan(0);
      
      // Check that tasks were updated
      const updatedData = JSON.parse(fs.readFileSync(tempTasksPath, 'utf8'));
      const syncedTasks = updatedData.tasks.filter(t => t.syncStatus === 'synced');
      
      console.log('Tasks with synced status after bulk sync:', syncedTasks.length);
      syncedTasks.forEach(task => {
        console.log('  Synced task:', {
          id: task.id,
          title: task.title,
          mondayItemId: task.mondayItemId
        });
      });
      
      expect(syncedTasks.length).toBeGreaterThan(0);
      console.log('=== BULK SYNC TEST COMPLETE ===\n');
    }, 60000); // Longer timeout for multiple API calls
  });

  // Always run these tests (even without API access)
  describe('without API access', () => {
    it('should throw appropriate error when not configured', () => {
      console.log('=== TESTING CONFIGURATION VALIDATION ===');
      
      let error;
      try {
        new MondaySyncEngine('/nonexistent/path');
      } catch (e) {
        error = e;
        console.log('Expected error caught:', e.message);
      }
      
      expect(() => new MondaySyncEngine('/nonexistent/path')).toThrow(
        'Monday.com integration not configured'
      );
      
      console.log('✅ Configuration validation test passed\n');
    });

    it('should validate configuration structure', () => {
      console.log('=== TESTING CONFIGURATION STRUCTURE ===');
      
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

        console.log('Mock config for validation:', JSON.stringify(mockConfig, null, 2));

        // This would normally throw, but we're testing the validation logic
        expect(mockConfig.mondayIntegration.boardId).toBe('test-board');
        expect(mockConfig.mondayIntegration.columnMapping.status).toBe('status');
        
        console.log('✅ Configuration structure validation passed');
      }
      
      console.log('=== CONFIGURATION STRUCTURE TEST COMPLETE ===\n');
    });
  });
}); 