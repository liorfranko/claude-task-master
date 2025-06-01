import { jest } from '@jest/globals';
import { 
  extendTaskWithMondayFields,
  markTaskForSync,
  updateTaskSyncStatus,
  markSubtaskForSync,
  updateSubtaskSyncStatus,
  getTasksNeedingSync,
  initializeMondayFieldsForAllTasks
} from '../../scripts/modules/task-manager/monday-sync-utils.js';

describe('Monday Sync Utils', () => {
  let mondaySyncUtils;
  let mockReadJSON;
  let mockWriteJSON;
  
  beforeEach(async () => {
    // Reset modules before each test
    jest.resetModules();
    
    // Mock the utils module
    jest.unstable_mockModule('../../scripts/modules/utils.js', () => ({
      readJSON: jest.fn(),
      writeJSON: jest.fn()
    }));
    
    // Import the mocked module
    const utilsModule = await import('../../scripts/modules/utils.js');
    mockReadJSON = utilsModule.readJSON;
    mockWriteJSON = utilsModule.writeJSON;
    
    // Import the module under test
    mondaySyncUtils = await import('../../scripts/modules/task-manager/monday-sync-utils.js');
  });

  describe('extendTaskWithMondayFields', () => {
    test('should add default Monday fields to a task', () => {
      const task = {
        id: 1,
        title: 'Test Task',
        status: 'pending'
      };

      const result = mondaySyncUtils.extendTaskWithMondayFields(task);

      expect(result).toEqual({
        id: 1,
        title: 'Test Task',
        status: 'pending',
        mondayItemId: null,
        lastSyncedAt: null,
        syncStatus: 'pending',
        syncError: null
      });
    });

    test('should preserve existing Monday fields', () => {
      const task = {
        id: 1,
        title: 'Test Task',
        mondayItemId: '12345',
        syncStatus: 'synced'
      };

      const result = mondaySyncUtils.extendTaskWithMondayFields(task);

      expect(result.mondayItemId).toBe('12345');
      expect(result.syncStatus).toBe('synced');
    });

    test('should override fields with provided options', () => {
      const task = {
        id: 1,
        title: 'Test Task'
      };

      const result = mondaySyncUtils.extendTaskWithMondayFields(task, {
        mondayItemId: '67890',
        syncStatus: 'error',
        syncError: 'API Error'
      });

      expect(result.mondayItemId).toBe('67890');
      expect(result.syncStatus).toBe('error');
      expect(result.syncError).toBe('API Error');
    });
  });

  describe('markTaskForSync', () => {
    test('should mark a task for sync successfully', () => {
      const mockData = {
        tasks: [
          { id: 1, title: 'Task 1', status: 'pending' },
          { id: 2, title: 'Task 2', status: 'done' }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);
      mockWriteJSON.mockImplementation(() => {});

      const result = mondaySyncUtils.markTaskForSync('/path/tasks.json', 1);

      expect(result).toBe(true);
      expect(mockData.tasks[0].syncStatus).toBe('pending');
      expect(mockData.tasks[0].syncError).toBe(null);
      expect(mockWriteJSON).toHaveBeenCalledWith('/path/tasks.json', mockData);
    });

    test('should return false if task not found', () => {
      const mockData = {
        tasks: [
          { id: 1, title: 'Task 1', status: 'pending' }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);

      const result = mondaySyncUtils.markTaskForSync('/path/tasks.json', 999);

      expect(result).toBe(false);
      expect(mockWriteJSON).not.toHaveBeenCalled();
    });

    test('should return false if no tasks data', () => {
      mockReadJSON.mockReturnValue(null);

      const result = mondaySyncUtils.markTaskForSync('/path/tasks.json', 1);

      expect(result).toBe(false);
    });

    test('should handle read errors gracefully', () => {
      mockReadJSON.mockImplementation(() => {
        throw new Error('Read error');
      });
      
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = mondaySyncUtils.markTaskForSync('/path/tasks.json', 1);

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith('Error marking task for sync:', expect.any(Error));
      
      consoleSpy.mockRestore();
    });
  });

  describe('updateTaskSyncStatus', () => {
    test('should update task sync status successfully', () => {
      const mockData = {
        tasks: [
          { id: 1, title: 'Task 1', status: 'pending' }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);
      mockWriteJSON.mockImplementation(() => {});

      const result = mondaySyncUtils.updateTaskSyncStatus('/path/tasks.json', 1, 'monday123', 'synced');

      expect(result).toBe(true);
      expect(mockData.tasks[0].mondayItemId).toBe('monday123');
      expect(mockData.tasks[0].syncStatus).toBe('synced');
      expect(mockData.tasks[0].lastSyncedAt).toBeDefined();
      expect(mockData.tasks[0].syncError).toBe(null);
      expect(mockWriteJSON).toHaveBeenCalledWith('/path/tasks.json', mockData);
    });

    test('should update task sync status with error', () => {
      const mockData = {
        tasks: [
          { id: 1, title: 'Task 1', status: 'pending' }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);
      mockWriteJSON.mockImplementation(() => {});

      const result = mondaySyncUtils.updateTaskSyncStatus('/path/tasks.json', 1, null, 'error', 'Sync failed');

      expect(result).toBe(true);
      expect(mockData.tasks[0].syncStatus).toBe('error');
      expect(mockData.tasks[0].syncError).toBe('Sync failed');
    });
  });

  describe('markSubtaskForSync', () => {
    test('should mark a subtask for sync successfully', () => {
      const mockData = {
        tasks: [
          {
            id: 1,
            title: 'Task 1',
            subtasks: [
              { id: 1, title: 'Subtask 1', status: 'pending' },
              { id: 2, title: 'Subtask 2', status: 'done' }
            ]
          }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);
      mockWriteJSON.mockImplementation(() => {});

      const result = mondaySyncUtils.markSubtaskForSync('/path/tasks.json', '1.1');

      expect(result).toBe(true);
      expect(mockData.tasks[0].subtasks[0].syncStatus).toBe('pending');
      expect(mockData.tasks[0].subtasks[0].syncError).toBe(null);
      expect(mockWriteJSON).toHaveBeenCalledWith('/path/tasks.json', mockData);
    });

    test('should return false if parent task not found', () => {
      const mockData = {
        tasks: [
          { id: 1, title: 'Task 1', subtasks: [] }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);

      const result = mondaySyncUtils.markSubtaskForSync('/path/tasks.json', '999.1');

      expect(result).toBe(false);
    });

    test('should return false if subtask not found', () => {
      const mockData = {
        tasks: [
          {
            id: 1,
            title: 'Task 1',
            subtasks: [
              { id: 1, title: 'Subtask 1', status: 'pending' }
            ]
          }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);

      const result = mondaySyncUtils.markSubtaskForSync('/path/tasks.json', '1.999');

      expect(result).toBe(false);
    });
  });

  describe('updateSubtaskSyncStatus', () => {
    test('should update subtask sync status successfully', () => {
      const mockData = {
        tasks: [
          {
            id: 1,
            title: 'Task 1',
            subtasks: [
              { id: 1, title: 'Subtask 1', status: 'pending' }
            ]
          }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);
      mockWriteJSON.mockImplementation(() => {});

      const result = mondaySyncUtils.updateSubtaskSyncStatus('/path/tasks.json', '1.1', 'monday456', 'synced');

      expect(result).toBe(true);
      expect(mockData.tasks[0].subtasks[0].mondayItemId).toBe('monday456');
      expect(mockData.tasks[0].subtasks[0].syncStatus).toBe('synced');
      expect(mockData.tasks[0].subtasks[0].lastSyncedAt).toBeDefined();
      expect(mockWriteJSON).toHaveBeenCalledWith('/path/tasks.json', mockData);
    });
  });

  describe('getTasksNeedingSync', () => {
    test('should return tasks that need syncing', () => {
      const mockData = {
        tasks: [
          {
            id: 1,
            title: 'Task 1',
            syncStatus: 'pending',
            subtasks: [
              { id: 1, title: 'Subtask 1', syncStatus: 'synced' },
              { id: 2, title: 'Subtask 2', syncStatus: 'error' }
            ]
          },
          {
            id: 2,
            title: 'Task 2',
            syncStatus: 'synced',
            subtasks: []
          },
          {
            id: 3,
            title: 'Task 3',
            syncStatus: 'error'
          }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);

      const result = mondaySyncUtils.getTasksNeedingSync('/path/tasks.json');

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        type: 'task',
        id: 1,
        task: mockData.tasks[0]
      });
      expect(result[1]).toEqual({
        type: 'subtask',
        id: '1.2',
        task: mockData.tasks[0].subtasks[1],
        parentTask: mockData.tasks[0]
      });
      expect(result[2]).toEqual({
        type: 'task',
        id: 3,
        task: mockData.tasks[2]
      });
    });

    test('should return empty array if no tasks need syncing', () => {
      const mockData = {
        tasks: [
          {
            id: 1,
            title: 'Task 1',
            syncStatus: 'synced',
            subtasks: [
              { id: 1, title: 'Subtask 1', syncStatus: 'synced' }
            ]
          }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);

      const result = mondaySyncUtils.getTasksNeedingSync('/path/tasks.json');

      expect(result).toEqual([]);
    });

    test('should handle missing sync status gracefully', () => {
      const mockData = {
        tasks: [
          {
            id: 1,
            title: 'Task 1',
            // No syncStatus field
            subtasks: [
              { id: 1, title: 'Subtask 1' } // No syncStatus field
            ]
          }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);

      const result = mondaySyncUtils.getTasksNeedingSync('/path/tasks.json');

      expect(result).toEqual([]);
    });
  });

  describe('initializeMondayFieldsForAllTasks', () => {
    test('should initialize Monday fields for tasks without them', () => {
      const mockData = {
        tasks: [
          {
            id: 1,
            title: 'Task 1',
            subtasks: [
              { id: 1, title: 'Subtask 1' },
              { id: 2, title: 'Subtask 2', mondayItemId: 'existing' }
            ]
          },
          {
            id: 2,
            title: 'Task 2',
            mondayItemId: 'existing'
          }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);
      mockWriteJSON.mockImplementation(() => {});

      const result = mondaySyncUtils.initializeMondayFieldsForAllTasks('/path/tasks.json');

      expect(result.success).toBe(true);
      expect(result.updatedCount).toBe(2); // Task 1 and Subtask 1
      expect(mockData.tasks[0].mondayItemId).toBe(null);
      expect(mockData.tasks[0].syncStatus).toBe('pending');
      expect(mockData.tasks[0].subtasks[0].mondayItemId).toBe(null);
      expect(mockData.tasks[0].subtasks[1].mondayItemId).toBe('existing'); // Unchanged
      expect(mockData.tasks[1].mondayItemId).toBe('existing'); // Unchanged
      expect(mockWriteJSON).toHaveBeenCalledWith('/path/tasks.json', mockData);
    });

    test('should return success with zero count if all tasks already have fields', () => {
      const mockData = {
        tasks: [
          {
            id: 1,
            title: 'Task 1',
            mondayItemId: 'existing',
            subtasks: [
              { id: 1, title: 'Subtask 1', mondayItemId: 'existing' }
            ]
          }
        ]
      };

      mockReadJSON.mockReturnValue(mockData);

      const result = mondaySyncUtils.initializeMondayFieldsForAllTasks('/path/tasks.json');

      expect(result.success).toBe(true);
      expect(result.updatedCount).toBe(0);
      expect(mockWriteJSON).not.toHaveBeenCalled();
    });

    test('should handle missing tasks gracefully', () => {
      mockReadJSON.mockReturnValue(null);

      const result = mondaySyncUtils.initializeMondayFieldsForAllTasks('/path/tasks.json');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No tasks found');
    });

    test('should handle read errors gracefully', () => {
      mockReadJSON.mockImplementation(() => {
        throw new Error('File error');
      });
      
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = mondaySyncUtils.initializeMondayFieldsForAllTasks('/path/tasks.json');

      expect(result.success).toBe(false);
      expect(result.error).toBe('File error');
      
      consoleSpy.mockRestore();
    });
  });
}); 