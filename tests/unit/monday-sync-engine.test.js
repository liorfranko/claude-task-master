import { jest, describe, beforeEach, it, expect } from '@jest/globals';

// Create mock functions first
const mockGetMondayIntegrationConfig = jest.fn();
const mockGetMondayApiToken = jest.fn();
const mockMondayClient = jest.fn();
const mockUpdateTaskSyncStatus = jest.fn();
const mockUpdateSubtaskSyncStatus = jest.fn();
const mockMarkTaskForSync = jest.fn();
const mockMarkSubtaskForSync = jest.fn();
const mockGetTasksNeedingSync = jest.fn();

const mockConfig = {
  boardId: '9275265350',
  columnMapping: {
    status: 'status_column',
    description: 'notes_column',
    details: 'details_column',
    priority: 'priority_column',
    taskId: 'task_id_column'
  }
};

const mockClientInstance = {
  _executeWithRateLimit: jest.fn(),
  testConnection: jest.fn(),
  testBoardAccess: jest.fn()
};

// Set up default mock implementations
mockGetMondayIntegrationConfig.mockReturnValue(mockConfig);
mockGetMondayApiToken.mockReturnValue('mock_token');
mockMondayClient.mockReturnValue(mockClientInstance);

// Mock all dependencies before importing the module under test
jest.unstable_mockModule('../../scripts/modules/config-manager.js', () => ({
  getMondayIntegrationConfig: mockGetMondayIntegrationConfig,
  getMondayApiToken: mockGetMondayApiToken
}));

jest.unstable_mockModule('../../scripts/modules/monday-client.js', () => ({
  MondayClient: mockMondayClient
}));

jest.unstable_mockModule('../../scripts/modules/task-manager/monday-sync-utils.js', () => ({
  updateTaskSyncStatus: mockUpdateTaskSyncStatus,
  updateSubtaskSyncStatus: mockUpdateSubtaskSyncStatus,
  markTaskForSync: mockMarkTaskForSync,
  markSubtaskForSync: mockMarkSubtaskForSync,
  getTasksNeedingSync: mockGetTasksNeedingSync
}));

// Import the module under test after mocking
const { MondaySyncEngine, createMondaySyncEngine } = await import('../../scripts/modules/monday-sync.js');

