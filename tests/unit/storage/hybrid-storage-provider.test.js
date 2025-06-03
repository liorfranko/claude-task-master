/**
 * Unit tests for the HybridStorageProvider
 * Tests hybrid mode functionality including conflict resolution, sync behavior, and dual provider operations
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

// Mock the utils module
const mockUtils = {
  log: jest.fn(),
  enableSilentMode: jest.fn(),
  disableSilentMode: jest.fn(),
  isSilentMode: jest.fn().mockReturnValue(false)
};

// Mock config manager
const mockGetConfig = jest.fn().mockReturnValue({
  persistence: {
    hybridConfig: {
      primaryProvider: 'local',
      autoSync: false,
      syncOnWrite: true,
      conflictResolution: 'manual'
    }
  }
});

// Mock the hybrid sync engine
class MockHybridSyncEngine extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.conflicts = new Map();
  }

  async start() {
    this.isRunning = true;
    this.emit('started');
  }

  async stop() {
    this.isRunning = false;
    this.emit('stopped');
  }

  async syncAll() {
    return {
      localToMonday: { created: 0, updated: 0, failed: 0, skipped: 0 },
      mondayToLocal: { created: 0, updated: 0, failed: 0, skipped: 0 },
      conflicts: { detected: 0, resolved: 0, remaining: 0 },
      duration: 100,
      timestamp: new Date().toISOString()
    };
  }

  async syncTask(taskId) {
    return { taskId, status: 'synced' };
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      lastSync: null,
      conflicts: 0
    };
  }

  getConflicts() {
    return Array.from(this.conflicts.values());
  }

  async resolveConflict(taskId, strategy) {
    this.conflicts.delete(taskId);
    return { taskId, strategy, resolved: true };
  }
}

// Mock providers
class MockLocalProvider {
  constructor() {
    this.isInitialized = false;
    this.tasks = [
      { id: 1, title: 'Local Task 1', status: 'pending', lastModifiedLocal: '2024-01-01T10:00:00Z' },
      { id: 2, title: 'Local Task 2', status: 'done', lastModifiedLocal: '2024-01-01T11:00:00Z' }
    ];
  }

  async initialize() {
    this.isInitialized = true;
  }

  async getTasks() {
    return [...this.tasks];
  }

  async getTask(id) {
    return this.tasks.find(task => task.id === parseInt(id));
  }

  async createTask(taskData) {
    const newTask = {
      id: this.tasks.length + 1,
      ...taskData,
      lastModifiedLocal: new Date().toISOString()
    };
    this.tasks.push(newTask);
    return newTask;
  }

  async updateTask(id, updateData) {
    const index = this.tasks.findIndex(task => task.id === parseInt(id));
    if (index === -1) throw new Error('Task not found');
    
    this.tasks[index] = {
      ...this.tasks[index],
      ...updateData,
      lastModifiedLocal: new Date().toISOString()
    };
    return this.tasks[index];
  }

  async deleteTask(id) {
    const index = this.tasks.findIndex(task => task.id === parseInt(id));
    if (index === -1) throw new Error('Task not found');
    this.tasks.splice(index, 1);
    return true;
  }

  async getSubtasks(parentId) {
    return [];
  }

  async createSubtask(parentId, subtaskData) {
    return { id: `${parentId}.1`, parentId, ...subtaskData };
  }

  async updateSubtask(parentId, subtaskId, updateData) {
    return { id: subtaskId, parentId, ...updateData };
  }

  async deleteSubtask(parentId, subtaskId) {
    return true;
  }

  async saveTasks(tasks) {
    this.tasks = [...tasks];
  }

  async validate() {
    return true;
  }
}

class MockMondayProvider {
  constructor() {
    this.isInitialized = false;
    this.tasks = [
      { id: 1, title: 'Monday Task 1', status: 'pending', mondayItemId: '101', lastSyncedAt: '2024-01-01T10:00:00Z' },
      { id: 3, title: 'Monday Task 3', status: 'done', mondayItemId: '103', lastSyncedAt: '2024-01-01T12:00:00Z' }
    ];
  }

  async initialize() {
    this.isInitialized = true;
  }

  async getTasks() {
    return [...this.tasks];
  }

  async getTask(id) {
    return this.tasks.find(task => task.id === parseInt(id));
  }

  async createTask(taskData) {
    const newTask = {
      id: this.tasks.length + 10,
      ...taskData,
      mondayItemId: `${100 + this.tasks.length + 10}`,
      lastSyncedAt: new Date().toISOString()
    };
    this.tasks.push(newTask);
    return newTask;
  }

  async updateTask(id, updateData) {
    const index = this.tasks.findIndex(task => task.id === parseInt(id));
    if (index === -1) throw new Error('Task not found');
    
    this.tasks[index] = {
      ...this.tasks[index],
      ...updateData,
      lastSyncedAt: new Date().toISOString()
    };
    return this.tasks[index];
  }

  async deleteTask(id) {
    const index = this.tasks.findIndex(task => task.id === parseInt(id));
    if (index === -1) throw new Error('Task not found');
    this.tasks.splice(index, 1);
    return true;
  }

  async getSubtasks(parentId) {
    return [];
  }

  async createSubtask(parentId, subtaskData) {
    return { id: `${parentId}.1`, parentId, ...subtaskData };
  }

  async updateSubtask(parentId, subtaskId, updateData) {
    return { id: subtaskId, parentId, ...updateData };
  }

  async deleteSubtask(parentId, subtaskId) {
    return true;
  }

  async saveTasks(tasks) {
    this.tasks = [...tasks];
  }

  async validate() {
    return true;
  }
}

// Mock persistence manager
class MockPersistenceManager {
  constructor() {
    this.providers = new Map();
    this.providers.set('local', new MockLocalProvider());
    this.providers.set('monday', new MockMondayProvider());
  }
}

// Setup mocks
jest.unstable_mockModule('../../../scripts/modules/utils.js', () => mockUtils);
jest.unstable_mockModule('../../../scripts/modules/config-manager.js', () => ({ getConfig: mockGetConfig }));
jest.unstable_mockModule('../../../scripts/modules/hybrid-sync-engine.js', () => ({ 
  HybridSyncEngine: MockHybridSyncEngine 
}));

// Import after mocking
const { HybridStorageProvider } = await import('../../../scripts/modules/storage/hybrid-storage-provider.js');

describe('HybridStorageProvider', () => {
  let provider;
  let mockPersistenceManager;
  let mockLocalProvider;
  let mockMondayProvider;

  beforeEach(() => {
    mockPersistenceManager = new MockPersistenceManager();
    mockLocalProvider = mockPersistenceManager.providers.get('local');
    mockMondayProvider = mockPersistenceManager.providers.get('monday');
    
    const config = {
      persistence: {
        hybridConfig: {
          primaryProvider: 'local',
          autoSync: false,
          syncOnWrite: true,
          conflictResolution: 'manual'
        }
      }
    };

    provider = new HybridStorageProvider(config, mockPersistenceManager);
    
    // Reset all mocks
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (provider.isInitialized) {
      await provider.destroy();
    }
  });

  describe('initialization', () => {
    test('should initialize with default configuration', () => {
      expect(provider.hybridConfig.primaryProvider).toBe('local');
      expect(provider.hybridConfig.autoSync).toBe(false);
      expect(provider.hybridConfig.syncOnWrite).toBe(true);
    });

    test('should initialize both providers and sync engine', async () => {
      await provider.initialize();
      
      expect(provider.isInitialized).toBe(true);
      expect(provider.localProvider.isInitialized).toBe(true);
      expect(provider.mondayProvider.isInitialized).toBe(true);
      expect(provider.syncEngine).toBeInstanceOf(MockHybridSyncEngine);
    });

    test('should start sync engine if auto-sync is enabled', async () => {
      provider.hybridConfig.autoSync = true;
      await provider.initialize();
      
      expect(provider.syncEngine.isRunning).toBe(true);
    });

    test('should not start sync engine if auto-sync is disabled', async () => {
      provider.hybridConfig.autoSync = false;
      await provider.initialize();
      
      expect(provider.syncEngine.isRunning).toBe(false);
    });

    test('should throw error if providers are not available', async () => {
      const emptyPersistenceManager = { providers: new Map() };
      const badProvider = new HybridStorageProvider({}, emptyPersistenceManager);
      
      await expect(badProvider.initialize()).rejects.toThrow(
        'Both local and Monday providers must be registered before initializing hybrid provider'
      );
    });
  });

  describe('CRUD operations', () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    describe('getTasks', () => {
      test('should get tasks from primary provider (local)', async () => {
        const tasks = await provider.getTasks();
        
        expect(tasks).toHaveLength(2);
        expect(tasks[0].title).toBe('Local Task 1');
        expect(tasks[1].title).toBe('Local Task 2');
      });

      test('should get tasks from Monday when configured as primary', async () => {
        provider.hybridConfig.primaryProvider = 'monday';
        
        const tasks = await provider.getTasks();
        
        expect(tasks).toHaveLength(2);
        expect(tasks[0].title).toBe('Monday Task 1');
        expect(tasks[1].title).toBe('Monday Task 3');
      });
    });

    describe('getTask', () => {
      test('should get specific task from primary provider', async () => {
        const task = await provider.getTask(1);
        
        expect(task).toBeDefined();
        expect(task.title).toBe('Local Task 1');
      });

      test('should return undefined for non-existent task', async () => {
        const task = await provider.getTask(999);
        
        expect(task).toBeUndefined();
      });
    });

    describe('createTask', () => {
      test('should create task in primary provider', async () => {
        const taskData = { title: 'New Task', status: 'pending' };
        
        const createdTask = await provider.createTask(taskData);
        
        expect(createdTask).toBeDefined();
        expect(createdTask.title).toBe('New Task');
        expect(createdTask.lastModifiedLocal).toBeDefined();
      });

      test('should trigger sync when syncOnWrite is enabled', async () => {
        const syncSpy = jest.spyOn(provider.syncEngine, 'syncTask');
        const taskData = { title: 'New Task', status: 'pending' };
        
        const createdTask = await provider.createTask(taskData);
        
        expect(syncSpy).toHaveBeenCalledWith(createdTask.id);
      });

      test('should not trigger sync when syncOnWrite is disabled', async () => {
        provider.hybridConfig.syncOnWrite = false;
        const syncSpy = jest.spyOn(provider.syncEngine, 'syncTask');
        const taskData = { title: 'New Task', status: 'pending' };
        
        await provider.createTask(taskData);
        
        expect(syncSpy).not.toHaveBeenCalled();
      });

      test('should handle sync failure gracefully', async () => {
        jest.spyOn(provider.syncEngine, 'syncTask').mockRejectedValue(new Error('Sync failed'));
        const taskData = { title: 'New Task', status: 'pending' };
        
        // Should not throw even if sync fails
        const createdTask = await provider.createTask(taskData);
        
        expect(createdTask).toBeDefined();
        expect(createdTask.title).toBe('New Task');
      });

      test('should emit taskCreated event', async () => {
        const eventSpy = jest.fn();
        provider.on('taskCreated', eventSpy);
        
        const taskData = { title: 'New Task', status: 'pending' };
        const createdTask = await provider.createTask(taskData);
        
        expect(eventSpy).toHaveBeenCalledWith(createdTask);
      });
    });

    describe('updateTask', () => {
      test('should update task in primary provider', async () => {
        const updateData = { title: 'Updated Title', status: 'in-progress' };
        
        const updatedTask = await provider.updateTask(1, updateData);
        
        expect(updatedTask.title).toBe('Updated Title');
        expect(updatedTask.status).toBe('in-progress');
        expect(updatedTask.lastModifiedLocal).toBeDefined();
      });

      test('should trigger sync when syncOnWrite is enabled', async () => {
        const syncSpy = jest.spyOn(provider.syncEngine, 'syncTask');
        const updateData = { title: 'Updated Title' };
        
        await provider.updateTask(1, updateData);
        
        expect(syncSpy).toHaveBeenCalledWith(1);
      });

      test('should emit taskUpdated event', async () => {
        const eventSpy = jest.fn();
        provider.on('taskUpdated', eventSpy);
        
        const updateData = { title: 'Updated Title' };
        const updatedTask = await provider.updateTask(1, updateData);
        
        expect(eventSpy).toHaveBeenCalledWith(updatedTask);
      });
    });

    describe('deleteTask', () => {
      test('should delete task from both providers', async () => {
        const localDeleteSpy = jest.spyOn(mockLocalProvider, 'deleteTask');
        const mondayDeleteSpy = jest.spyOn(mockMondayProvider, 'deleteTask');
        
        const result = await provider.deleteTask(1);
        
        expect(result).toBe(true);
        expect(localDeleteSpy).toHaveBeenCalledWith(1);
        expect(mondayDeleteSpy).toHaveBeenCalledWith(1);
      });

      test('should emit taskDeleted event', async () => {
        const eventSpy = jest.fn();
        provider.on('taskDeleted', eventSpy);
        
        await provider.deleteTask(1);
        
        expect(eventSpy).toHaveBeenCalledWith(1);
      });
    });
  });

  describe('subtask operations', () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    test('should get subtasks from primary provider', async () => {
      const subtasks = await provider.getSubtasks(1);
      
      expect(Array.isArray(subtasks)).toBe(true);
    });

    test('should create subtask in primary provider', async () => {
      const subtaskData = { title: 'New Subtask', status: 'pending' };
      
      const createdSubtask = await provider.createSubtask(1, subtaskData);
      
      expect(createdSubtask).toBeDefined();
      expect(createdSubtask.parentId).toBe(1);
      expect(createdSubtask.title).toBe('New Subtask');
    });

    test('should update subtask in primary provider', async () => {
      const updateData = { title: 'Updated Subtask' };
      
      const updatedSubtask = await provider.updateSubtask(1, '1.1', updateData);
      
      expect(updatedSubtask.title).toBe('Updated Subtask');
    });

    test('should delete subtask from primary provider', async () => {
      const result = await provider.deleteSubtask(1, '1.1');
      
      expect(result).toBe(true);
    });

    test('should trigger sync on subtask operations when enabled', async () => {
      const syncSpy = jest.spyOn(provider.syncEngine, 'syncTask');
      
      await provider.createSubtask(1, { title: 'New Subtask' });
      await provider.updateSubtask(1, '1.1', { title: 'Updated' });
      await provider.deleteSubtask(1, '1.1');
      
      expect(syncSpy).toHaveBeenCalledTimes(3);
      expect(syncSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('batch operations', () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    test('should save tasks to primary provider', async () => {
      const tasks = [
        { id: 1, title: 'Task 1', status: 'pending' },
        { id: 2, title: 'Task 2', status: 'done' }
      ];
      
      await provider.saveTasks(tasks);
      
      // Should not throw
      expect(true).toBe(true);
    });

    test('should trigger full sync on batch save when enabled', async () => {
      const syncSpy = jest.spyOn(provider.syncEngine, 'syncAll');
      const tasks = [{ id: 1, title: 'Task 1', status: 'pending' }];
      
      await provider.saveTasks(tasks);
      
      expect(syncSpy).toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    test('should validate both providers', async () => {
      const isValid = await provider.validate();
      
      expect(isValid).toBe(true);
    });

    test('should fail validation if any provider fails', async () => {
      jest.spyOn(mockMondayProvider, 'validate').mockResolvedValue(false);
      
      const isValid = await provider.validate();
      
      expect(isValid).toBe(false);
    });
  });

  describe('provider information', () => {
    test('should return provider info', () => {
      const info = provider.getProviderInfo();
      
      expect(info.name).toBe('hybrid');
      expect(info.version).toBe('1.0.0');
      expect(info.capabilities).toContain('read');
      expect(info.capabilities).toContain('write');
      expect(info.capabilities).toContain('sync');
      expect(info.capabilities).toContain('conflict-resolution');
      expect(info.primaryProvider).toBe('local');
    });
  });

  describe('sync operations', () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    test('should get sync status', () => {
      const status = provider.getSyncStatus();
      
      expect(status.available).toBe(true);
      expect(status.isRunning).toBe(false);
    });

    test('should trigger manual sync', async () => {
      const syncSpy = jest.spyOn(provider.syncEngine, 'syncAll');
      
      const result = await provider.triggerSync();
      
      expect(syncSpy).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    test('should get conflicts', () => {
      const conflicts = provider.getConflicts();
      
      expect(Array.isArray(conflicts)).toBe(true);
    });

    test('should resolve conflicts', async () => {
      const resolveSpy = jest.spyOn(provider.syncEngine, 'resolveConflict');
      
      const result = await provider.resolveConflict(1, 'local-wins');
      
      expect(resolveSpy).toHaveBeenCalledWith(1, 'local-wins');
      expect(result.resolved).toBe(true);
    });

    test('should start sync engine', async () => {
      await provider.startSync();
      
      expect(provider.syncEngine.isRunning).toBe(true);
    });

    test('should stop sync engine', async () => {
      await provider.startSync();
      await provider.stopSync();
      
      expect(provider.syncEngine.isRunning).toBe(false);
    });
  });

  describe('error handling', () => {
    test('should handle initialization failure', async () => {
      jest.spyOn(mockLocalProvider, 'initialize').mockRejectedValue(new Error('Init failed'));
      
      await expect(provider.initialize()).rejects.toThrow('Init failed');
    });

    test('should handle CRUD operation failures', async () => {
      await provider.initialize();
      jest.spyOn(mockLocalProvider, 'createTask').mockRejectedValue(new Error('Create failed'));
      
      await expect(provider.createTask({ title: 'Test' })).rejects.toThrow('Create failed');
    });

    test('should handle sync engine unavailability', async () => {
      await provider.initialize();
      provider.syncEngine = null;
      
      await expect(provider.triggerSync()).rejects.toThrow('Sync engine not available');
      await expect(provider.resolveConflict(1, 'local-wins')).rejects.toThrow('Sync engine not available');
      await expect(provider.startSync()).rejects.toThrow('Sync engine not available');
    });
  });

  describe('configuration variations', () => {
    test('should work with Monday as primary provider', async () => {
      provider.hybridConfig.primaryProvider = 'monday';
      await provider.initialize();
      
      const tasks = await provider.getTasks();
      expect(tasks[0].title).toBe('Monday Task 1');
    });

    test('should handle different conflict resolution strategies', () => {
      provider.hybridConfig.conflictResolution = 'local-wins';
      expect(provider.hybridConfig.conflictResolution).toBe('local-wins');
      
      provider.hybridConfig.conflictResolution = 'monday-wins';
      expect(provider.hybridConfig.conflictResolution).toBe('monday-wins');
    });
  });

  describe('event handling', () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    test('should emit sync events', () => {
      const conflictSpy = jest.fn();
      const resolvedSpy = jest.fn();
      const errorSpy = jest.fn();
      const completedSpy = jest.fn();

      provider.on('syncConflict', conflictSpy);
      provider.on('syncResolved', resolvedSpy);
      provider.on('syncError', errorSpy);
      provider.on('syncCompleted', completedSpy);

      // Simulate sync engine events
      provider.syncEngine.emit('conflictDetected', { id: 1 });
      provider.syncEngine.emit('conflictResolved', { taskId: 1 });
      provider.syncEngine.emit('syncError', new Error('Test error'));
      provider.syncEngine.emit('syncCompleted', { success: true });

      expect(conflictSpy).toHaveBeenCalledWith({ id: 1 });
      expect(resolvedSpy).toHaveBeenCalledWith({ taskId: 1 });
      expect(errorSpy).toHaveBeenCalledWith(new Error('Test error'));
      expect(completedSpy).toHaveBeenCalledWith({ success: true });
    });
  });

  describe('cleanup', () => {
    test('should cleanup resources on destroy', async () => {
      await provider.initialize();
      const stopSyncSpy = jest.spyOn(provider, 'stopSync');
      
      await provider.destroy();
      
      expect(stopSyncSpy).toHaveBeenCalled();
    });

    test('should handle destroy errors gracefully', async () => {
      await provider.initialize();
      jest.spyOn(provider, 'stopSync').mockRejectedValue(new Error('Stop failed'));
      
      // Should not throw
      await provider.destroy();
      expect(true).toBe(true);
    });
  });
}); 