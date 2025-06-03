/**
 * hybrid-storage-provider.js
 * Hybrid Storage Provider for Task Master
 * 
 * This provider implements hybrid mode where tasks are stored in both
 * local storage and Monday.com with bidirectional synchronization.
 * It uses the HybridSyncEngine to manage conflicts and maintain data consistency.
 */

import { EventEmitter } from 'events';
import { log } from '../utils.js';
import { getConfig } from '../config-manager.js';
import { HybridSyncEngine } from '../hybrid-sync-engine.js';

/**
 * Hybrid Storage Provider
 * Combines local and Monday.com storage with bidirectional sync
 */
export class HybridStorageProvider extends EventEmitter {
  /**
   * Initialize the hybrid storage provider
   * @param {Object} config - Configuration object
   * @param {Object} persistenceManager - Persistence manager instance
   */
  constructor(config, persistenceManager) {
    super();
    
    this.config = config || getConfig();
    this.persistenceManager = persistenceManager;
    this.isInitialized = false;
    
    // Get individual providers
    this.localProvider = null;
    this.mondayProvider = null;
    this.syncEngine = null;
    
    // Configuration for hybrid mode
    this.hybridConfig = this.config.persistence?.hybridConfig || {
      primaryProvider: 'local',        // Which provider to use as primary for reads
      autoSync: false,                 // Whether to auto-sync in background
      syncOnWrite: true                // Sync after write operations
    };
    
    log('debug', 'HybridStorageProvider initialized', this.hybridConfig);
  }

  /**
   * Initialize the hybrid storage provider
   */
  async initialize() {
    if (this.isInitialized) {
      log('debug', 'HybridStorageProvider already initialized');
      return;
    }

    try {
      // Get local and Monday providers from persistence manager
      this.localProvider = this.persistenceManager.providers.get('local');
      this.mondayProvider = this.persistenceManager.providers.get('monday');

      if (!this.localProvider || !this.mondayProvider) {
        throw new Error('Both local and Monday providers must be registered before initializing hybrid provider');
      }

      // Initialize individual providers
      if (!this.localProvider.isInitialized) {
        await this.localProvider.initialize();
      }
      if (!this.mondayProvider.isInitialized) {
        await this.mondayProvider.initialize();
      }

      // Create and initialize sync engine
      this.syncEngine = new HybridSyncEngine(this.config, this.persistenceManager);
      
      // Set up sync engine event handlers
      this.syncEngine.on('conflictDetected', (conflict) => {
        log('warn', `Sync conflict detected for task ${conflict.id}`);
        this.emit('syncConflict', conflict);
      });

      this.syncEngine.on('conflictResolved', (resolution) => {
        log('info', `Sync conflict resolved for task ${resolution.taskId}`);
        this.emit('syncResolved', resolution);
      });

      this.syncEngine.on('syncError', (error) => {
        log('error', 'Sync engine error:', error);
        this.emit('syncError', error);
      });

      this.syncEngine.on('syncCompleted', (results) => {
        log('info', 'Sync completed:', results);
        this.emit('syncCompleted', results);
      });

      // Start sync engine if auto-sync is enabled
      if (this.hybridConfig.autoSync) {
        await this.syncEngine.start();
      }

      this.isInitialized = true;
      log('info', 'HybridStorageProvider initialized successfully');

    } catch (error) {
      log('error', 'Failed to initialize HybridStorageProvider:', error);
      throw error;
    }
  }

  /**
   * Get all tasks
   * Reads from primary provider and ensures sync if needed
   */
  async getTasks() {
    await this._ensureInitialized();
    
    try {
      // Get tasks from primary provider
      const primaryProvider = this._getPrimaryProvider();
      const tasks = await primaryProvider.getTasks();
      
      // If auto-sync is disabled, optionally trigger a sync check
      if (!this.hybridConfig.autoSync && this.syncEngine) {
        // We could optionally do a background sync here
        // For now, just log that we're using potentially stale data
        log('debug', `Retrieved ${tasks.length} tasks from ${this.hybridConfig.primaryProvider} provider`);
      }
      
      return tasks;
      
    } catch (error) {
      log('error', 'Failed to get tasks from hybrid provider:', error);
      throw error;
    }
  }

  /**
   * Get a specific task by ID
   */
  async getTask(id) {
    await this._ensureInitialized();
    
    try {
      const primaryProvider = this._getPrimaryProvider();
      return await primaryProvider.getTask(id);
      
    } catch (error) {
      log('error', `Failed to get task ${id} from hybrid provider:`, error);
      throw error;
    }
  }

