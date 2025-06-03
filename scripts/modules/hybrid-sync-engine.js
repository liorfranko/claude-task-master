/**
 * hybrid-sync-engine.js
 * Bidirectional sync engine for hybrid mode between local storage and Monday.com
 * 
 * This engine provides:
 * - Bidirectional synchronization between local tasks.json and Monday.com
 * - Conflict detection and resolution strategies
 * - Sync state tracking with timestamps
 * - Partial sync failure handling
 * - Support for different conflict resolution strategies
 */

import { EventEmitter } from 'events';
import { log } from './utils.js';
import { getConfig } from './config-manager.js';

/**
 * Conflict resolution strategies
 */
export const CONFLICT_STRATEGIES = {
  MANUAL: 'manual',           // User decides for each conflict
  LOCAL_WINS: 'local-wins',   // Local changes always take precedence
  MONDAY_WINS: 'monday-wins', // Monday.com changes always take precedence
  NEWEST_WINS: 'newest-wins'  // Most recently modified wins
};

/**
 * Sync status values
 */
export const SYNC_STATUS = {
  SYNCED: 'synced',
  PENDING: 'pending',
  CONFLICT: 'conflict',
  ERROR: 'error'
};

/**
 * Hybrid Sync Engine for bidirectional synchronization
 */
export class HybridSyncEngine extends EventEmitter {
  /**
   * Initialize the sync engine
   * @param {Object} config - Configuration object
   * @param {Object} persistenceManager - Persistence manager instance
   */
  constructor(config, persistenceManager) {
    super();
    
    this.config = config || getConfig();
    this.persistenceManager = persistenceManager;
    
    // Get providers
    this.localProvider = persistenceManager.providers.get('local');
    this.mondayProvider = persistenceManager.providers.get('monday');
    
    if (!this.localProvider || !this.mondayProvider) {
      throw new Error('Both local and Monday providers must be registered for hybrid sync');
    }
    
    // Sync configuration
    this.conflictResolution = this.config.persistence?.hybridConfig?.conflictResolution || 'manual';
    this.autoSync = this.config.persistence?.hybridConfig?.autoSync || false;
    
    // State tracking
    this.conflicts = new Map();
    this.syncState = new Map();
    this.isRunning = false;
    this.lastSyncTime = null;
    
    log('debug', 'HybridSyncEngine initialized', {
      conflictResolution: this.conflictResolution,
      autoSync: this.autoSync
    });
  }

  /**
   * Start the sync engine
   */
  async start() {
    if (this.isRunning) {
      log('warn', 'Sync engine is already running');
      return;
    }

    try {
      // Initialize providers if needed
      if (!this.localProvider.isInitialized) {
        await this.localProvider.initialize();
      }
      if (!this.mondayProvider.isInitialized) {
        await this.mondayProvider.initialize();
      }

      this.isRunning = true;
      
      // Perform initial sync
      await this.syncAll();
      
      // Start auto-sync if enabled
      if (this.autoSync) {
        this.autoSyncTimer = setInterval(() => {
          this.syncAll().catch(error => {
            log('error', 'Auto-sync failed:', error);
            this.emit('syncError', error);
          });
        }, 300000); // 5 minutes default
      }
      
      this.emit('started');
      log('info', 'HybridSyncEngine started');
      
    } catch (error) {
      this.isRunning = false;
      log('error', 'Failed to start sync engine:', error);
      throw error;
    }
  }

  /**
   * Stop the sync engine
   */
  async stop() {
    if (!this.isRunning) {
      log('warn', 'Sync engine is not running');
      return;
    }

    this.isRunning = false;
    
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    
    this.emit('stopped');
    log('info', 'HybridSyncEngine stopped');
  }

