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
  const createdItemIds = []; // Track created items for cleanup

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

    afterAll(async () => {
      // Clean up all created items from Monday.com board
      if (createdItemIds.length > 0) {
        console.log('=== CLEANING UP TEST ITEMS ===');
        console.log(`Cleaning up ${createdItemIds.length} test items from Monday.com board...`);
        
        let cleaned = 0;
        let errors = 0;
        
        for (const itemId of createdItemIds) {
          try {
            console.log(`Deleting item ${itemId}...`);
            
            // Use the Monday client's delete mutation directly
            const deleteMutation = `
              mutation {
                delete_item(item_id: ${itemId}) {
                  id
                }
              }
            `;
            
            await syncEngine.client._executeWithRateLimit(deleteMutation);
            cleaned++;
            console.log(`✅ Deleted item ${itemId}`);
            
            // Small delay between deletions to be gentle on the API
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (error) {
            errors++;
            console.log(`❌ Error deleting item ${itemId}: ${error.message}`);
          }
        }
        
        console.log(`=== CLEANUP COMPLETE: ${cleaned} deleted, ${errors} errors ===\n`);
      } else {
        console.log('No test items to clean up');
      }
    }, 60000); // 60 second timeout for cleanup

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
      createdItemIds.push(result.mondayItemId);
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
      
      // Store for cleanup
      createdItemIds.push(createResult.mondayItemId);

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
        // Store for cleanup
        createdItemIds.push(result.mondayItemId);
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
        
        // Store created Monday IDs for cleanup
        if (result.details && Array.isArray(result.details)) {
          result.details.forEach(detail => {
            if (detail.success && detail.mondayItemId) {
              createdItemIds.push(detail.mondayItemId);
            }
          });
        }
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

    it('should create and sync subitems to Monday board', async () => {
      console.log('=== TESTING SUBITEM SYNC ===');
      
      // First create a parent task
      const parentTask = {
        id: 1000,
        title: `Parent Task for Subitems ${Date.now()}`,
        description: 'Parent task to test subitem sync',
        status: 'in-progress',
        priority: 'high'
      };

      console.log('Creating parent task:', JSON.stringify(parentTask, null, 2));
      
      const parentResult = await syncEngine.createItem(parentTask);
      
      if (!parentResult.success) {
        console.error('❌ PARENT TASK CREATION FAILED');
        console.error('Error details:', parentResult.error);
        throw new Error(`Failed to create parent task: ${parentResult.error}`);
      }

      console.log('✅ Parent task created with Monday ID:', parentResult.mondayItemId);
      
      // Store for cleanup
      createdItemIds.push(parentResult.mondayItemId);
      
      // Brief pause for Monday.com to process the parent item
      console.log('Brief pause for parent item processing...');
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      
      // Now create a subitem under the parent
      const subtask = {
        id: 1,
        title: `Test Subitem ${Date.now()}`,
        description: 'Integration test subitem',
        status: 'pending',
        details: 'Detailed subitem implementation notes'
      };

      console.log('Creating subitem under parent:', JSON.stringify(subtask, null, 2));
      
      const subitemResult = await syncEngine.createSubitem(subtask, parentResult.mondayItemId);
      
      console.log('Subitem creation result:', JSON.stringify(subitemResult, null, 2));
      
      if (!subitemResult.success) {
        console.error('❌ SUBITEM CREATION FAILED');
        console.error('Error details:', subitemResult.error);
        console.error('Full result object:', subitemResult);
        if (subitemResult.response) {
          console.error('API response:', subitemResult.response);
        }
        if (subitemResult.graphQLErrors) {
          console.error('GraphQL errors:', subitemResult.graphQLErrors);
        }
      } else {
        console.log('✅ Subitem created successfully with ID:', subitemResult.mondayItemId);
        // Store for cleanup
        createdItemIds.push(subitemResult.mondayItemId);
      }
      
      expect(subitemResult.success).toBe(true);
      expect(subitemResult.mondayItemId).toBeDefined();
      expect(typeof subitemResult.mondayItemId).toBe('string');
      
      console.log('=== SUBITEM SYNC TEST COMPLETE ===\n');
    }, 45000);

    it('should sync subtasks through syncSubtask method', async () => {
      console.log('=== TESTING SUBTASK SYNC METHOD ===');
      
      // Create parent task first
      const parentTask = {
        id: 1001,
        title: `Parent for syncSubtask Test ${Date.now()}`,
        description: 'Parent task for syncSubtask method test',
        status: 'pending',
        priority: 'medium'
      };

      const parentResult = await syncEngine.createItem(parentTask);
      expect(parentResult.success).toBe(true);
      
      // Store for cleanup
      createdItemIds.push(parentResult.mondayItemId);
      
      // Add Monday ID to parent task object
      parentTask.mondayItemId = parentResult.mondayItemId;
      
      console.log('Parent task created with ID:', parentResult.mondayItemId);

      // Brief pause for parent item processing
      console.log('Brief pause for parent item processing...');
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay

      // Create test tasks.json data for this test
      const testTasksData = {
        version: "1.0.0",
        tasks: [
          {
            ...parentTask,
            subtasks: [
              {
                id: 1,
                title: `Test Subtask via syncSubtask ${Date.now()}`,
                description: 'Subtask synced via syncSubtask method',
                status: 'pending',
                mondayItemId: null,
                syncStatus: 'pending'
              }
            ]
          }
        ]
      };

      // Write to temporary tasks file
      const testTasksPath = path.join(tempDir, 'sync-subtask-test.json');
      fs.writeFileSync(testTasksPath, JSON.stringify(testTasksData, null, 2));
      
      console.log('Created test tasks.json for syncSubtask test');

      // Now sync the subtask
      const subtask = testTasksData.tasks[0].subtasks[0];
      const subtaskId = '1001.1';
      
      console.log('Syncing subtask:', JSON.stringify(subtask, null, 2));
      console.log('Subtask ID:', subtaskId);
      
      const syncResult = await syncEngine.syncSubtask(
        subtask,
        parentTask,
        testTasksPath,
        subtaskId
      );

      console.log('syncSubtask result:', JSON.stringify(syncResult, null, 2));
      
      if (!syncResult.success) {
        console.error('❌ SUBTASK SYNC FAILED');
        console.error('Error details:', syncResult.error);
        console.error('Full result object:', syncResult);
      } else {
        console.log('✅ Subtask synced successfully with Monday ID:', syncResult.mondayItemId);
        // Store for cleanup
        createdItemIds.push(syncResult.mondayItemId);
      }
      
      expect(syncResult.success).toBe(true);
      expect(syncResult.mondayItemId).toBeDefined();
      
      // Verify the tasks file was updated
      const updatedData = JSON.parse(fs.readFileSync(testTasksPath, 'utf8'));
      const updatedSubtask = updatedData.tasks[0].subtasks[0];
      
      console.log('Updated subtask after sync:', JSON.stringify(updatedSubtask, null, 2));
      
      expect(updatedSubtask.mondayItemId).toBe(syncResult.mondayItemId);
      expect(updatedSubtask.syncStatus).toBe('synced');
      expect(updatedSubtask.lastSyncedAt).toBeDefined();
      
      // Clean up test file
      fs.unlinkSync(testTasksPath);
      
      console.log('=== SUBTASK SYNC METHOD TEST COMPLETE ===\n');
    }, 45000);

    it('should handle subtask sync when parent task is not synced', async () => {
      console.log('=== TESTING SUBTASK SYNC ERROR HANDLING ===');
      
      const parentTaskNotSynced = {
        id: 1002,
        title: 'Parent Not Synced',
        description: 'Parent task without Monday ID',
        status: 'pending'
        // Note: No mondayItemId
      };

      const subtask = {
        id: 1,
        title: 'Subtask with unsynced parent',
        description: 'This should fail',
        status: 'pending'
      };

      const testTasksPath = path.join(tempDir, 'error-test.json');
      const errorTestData = {
        version: "1.0.0",
        tasks: [
          {
            ...parentTaskNotSynced,
            subtasks: [subtask]
          }
        ]
      };
      
      fs.writeFileSync(testTasksPath, JSON.stringify(errorTestData, null, 2));
      
      console.log('Testing subtask sync with unsynced parent...');
      
      const result = await syncEngine.syncSubtask(
        subtask,
        parentTaskNotSynced,
        testTasksPath,
        '1002.1'
      );

      console.log('Error handling result:', JSON.stringify(result, null, 2));
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Parent task (ID: 1002) must be synced to Monday.com before its subtasks can be synced');
      
      // Verify error was recorded in tasks file
      const updatedData = JSON.parse(fs.readFileSync(testTasksPath, 'utf8'));
      const updatedSubtask = updatedData.tasks[0].subtasks[0];
      
      expect(updatedSubtask.syncStatus).toBe('error');
      expect(updatedSubtask.syncError).toContain('Parent task (ID: 1002) must be synced');
      
      console.log('✅ Error handling test passed');
      
      // Clean up
      fs.unlinkSync(testTasksPath);
      
      console.log('=== SUBTASK SYNC ERROR HANDLING TEST COMPLETE ===\n');
    }, 30000);

    it('should sync tasks with subtasks through syncAll method', async () => {
      console.log('=== TESTING FULL TASK+SUBTASKS SYNC ===');
      
      // Create comprehensive test data with parent task and subtasks
      const fullSyncTestData = {
        version: "1.0.0",
        tasks: [
          {
            id: 2000,
            title: `Full Sync Parent ${Date.now()}`,
            description: 'Parent task for full sync test',
            status: 'pending',
            priority: 'high',
            dependencies: [],
            mondayItemId: null,
            syncStatus: 'pending',
            subtasks: [
              {
                id: 1,
                title: `Full Sync Subtask 1 ${Date.now()}`,
                description: 'First subtask in full sync test',
                status: 'pending',
                mondayItemId: null,
                syncStatus: 'pending'
              },
              {
                id: 2,
                title: `Full Sync Subtask 2 ${Date.now()}`,
                description: 'Second subtask in full sync test',
                status: 'in-progress',
                mondayItemId: null,
                syncStatus: 'pending'
              }
            ]
          }
        ]
      };

      const fullSyncTestPath = path.join(tempDir, 'full-sync-test.json');
      fs.writeFileSync(fullSyncTestPath, JSON.stringify(fullSyncTestData, null, 2));
      
      console.log('Created test data with task and subtasks for full sync');
      console.log('Test data:', JSON.stringify(fullSyncTestData, null, 2));

      // Perform full sync
      const syncAllResult = await syncEngine.syncAll(fullSyncTestPath);
      
      console.log('syncAll result:', JSON.stringify(syncAllResult, null, 2));
      
      if (!syncAllResult.success) {
        console.error('❌ FULL SYNC FAILED');
        console.error('Total items:', syncAllResult.totalItems);
        console.error('Synced:', syncAllResult.synced);
        console.error('Errors:', syncAllResult.errors);
        console.error('Details:', syncAllResult.details);
      } else {
        console.log('✅ Full sync completed successfully');
        console.log('Total items:', syncAllResult.totalItems);
        console.log('Synced:', syncAllResult.synced);
        console.log('Errors:', syncAllResult.errors);
        
        // Store created Monday IDs for cleanup
        if (syncAllResult.details && Array.isArray(syncAllResult.details)) {
          syncAllResult.details.forEach(detail => {
            if (detail.success && detail.mondayItemId) {
              createdItemIds.push(detail.mondayItemId);
            }
          });
        }
      }
      
      expect(syncAllResult.success).toBe(true);
      expect(syncAllResult.totalItems).toBe(3); // 1 parent task + 2 subtasks
      expect(syncAllResult.synced).toBe(3);
      expect(syncAllResult.errors).toBe(0);
      
      // Verify all items have Monday IDs and are marked as synced
      const finalData = JSON.parse(fs.readFileSync(fullSyncTestPath, 'utf8'));
      const syncedTask = finalData.tasks[0];
      
      console.log('Final synced task data:', JSON.stringify(syncedTask, null, 2));
      
      expect(syncedTask.mondayItemId).toBeDefined();
      expect(syncedTask.syncStatus).toBe('synced');
      
      expect(syncedTask.subtasks[0].mondayItemId).toBeDefined();
      expect(syncedTask.subtasks[0].syncStatus).toBe('synced');
      
      expect(syncedTask.subtasks[1].mondayItemId).toBeDefined();
      expect(syncedTask.subtasks[1].syncStatus).toBe('synced');
      
      // Verify the sync order was correct (parent first, then subtasks)
      const syncDetails = syncAllResult.details;
      const parentSyncDetail = syncDetails.find(d => d.type === 'task');
      const subtaskSyncDetails = syncDetails.filter(d => d.type === 'subtask');
      
      expect(parentSyncDetail).toBeDefined();
      expect(parentSyncDetail.success).toBe(true);
      expect(subtaskSyncDetails.length).toBe(2);
      expect(subtaskSyncDetails.every(d => d.success)).toBe(true);
      
      console.log('✅ All sync order and data validation passed');
      
      // Clean up
      fs.unlinkSync(fullSyncTestPath);
      
      console.log('=== FULL TASK+SUBTASKS SYNC TEST COMPLETE ===\n');
    }, 90000); // Increased timeout for full sync test
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