  /**
   * Create a new task
   * Creates in both providers with sync
   */
  async createTask(taskData) {
    await this._ensureInitialized();
    
    try {
      // Create in primary provider first
      const primaryProvider = this._getPrimaryProvider();
      const createdTask = await primaryProvider.createTask(taskData);
      
      // Sync to secondary provider if sync on write is enabled
      if (this.hybridConfig.syncOnWrite && this.syncEngine) {
        try {
          await this.syncEngine.syncTask(createdTask.id);
        } catch (syncError) {
          log('warn', `Failed to sync new task ${createdTask.id}:`, syncError);
          // Don't fail the create operation due to sync failure
        }
      }
      
      this.emit('taskCreated', createdTask);
      return createdTask;
      
    } catch (error) {
      log('error', 'Failed to create task in hybrid provider:', error);
      throw error;
    }
  }

  /**
   * Update an existing task
   * Updates in both providers with sync
   */
  async updateTask(id, updateData) {
    await this._ensureInitialized();
    
    try {
      // Update in primary provider first
      const primaryProvider = this._getPrimaryProvider();
      const updatedTask = await primaryProvider.updateTask(id, {
        ...updateData,
        lastModifiedLocal: new Date().toISOString() // Track local modification time
      });
      
      // Sync to secondary provider if sync on write is enabled
      if (this.hybridConfig.syncOnWrite && this.syncEngine) {
        try {
          await this.syncEngine.syncTask(id);
        } catch (syncError) {
          log('warn', `Failed to sync updated task ${id}:`, syncError);
          // Don't fail the update operation due to sync failure
        }
      }
      
      this.emit('taskUpdated', updatedTask);
      return updatedTask;
      
    } catch (error) {
      log('error', `Failed to update task ${id} in hybrid provider:`, error);
      throw error;
    }
  }

  /**
   * Delete a task
   * Deletes from both providers with sync
   */
  async deleteTask(id) {
    await this._ensureInitialized();
    
    try {
      // Delete from both providers
      await Promise.all([
        this.localProvider.deleteTask(id),
        this.mondayProvider.deleteTask(id)
      ]);
      
      this.emit('taskDeleted', id);
      return true;
      
    } catch (error) {
      log('error', `Failed to delete task ${id} from hybrid provider:`, error);
      throw error;
    }
  }

  /**
   * Get all subtasks for a parent task
   */
  async getSubtasks(parentId) {
    await this._ensureInitialized();
    
    try {
      const primaryProvider = this._getPrimaryProvider();
      return await primaryProvider.getSubtasks(parentId);
      
    } catch (error) {
      log('error', `Failed to get subtasks for ${parentId} from hybrid provider:`, error);
      throw error;
    }
  }

  /**
   * Create a new subtask
   */
  async createSubtask(parentId, subtaskData) {
    await this._ensureInitialized();
    
    try {
      const primaryProvider = this._getPrimaryProvider();
      const createdSubtask = await primaryProvider.createSubtask(parentId, subtaskData);
      
      // Sync parent task if sync on write is enabled
      if (this.hybridConfig.syncOnWrite && this.syncEngine) {
        try {
          await this.syncEngine.syncTask(parentId);
        } catch (syncError) {
          log('warn', `Failed to sync parent task ${parentId} after subtask creation:`, syncError);
        }
      }
      
      return createdSubtask;
      
    } catch (error) {
      log('error', `Failed to create subtask for ${parentId} in hybrid provider:`, error);
      throw error;
    }
  }

  /**
   * Update a subtask
   */
  async updateSubtask(parentId, subtaskId, updateData) {
    await this._ensureInitialized();
    
    try {
      const primaryProvider = this._getPrimaryProvider();
      const updatedSubtask = await primaryProvider.updateSubtask(parentId, subtaskId, updateData);
      
      // Sync parent task if sync on write is enabled
      if (this.hybridConfig.syncOnWrite && this.syncEngine) {
        try {
          await this.syncEngine.syncTask(parentId);
        } catch (syncError) {
          log('warn', `Failed to sync parent task ${parentId} after subtask update:`, syncError);
        }
      }
      
      return updatedSubtask;
      
    } catch (error) {
      log('error', `Failed to update subtask ${subtaskId} for ${parentId} in hybrid provider:`, error);
      throw error;
    }
  }