  /**
   * Perform a complete bidirectional sync
   * @returns {Promise<Object>} Sync results
   */
  async syncAll() {
    log('info', 'Starting bidirectional sync...');
    const startTime = Date.now();
    
    try {
      // Get tasks from both sources
      const [localTasks, mondayTasks] = await Promise.all([
        this.localProvider.getTasks(),
        this.mondayProvider.getTasks()
      ]);
      
      log('debug', `Retrieved ${localTasks.length} local tasks and ${mondayTasks.length} Monday tasks`);
      
      // Create lookup maps
      const localTasksMap = new Map();
      const mondayTasksMap = new Map();
      
      localTasks.forEach(task => {
        localTasksMap.set(task.id, task);
      });
      
      mondayTasks.forEach(task => {
        // Use mondayItemId if available, otherwise use id
        const key = task.mondayItemId || task.id;
        if (key) {
          mondayTasksMap.set(task.id, task);
        }
      });
      
      // Initialize sync results
      const results = {
        localToMonday: { created: 0, updated: 0, failed: 0, skipped: 0 },
        mondayToLocal: { created: 0, updated: 0, failed: 0, skipped: 0 },
        conflicts: { detected: 0, resolved: 0, remaining: 0 },
        duration: 0,
        timestamp: new Date().toISOString()
      };
      
      // Clear previous conflicts for this sync
      this.conflicts.clear();
      
      // Sync local tasks to Monday
      await this._syncLocalToMonday(localTasksMap, mondayTasksMap, results);
      
      // Sync Monday tasks to local
      await this._syncMondayToLocal(mondayTasksMap, localTasksMap, results);
      
      // Auto-resolve conflicts if configured
      if (this.conflictResolution !== CONFLICT_STRATEGIES.MANUAL) {
        await this._autoResolveConflicts(results);
      }
      
      // Update results
      results.conflicts.remaining = this.conflicts.size;
      results.duration = Date.now() - startTime;
      this.lastSyncTime = new Date().toISOString();
      
      log('info', `Sync completed in ${results.duration}ms`, results);
      this.emit('syncCompleted', results);
      
      return results;
      
    } catch (error) {
      log('error', 'Sync failed:', error);
      this.emit('syncError', error);
      throw error;
    }
  }

  /**
   * Sync local tasks to Monday
   * @private
   */
  async _syncLocalToMonday(localTasksMap, mondayTasksMap, results) {
    for (const [taskId, localTask] of localTasksMap) {
      try {
        const mondayTask = mondayTasksMap.get(taskId);
        
        if (mondayTask) {
          // Task exists in both systems - check for conflicts
          if (this._isConflict(localTask, mondayTask)) {
            const conflict = this._createConflict(taskId, localTask, mondayTask);
            this.conflicts.set(taskId, conflict);
            results.conflicts.detected++;
            
            log('debug', `Conflict detected for task ${taskId}`);
            this.emit('conflictDetected', conflict);
            continue;
          }
          
          // Update Monday if local is newer
          if (this._isLocalNewer(localTask, mondayTask)) {
            await this.mondayProvider.updateTask(taskId, {
              ...localTask,
              lastSyncedAt: new Date().toISOString(),
              syncStatus: SYNC_STATUS.SYNCED
            });
            
            // Update local task with sync info
            await this.localProvider.updateTask(taskId, {
              ...localTask,
              lastSyncedAt: new Date().toISOString(),
              syncStatus: SYNC_STATUS.SYNCED
            });
            
            results.localToMonday.updated++;
            log('debug', `Updated Monday task ${taskId} from local`);
          } else {
            results.localToMonday.skipped++;
          }
        } else {
          // Task only exists locally - create in Monday
          const createdTask = await this.mondayProvider.createTask({
            ...localTask,
            lastSyncedAt: new Date().toISOString(),
            syncStatus: SYNC_STATUS.SYNCED
          });
          
          // Update local task with Monday item ID
          await this.localProvider.updateTask(taskId, {
            ...localTask,
            mondayItemId: createdTask.mondayItemId,
            lastSyncedAt: new Date().toISOString(),
            syncStatus: SYNC_STATUS.SYNCED
          });
          
          results.localToMonday.created++;
          log('debug', `Created Monday task ${taskId} from local`);
        }
        
      } catch (error) {
        log('error', `Failed to sync local task ${taskId} to Monday:`, error);
        results.localToMonday.failed++;
        
        // Update sync status to error
        try {
          await this.localProvider.updateTask(taskId, {
            ...localTasksMap.get(taskId),
            syncStatus: SYNC_STATUS.ERROR,
            lastSyncError: error.message
          });
        } catch (updateError) {
          log('error', `Failed to update error status for task ${taskId}:`, updateError);
        }
      }
    }
  }