describe('MondaySyncEngine', () => {
  let syncEngine;
  const projectRoot = '/test/project';

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset mock implementations
    mockGetMondayIntegrationConfig.mockReturnValue(mockConfig);
    mockGetMondayApiToken.mockReturnValue('mock_token');
    mockMondayClient.mockReturnValue(mockClientInstance);
    
    syncEngine = new MondaySyncEngine(projectRoot);
  });

  describe('constructor', () => {
    it('should initialize with valid configuration', () => {
      expect(syncEngine.projectRoot).toBe(projectRoot);
      expect(syncEngine.boardId).toBe('9275265350');
      expect(syncEngine.columnMapping).toEqual(mockConfig.columnMapping);
      expect(mockGetMondayIntegrationConfig).toHaveBeenCalledWith(projectRoot, null);
      expect(mockGetMondayApiToken).toHaveBeenCalledWith(projectRoot, null);
    });

    it('should throw error when configuration is missing', () => {
      mockGetMondayIntegrationConfig.mockReturnValueOnce(null);
      
      expect(() => new MondaySyncEngine(projectRoot)).toThrow(
        'Monday.com integration not configured. Please run "task-master config-monday" first.'
      );
    });

    it('should throw error when boardId is missing', () => {
      mockGetMondayIntegrationConfig.mockReturnValueOnce({});
      
      expect(() => new MondaySyncEngine(projectRoot)).toThrow(
        'Monday.com integration not configured. Please run "task-master config-monday" first.'
      );
    });

    it('should throw error when API token is missing', () => {
      mockGetMondayApiToken.mockReturnValueOnce(null);
      
      expect(() => new MondaySyncEngine(projectRoot)).toThrow(
        'Monday API token not found in config or environment variables'
      );
    });
  });

  describe('mapStatus', () => {
    it('should map Task Master statuses to Monday statuses correctly', () => {
      const mappings = [
        { input: 'pending', expected: 'Pending' },
        { input: 'in-progress', expected: 'In Progress' },
        { input: 'in_progress', expected: 'In Progress' },
        { input: 'review', expected: 'In Progress' },
        { input: 'done', expected: 'Done' },
        { input: 'cancelled', expected: 'Done' },
        { input: 'deferred', expected: 'Deferred' },
        { input: 'unknown', expected: 'Pending' }
      ];

      mappings.forEach(({ input, expected }) => {
        expect(syncEngine.mapStatus(input)).toBe(expected);
      });
    });
  });

  describe('escapeForGraphQL', () => {
    it('should escape special characters for GraphQL', () => {
      const testCases = [
        { input: 'Normal text', expected: 'Normal text' },
        { input: 'Text with "quotes"', expected: 'Text with \\"quotes\\"' },
        { input: 'Text with\nnewlines', expected: 'Text with\\nnewlines' },
        { input: 'Text\\with\\backslashes', expected: 'Text\\\\with\\\\backslashes' },
        { input: 'Text\twith\ttabs', expected: 'Text\\twith\\ttabs' },
        { input: '', expected: '' },
        { input: null, expected: '' },
        { input: undefined, expected: '' }
      ];

      testCases.forEach(({ input, expected }) => {
        expect(syncEngine.escapeForGraphQL(input)).toBe(expected);
      });
    });
  });

  describe('createItem', () => {
    const mockTask = {
      title: 'Test Task',
      description: 'Test description',
      status: 'pending',
      priority: 'high'
    };

    it('should create new Monday item successfully', async () => {
      mockClientInstance._executeWithRateLimit
        .mockResolvedValueOnce({ create_item: { id: '12345' } })
        .mockResolvedValue({}); // For updateItemFields calls

      const result = await syncEngine.createItem(mockTask);

      expect(result.success).toBe(true);
      expect(result.mondayItemId).toBe('12345');
      expect(mockClientInstance._executeWithRateLimit).toHaveBeenCalledWith(
        expect.stringContaining('create_item')
      );
    });

    it('should handle creation errors', async () => {
      const error = new Error('API Error');
      mockClientInstance._executeWithRateLimit.mockRejectedValueOnce(error);

      const result = await syncEngine.createItem(mockTask);

      expect(result.success).toBe(false);
      expect(result.error).toBe('API Error');
    });

    it('should escape special characters in task title', async () => {
      const taskWithSpecialChars = {
        ...mockTask,
        title: 'Task with "quotes" and\nnewlines'
      };

      mockClientInstance._executeWithRateLimit
        .mockResolvedValueOnce({ create_item: { id: '12345' } })
        .mockResolvedValue({});

      await syncEngine.createItem(taskWithSpecialChars);

      const createCall = mockClientInstance._executeWithRateLimit.mock.calls[0][0];
      expect(createCall).toContain('Task with \\"quotes\\" and\\nnewlines');
    });
  });

  describe('updateItem', () => {
    const mockTask = {
      title: 'Updated Task',
      description: 'Updated description',
      status: 'done'
    };

    it('should update existing Monday item successfully', async () => {
      mockClientInstance._executeWithRateLimit.mockResolvedValue({});

      const result = await syncEngine.updateItem('12345', mockTask);

      expect(result.success).toBe(true);
      expect(result.mondayItemId).toBe('12345');
    });

    it('should handle update errors', async () => {
      const error = new Error('Update failed');
      mockClientInstance._executeWithRateLimit.mockRejectedValueOnce(error);

      const result = await syncEngine.updateItem('12345', mockTask);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Update failed');
    });
  });

  describe('updateItemFields', () => {
    const mockTask = {
      id: 15,
      title: 'Test Task',
      description: 'Test description',
      details: 'Test details',
      status: 'in-progress',
      priority: 'medium'
    };

    it('should update all mapped fields', async () => {
      mockClientInstance._executeWithRateLimit.mockResolvedValue({});

      await syncEngine.updateItemFields('12345', mockTask);

      // Should make calls for status, description, details, priority, and taskId
      expect(mockClientInstance._executeWithRateLimit).toHaveBeenCalledTimes(5);
    });

    it('should skip unmapped fields', async () => {
      syncEngine.columnMapping = { status: 'status_column' }; // Only status mapped
      mockClientInstance._executeWithRateLimit.mockResolvedValue({});

      await syncEngine.updateItemFields('12345', mockTask);

      // Should only make one call for status
      expect(mockClientInstance._executeWithRateLimit).toHaveBeenCalledTimes(1);
    });

    it('should skip details if same as description', async () => {
      const taskWithSameDetails = {
        ...mockTask,
        details: mockTask.description
      };
      mockClientInstance._executeWithRateLimit.mockResolvedValue({});

      await syncEngine.updateItemFields('12345', taskWithSameDetails);

      // Should make calls for status, description, priority, and taskId (not details)
      expect(mockClientInstance._executeWithRateLimit).toHaveBeenCalledTimes(4);
    });
  });

  describe('syncTask', () => {
    const mockTask = {
      title: 'Test Task',
      description: 'Test description',
      status: 'pending'
    };
    const tasksPath = '/test/tasks.json';
    const taskId = '1';

    it('should create new task when no mondayItemId exists', async () => {
      mockClientInstance._executeWithRateLimit
        .mockResolvedValueOnce({ create_item: { id: '12345' } })
        .mockResolvedValue({});

      const result = await syncEngine.syncTask(mockTask, tasksPath, taskId);

      expect(result.success).toBe(true);
      expect(result.mondayItemId).toBe('12345');
      expect(mockUpdateTaskSyncStatus).toHaveBeenCalledWith(
        tasksPath, taskId, '12345', 'synced'
      );
    });

    it('should update existing task when mondayItemId exists', async () => {
      const existingTask = { ...mockTask, mondayItemId: '12345' };
      mockClientInstance._executeWithRateLimit.mockResolvedValue({});

      const result = await syncEngine.syncTask(existingTask, tasksPath, taskId);

      expect(result.success).toBe(true);
      expect(result.mondayItemId).toBe('12345');
      expect(mockUpdateTaskSyncStatus).toHaveBeenCalledWith(
        tasksPath, taskId, '12345', 'synced'
      );
    });

    it('should handle sync errors and update status', async () => {
      const error = new Error('Sync failed');
      mockClientInstance._executeWithRateLimit.mockRejectedValueOnce(error);

      const result = await syncEngine.syncTask(mockTask, tasksPath, taskId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync failed');
      expect(mockUpdateTaskSyncStatus).toHaveBeenCalledWith(
        tasksPath, taskId, null, 'error', 'Sync failed'
      );
    });
  });

  describe('syncSubtask', () => {
    const mockSubtask = {
      title: 'Test Subtask',
      description: 'Test subtask description',
      status: 'pending'
    };
    const mockParentTask = {
      id: '1',
      title: 'Parent Task',
      description: 'Parent description',
      mondayItemId: '11111'
    };
    const tasksPath = '/test/tasks.json';
    const subtaskId = '1.1';

    it('should create new subtask with formatted title', async () => {
      mockClientInstance._executeWithRateLimit
        .mockResolvedValueOnce({ create_subitem: { id: '12345' } })
        .mockResolvedValue({});

      const result = await syncEngine.syncSubtask(mockSubtask, mockParentTask, tasksPath, subtaskId);

      expect(result.success).toBe(true);
      expect(result.mondayItemId).toBe('12345');
      
      const createCall = mockClientInstance._executeWithRateLimit.mock.calls[0][0];
      expect(createCall).toContain('create_subitem');
      expect(createCall).toContain('Test Subtask');
      
      expect(mockUpdateSubtaskSyncStatus).toHaveBeenCalledWith(
        tasksPath, subtaskId, '12345', 'synced'
      );
    });

    it('should update existing subtask when mondayItemId exists', async () => {
      const existingSubtask = { ...mockSubtask, mondayItemId: '12345' };
      mockClientInstance._executeWithRateLimit.mockResolvedValue({});

      const result = await syncEngine.syncSubtask(existingSubtask, mockParentTask, tasksPath, subtaskId);

      expect(result.success).toBe(true);
      expect(result.mondayItemId).toBe('12345');
      expect(mockUpdateSubtaskSyncStatus).toHaveBeenCalledWith(
        tasksPath, subtaskId, '12345', 'synced'
      );
    });

    it('should handle sync errors for subtasks', async () => {
      const parentTaskWithoutMondayId = {
        id: '1',
        title: 'Parent Task',
        description: 'Parent description'
      };
      
      const result = await syncEngine.syncSubtask(mockSubtask, parentTaskWithoutMondayId, tasksPath, subtaskId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Parent task (ID: 1) must be synced to Monday.com before its subtasks can be synced');
      expect(mockUpdateSubtaskSyncStatus).toHaveBeenCalledWith(
        tasksPath, subtaskId, null, 'error', 'Parent task (ID: 1) must be synced to Monday.com before its subtasks can be synced'
      );
    });
  });

  describe('syncAll', () => {
    const tasksPath = '/test/tasks.json';

    it('should sync all pending items successfully', async () => {
      const mockItemsToSync = [
        {
          type: 'task',
          id: '1',
          task: { title: 'Task 1', status: 'pending' }
        },
        {
          type: 'subtask',
          id: '2.1',
          task: { title: 'Subtask 1', status: 'pending' },
          parentTask: { title: 'Parent Task' }
        }
      ];

      mockGetTasksNeedingSync.mockReturnValue(mockItemsToSync);
      
      // Mock the syncTask and syncSubtask methods instead of the lower-level calls
      const mockSyncTask = jest.spyOn(syncEngine, 'syncTask').mockResolvedValue({
        success: true,
        mondayItemId: '12345'
      });
      const mockSyncSubtask = jest.spyOn(syncEngine, 'syncSubtask').mockResolvedValue({
        success: true,
        mondayItemId: '67890'
      });

      const result = await syncEngine.syncAll(tasksPath);

      expect(result.success).toBe(true);
      expect(result.totalItems).toBe(2);
      expect(result.synced).toBe(2);
      expect(result.errors).toBe(0);
      expect(result.details).toHaveLength(2);
      
      expect(mockSyncTask).toHaveBeenCalledWith(mockItemsToSync[0].task, tasksPath, '1');
      expect(mockSyncSubtask).toHaveBeenCalledWith(
        mockItemsToSync[1].task, 
        mockItemsToSync[1].parentTask,
        tasksPath, 
        '2.1'
      );

      mockSyncTask.mockRestore();
      mockSyncSubtask.mockRestore();
    });

    it('should handle mixed success and error results', async () => {
      const mockItemsToSync = [
        {
          type: 'task',
          id: '1',
          task: { title: 'Task 1', status: 'pending' }
        },
        {
          type: 'task',
          id: '2',
          task: { title: 'Task 2', status: 'pending' }
        }
      ];

      mockGetTasksNeedingSync.mockReturnValue(mockItemsToSync);
      
      // Mock syncTask to succeed for first task and fail for second
      const mockSyncTask = jest.spyOn(syncEngine, 'syncTask')
        .mockResolvedValueOnce({
          success: true,
          mondayItemId: '12345'
        })
        .mockResolvedValueOnce({
          success: false,
          error: 'Second task failed'
        });

      const result = await syncEngine.syncAll(tasksPath);

      expect(result.success).toBe(false);
      expect(result.totalItems).toBe(2);
      expect(result.synced).toBe(1);
      expect(result.errors).toBe(1);
      expect(result.details).toHaveLength(2);
      
      expect(result.details[0].success).toBe(true);
      expect(result.details[1].success).toBe(false);
      expect(result.details[1].error).toBe('Second task failed');

      mockSyncTask.mockRestore();
    });

    it('should handle empty sync list', async () => {
      mockGetTasksNeedingSync.mockReturnValue([]);

      const result = await syncEngine.syncAll(tasksPath);

      expect(result.success).toBe(true);
      expect(result.totalItems).toBe(0);
      expect(result.synced).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.details).toHaveLength(0);
    });
  });

  describe('testSync', () => {
    it('should return success when all tests pass', async () => {
      mockClientInstance.testConnection.mockResolvedValue({ success: true });
      mockClientInstance.testBoardAccess.mockResolvedValue({ 
        success: true, 
        data: { id: '9275265350', name: 'Test Board' }
      });

      const result = await syncEngine.testSync();

      expect(result.success).toBe(true);
      expect(result.message).toContain('successful');
      expect(result.details.connection.success).toBe(true);
      expect(result.details.board.success).toBe(true);
      expect(result.details.config.boardId).toBe('9275265350');
    });

    it('should return failure when connection test fails', async () => {
      mockClientInstance.testConnection.mockResolvedValue({ 
        success: false, 
        error: 'Connection failed' 
      });

      const result = await syncEngine.testSync();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to connect to Monday.com API');
    });

    it('should return failure when board access test fails', async () => {
      mockClientInstance.testConnection.mockResolvedValue({ success: true });
      mockClientInstance.testBoardAccess.mockResolvedValue({ 
        success: false, 
        error: 'Board not accessible' 
      });

      const result = await syncEngine.testSync();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to access Monday.com board');
    });

    it('should handle unexpected errors', async () => {
      mockClientInstance.testConnection.mockRejectedValue(new Error('Unexpected error'));

      const result = await syncEngine.testSync();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error');
    });
  });

  describe('createMondaySyncEngine', () => {
    it('should create a sync engine instance', () => {
      const engine = createMondaySyncEngine(projectRoot);
      expect(engine).toBeInstanceOf(MondaySyncEngine);
      expect(engine.projectRoot).toBe(projectRoot);
    });

    it('should pass session to constructor', () => {
      const session = { userId: 'test' };
      const engine = createMondaySyncEngine(projectRoot, session);
      expect(engine.session).toBe(session);
    });
  });
}); 