  /**
   * Delete a subtask
   */
  async deleteSubtask(parentId, subtaskId) {
    await this._ensureInitialized();
    
    try {
      const primaryProvider = this._getPrimaryProvider();
      const result = await primaryProvider.deleteSubtask(parentId, subtaskId);
      
      // Sync parent task if sync on write is enabled
      if (this.hybridConfig.syncOnWrite && this.syncEngine) {
        try {
          await this.syncEngine.syncTask(parentId);
        } catch (syncError) {
          log('warn', `Failed to sync parent task ${parentId} after subtask deletion:`, syncError);
        }
      }
      
      return result;
      
    } catch (error) {
      log('error', `Failed to delete subtask ${subtaskId} for ${parentId} in hybrid provider:`, error);
      throw error;
    }
  }

  /**
   * Save all tasks (batch operation)
   */
  async saveTasks(tasks) {
    await this._ensureInitialized();
    
    try {
      // Save to primary provider first
      const primaryProvider = this._getPrimaryProvider();
      await primaryProvider.saveTasks(tasks);
      
      // Trigger full sync if enabled
      if (this.hybridConfig.syncOnWrite && this.syncEngine) {
        try {
          await this.syncEngine.syncAll();
        } catch (syncError) {
          log('warn', 'Failed to sync after batch save:', syncError);
        }
      }
      
    } catch (error) {
      log('error', 'Failed to save tasks in hybrid provider:', error);
      throw error;
    }
  }

  /**
   * Validate the storage connection/configuration
   */
  async validate() {
    try {
      await this._ensureInitialized();
      
      // Validate both providers
      const [localValid, mondayValid] = await Promise.all([
        this.localProvider.validate(),
        this.mondayProvider.validate()
      ]);
      
      return localValid && mondayValid;
      
    } catch (error) {
      log('error', 'Hybrid provider validation failed:', error);
      return false;
    }
  }

  /**
   * Get provider-specific metadata
   */
  getProviderInfo() {
    return {
      name: 'hybrid',
      version: '1.0.0',
      capabilities: ['read', 'write', 'sync', 'conflict-resolution'],
      primaryProvider: this.hybridConfig.primaryProvider,
      syncEnabled: this.hybridConfig.autoSync,
      conflictResolution: this.hybridConfig.conflictResolution
    };
  }

  /**
   * Get sync engine status
   */
  getSyncStatus() {
    if (!this.syncEngine) {
      return { available: false };
    }
    
    return {
      available: true,
      ...this.syncEngine.getStatus()
    };
  }

  /**
   * Manually trigger a sync
   */
  async triggerSync() {
    await this._ensureInitialized();
    
    if (!this.syncEngine) {
      throw new Error('Sync engine not available');
    }
    
    return await this.syncEngine.syncAll();
  }

  /**
   * Get current conflicts
   */
  getConflicts() {
    if (!this.syncEngine) {
      return [];
    }
    
    return this.syncEngine.getConflicts();
  }

  /**
   * Resolve a specific conflict
   */
  async resolveConflict(taskId, strategy) {
    await this._ensureInitialized();
    
    if (!this.syncEngine) {
      throw new Error('Sync engine not available');
    }
    
    return await this.syncEngine.resolveConflict(taskId, strategy);
  }

  /**
   * Start the sync engine
   */
  async startSync() {
    await this._ensureInitialized();
    
    if (!this.syncEngine) {
      throw new Error('Sync engine not available');
    }
    
    await this.syncEngine.start();
  }

  /**
   * Stop the sync engine
   */
  async stopSync() {
    if (this.syncEngine && this.syncEngine.isRunning) {
      await this.syncEngine.stop();
    }
  }

  /**
   * Get the primary provider based on configuration
   * @private
   */
  _getPrimaryProvider() {
    if (this.hybridConfig.primaryProvider === 'monday') {
      return this.mondayProvider;
    }
    return this.localProvider;
  }

  /**
   * Ensure the provider is initialized
   * @private
   */
  async _ensureInitialized() {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  /**
   * Cleanup resources when shutting down
   */
  async destroy() {
    try {
      await this.stopSync();
      this.removeAllListeners();
      log('info', 'HybridStorageProvider destroyed');
    } catch (error) {
      log('error', 'Error destroying HybridStorageProvider:', error);
    }
  }
}

export default HybridStorageProvider; 