  /**
   * Sync Monday tasks to local
   * @private
   */
  async _syncMondayToLocal(mondayTasksMap, localTasksMap, results) {
    for (const [taskId, mondayTask] of mondayTasksMap) {
      try {
        const localTask = localTasksMap.get(taskId);
        
        if (!localTask) {
          // Task only exists in Monday - create locally
          const createdTask = await this.localProvider.createTask({
            ...mondayTask,
            lastSyncedAt: new Date().toISOString(),
            syncStatus: SYNC_STATUS.SYNCED
          });
          
          results.mondayToLocal.created++;
          log('debug', `Created local task ${taskId} from Monday`);
        } else {
          // Task exists in both - conflicts already handled in local-to-Monday sync
          if (!this.conflicts.has(taskId)) {
            // Update local if Monday is newer
            if (this._isMondayNewer(localTask, mondayTask)) {
              await this.localProvider.updateTask(taskId, {
                ...mondayTask,
                lastSyncedAt: new Date().toISOString(),
                syncStatus: SYNC_STATUS.SYNCED
              });
              
              results.mondayToLocal.updated++;
              log('debug', `Updated local task ${taskId} from Monday`);
            } else {
              results.mondayToLocal.skipped++;
            }
          }
        }
        
      } catch (error) {
        log('error', `Failed to sync Monday task ${taskId} to local:`, error);
        results.mondayToLocal.failed++;
      }
    }
  }

  /**
   * Check if there's a conflict between local and Monday tasks
   * @private
   */
  _isConflict(localTask, mondayTask) {
    const lastSynced = new Date(localTask.lastSyncedAt || 0);
    const localModified = new Date(localTask.lastModifiedLocal || localTask.updatedAt || 0);
    const mondayModified = new Date(mondayTask.lastModifiedMonday || mondayTask.updatedAt || 0);
    
    // Conflict if both were modified since last sync
    return localModified > lastSynced && mondayModified > lastSynced;
  }

  /**
   * Check if local task is newer than Monday task
   * @private
   */
  _isLocalNewer(localTask, mondayTask) {
    const localModified = new Date(localTask.lastModifiedLocal || localTask.updatedAt || 0);
    const mondayModified = new Date(mondayTask.lastModifiedMonday || mondayTask.updatedAt || 0);
    
    return localModified > mondayModified;
  }

  /**
   * Check if Monday task is newer than local task
   * @private
   */
  _isMondayNewer(localTask, mondayTask) {
    const localModified = new Date(localTask.lastModifiedLocal || localTask.updatedAt || 0);
    const mondayModified = new Date(mondayTask.lastModifiedMonday || mondayTask.updatedAt || 0);
    
    return mondayModified > localModified;
  }

  /**
   * Create a conflict object
   * @private
   */
  _createConflict(taskId, localTask, mondayTask) {
    return {
      id: taskId,
      timestamp: new Date().toISOString(),
      localTask: { ...localTask },
      mondayTask: { ...mondayTask },
      resolution: null,
      resolvedAt: null
    };
  }

  /**
   * Auto-resolve conflicts based on strategy
   * @private
   */
  async _autoResolveConflicts(results) {
    for (const [taskId, conflict] of this.conflicts) {
      try {
        await this.resolveConflict(taskId, this.conflictResolution);
        results.conflicts.resolved++;
      } catch (error) {
        log('error', `Failed to auto-resolve conflict for task ${taskId}:`, error);
      }
    }
  }

  /**
   * Manually resolve a specific conflict
   * @param {string} taskId - Task ID with conflict
   * @param {string} strategy - Resolution strategy
   * @returns {Promise<Object>} Resolved conflict
   */
  async resolveConflict(taskId, strategy) {
    const conflict = this.conflicts.get(taskId);
    if (!conflict) {
      throw new Error(`No conflict found for task ${taskId}`);
    }

    const validStrategies = Object.values(CONFLICT_STRATEGIES);
    if (!validStrategies.includes(strategy)) {
      throw new Error(`Invalid resolution strategy: ${strategy}. Must be one of: ${validStrategies.join(', ')}`);
    }

    let winningTask;
    let losingProvider;
    let winningProvider;

    switch (strategy) {
      case CONFLICT_STRATEGIES.LOCAL_WINS:
        winningTask = conflict.localTask;
        winningProvider = this.localProvider;
        losingProvider = this.mondayProvider;
        break;
        
      case CONFLICT_STRATEGIES.MONDAY_WINS:
        winningTask = conflict.mondayTask;
        winningProvider = this.mondayProvider;
        losingProvider = this.localProvider;
        break;
        
      case CONFLICT_STRATEGIES.NEWEST_WINS:
        const localTime = new Date(conflict.localTask.lastModifiedLocal || conflict.localTask.updatedAt || 0);
        const mondayTime = new Date(conflict.mondayTask.lastModifiedMonday || conflict.mondayTask.updatedAt || 0);
        
        if (localTime >= mondayTime) {
          winningTask = conflict.localTask;
          winningProvider = this.localProvider;
          losingProvider = this.mondayProvider;
        } else {
          winningTask = conflict.mondayTask;
          winningProvider = this.mondayProvider;
          losingProvider = this.localProvider;
        }
        break;
        
      default:
        throw new Error(`Manual resolution not supported by this method. Use resolveConflictManually() instead.`);
    }

    // Update both providers with winning task
    const syncedTask = {
      ...winningTask,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: SYNC_STATUS.SYNCED
    };

    await Promise.all([
      this.localProvider.updateTask(taskId, syncedTask),
      this.mondayProvider.updateTask(taskId, syncedTask)
    ]);

    // Mark conflict as resolved
    conflict.resolution = strategy;
    conflict.resolvedAt = new Date().toISOString();
    
    // Remove from conflicts map
    this.conflicts.delete(taskId);

    log('info', `Resolved conflict for task ${taskId} using strategy: ${strategy}`);
    this.emit('conflictResolved', { taskId, conflict, strategy });

    return conflict;
  }

  /**
   * Get all current conflicts
   * @returns {Array} Array of conflict objects
   */
  getConflicts() {
    return Array.from(this.conflicts.values());
  }

  /**
   * Get sync status for a specific task
   * @param {string} taskId - Task ID
   * @returns {Object} Sync status information
   */
  getSyncStatus(taskId) {
    return this.syncState.get(taskId) || {
      status: SYNC_STATUS.PENDING,
      lastSyncedAt: null,
      lastError: null
    };
  }

  /**
   * Force sync for a specific task
   * @param {string} taskId - Task ID to sync
   * @returns {Promise<Object>} Sync result
   */
  async syncTask(taskId) {
    log('info', `Force syncing task ${taskId}`);
    
    try {
      const [localTask, mondayTask] = await Promise.all([
        this.localProvider.getTask(taskId),
        this.mondayProvider.getTask(taskId)
      ]);

      if (!localTask && !mondayTask) {
        throw new Error(`Task ${taskId} not found in either provider`);
      }

      const result = { taskId, action: null, success: false };

      if (localTask && !mondayTask) {
        // Create in Monday
        await this.mondayProvider.createTask(localTask);
        result.action = 'created-in-monday';
        result.success = true;
      } else if (!localTask && mondayTask) {
        // Create in local
        await this.localProvider.createTask(mondayTask);
        result.action = 'created-in-local';
        result.success = true;
      } else {
        // Both exist - check for conflict
        if (this._isConflict(localTask, mondayTask)) {
          const conflict = this._createConflict(taskId, localTask, mondayTask);
          this.conflicts.set(taskId, conflict);
          result.action = 'conflict-detected';
          result.conflict = conflict;
        } else {
          // Update based on which is newer
          if (this._isLocalNewer(localTask, mondayTask)) {
            await this.mondayProvider.updateTask(taskId, localTask);
            result.action = 'updated-monday-from-local';
          } else {
            await this.localProvider.updateTask(taskId, mondayTask);
            result.action = 'updated-local-from-monday';
          }
          result.success = true;
        }
      }

      log('info', `Task ${taskId} sync result:`, result);
      return result;

    } catch (error) {
      log('error', `Failed to sync task ${taskId}:`, error);
      throw error;
    }
  }

  /**
   * Get sync engine status and statistics
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastSyncTime: this.lastSyncTime,
      conflictCount: this.conflicts.size,
      conflictResolution: this.conflictResolution,
      autoSync: this.autoSync,
      providers: {
        local: this.localProvider?.getProviderInfo() || null,
        monday: this.mondayProvider?.getProviderInfo() || null
      }
    };
  }
}

/**
 * Factory function to create a hybrid sync engine
 * @param {Object} config - Configuration object
 * @param {Object} persistenceManager - Persistence manager instance
 * @returns {HybridSyncEngine} Sync engine instance
 */
export function createHybridSyncEngine(config, persistenceManager) {
  return new HybridSyncEngine(config, persistenceManager);
}

export default HybridSyncEngine; 