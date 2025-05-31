/**
 * monday-status-manager.js
 * Comprehensive Monday.com Status Management System
 * 
 * This module provides advanced status management capabilities that integrate with 
 * Monday.com's status columns, group management, and webhook notifications while 
 * maintaining backward compatibility with local persistence.
 */

import { log } from './utils.js';
import { mondayPersistence, updateTaskStatus as mondayUpdateTaskStatus } from './monday-persistence.js';
import { persistenceManager } from './persistence-manager.js';
import { getPersistenceMode, getMondayEnabled } from './monday-config-manager.js';
import { validateTaskDependencies } from './dependency-manager.js';
import { isValidTaskStatus, TASK_STATUS_OPTIONS } from '../../src/constants/task-status.js';

// Import the new dedicated mapping module
import { 
  statusMappingManager,
  mapTaskStatusToMonday,
  mapMondayStatusToTask,
  validateStatusTransition as validateMappingTransition,
  getGroupForStatus,
  getPriorityForStatus,
  getMappingTelemetry
} from './monday-status-mapping.js';

/**
 * Status mapping between Task Master and Monday.com
 */
export const STATUS_MAPPING = {
  // Task Master -> Monday.com
  TASK_TO_MONDAY: {
    'pending': 'pending',
    'in-progress': 'working_on_it',
    'done': 'done',
    'review': 'review',
    'blocked': 'stuck',
    'deferred': 'stuck',
    'cancelled': 'cancelled'
  },
  
  // Monday.com -> Task Master
  MONDAY_TO_TASK: {
    'pending': 'pending',
    'working_on_it': 'in-progress',
    'done': 'done',
    'review': 'review',
    'stuck': 'blocked',
    'cancelled': 'cancelled'
  }
};

/**
 * Group mapping for Monday.com board organization
 */
export const GROUP_MAPPING = {
  'pending': 'topics',           // New tasks group
  'in-progress': 'topics',       // Active work group  
  'review': 'topics',            // Review group
  'done': 'done',                // Completed tasks group
  'blocked': 'blocked',          // Blocked/stuck tasks group
  'deferred': 'blocked',         // Deferred tasks (also blocked)
  'cancelled': 'cancelled'       // Cancelled tasks group
};

/**
 * Status transition rules and validations
 */
export const STATUS_TRANSITIONS = {
  'pending': ['in-progress', 'blocked', 'cancelled'],
  'in-progress': ['done', 'review', 'blocked', 'cancelled'],
  'review': ['done', 'in-progress', 'blocked'],
  'done': ['review'], // Allow reopening for fixes
  'blocked': ['pending', 'in-progress', 'cancelled'],
  'deferred': ['pending', 'cancelled'],
  'cancelled': [] // Terminal state
};

/**
 * Monday.com Status Manager Class
 */
export class MondayStatusManager {
  constructor() {
    this.initialized = false;
    this.optimisticUpdates = new Map(); // Track optimistic UI updates
    this.pendingUpdates = new Map();    // Track pending API updates
    this.statusCache = new Map();       // Cache status for performance
    this.telemetry = {
      statusUpdates: 0,
      groupMoves: 0,
      webhookTriggers: 0,
      optimisticUpdates: 0,
      rollbacks: 0,
      errors: 0
    };
  }

  /**
   * Initialize the status manager
   * @param {string} projectRoot - Project root directory
   * @param {Object} session - Session object for MCP mode
   */
  async initialize(projectRoot = null, session = null) {
    try {
      // Initialize persistence manager first
      await persistenceManager.initialize(projectRoot, session);
      
      // If Monday.com mode, initialize Monday persistence
      const mode = getPersistenceMode(projectRoot);
      if (mode === 'monday' || mode === 'hybrid') {
        if (getMondayEnabled(projectRoot)) {
          await mondayPersistence.initialize();
        }
      }
      
      this.initialized = true;
      log('Monday.com Status Manager initialized successfully', 'info');
      
      return { success: true, mode };
    } catch (error) {
      log(`Status Manager initialization failed: ${error.message}`, 'error');
      throw new Error(`Status Manager initialization failed: ${error.message}`);
    }
  }

  /**
   * Update task status with advanced features
   * @param {string|number} taskId - Task ID to update
   * @param {string} newStatus - New status value
   * @param {Object} options - Update options
   * @returns {Object} Update result
   */
  async updateTaskStatus(taskId, newStatus, options = {}) {
    const {
      optimistic = true,
      validateTransition = true,
      updateDependencies = true,
      triggerWebhooks = true,
      moveToGroup = true,
      projectRoot = null,
      session = null
    } = options;

    // Ensure initialization
    if (!this.initialized) {
      await this.initialize(projectRoot, session);
    }

    try {
      // Validate status value
      if (!isValidTaskStatus(newStatus)) {
        throw new Error(`Invalid status: ${newStatus}. Valid options: ${TASK_STATUS_OPTIONS.join(', ')}`);
      }

      // Get current status for validation and rollback
      const currentStatus = await this.getCurrentStatus(taskId, { projectRoot, session });
      
      // Validate status transition if enabled using the mapping module
      if (validateTransition && currentStatus) {
        const transitionValidation = validateMappingTransition(currentStatus, newStatus, { strict: true });
        if (!transitionValidation.valid) {
          throw new Error(`Invalid status transition: ${transitionValidation.reason}`);
        }
      }

      // Apply optimistic update if enabled
      if (optimistic) {
        this.applyOptimisticUpdate(taskId, newStatus);
      }

      // Determine persistence mode and update accordingly
      const mode = persistenceManager.getStatus().mode;
      let updateResult;

      if (mode === 'monday' || mode === 'hybrid') {
        // Use Monday.com status update with advanced features
        updateResult = await this.updateMondayStatus(taskId, newStatus, {
          moveToGroup,
          triggerWebhooks,
          currentStatus
        });
      } else {
        // Use local persistence update
        updateResult = await this.updateLocalStatus(taskId, newStatus, { projectRoot, session });
      }

      // Update dependencies if enabled
      if (updateDependencies) {
        await this.updateDependentTasks(taskId, newStatus, { projectRoot, session });
      }

      // Clear optimistic update
      if (optimistic) {
        this.clearOptimisticUpdate(taskId);
      }

      // Update telemetry
      this.telemetry.statusUpdates++;
      if (moveToGroup && (mode === 'monday' || mode === 'hybrid')) {
        this.telemetry.groupMoves++;
      }
      if (triggerWebhooks && (mode === 'monday' || mode === 'hybrid')) {
        this.telemetry.webhookTriggers++;
      }

      log(`Successfully updated task ${taskId} status from ${currentStatus} to ${newStatus}`, 'info');

      return {
        success: true,
        taskId,
        oldStatus: currentStatus,
        newStatus,
        mode,
        updatedAt: new Date().toISOString(),
        mappingInfo: mode === 'monday' || mode === 'hybrid' 
          ? mapTaskStatusToMonday(newStatus)
          : null,
        ...updateResult
      };

    } catch (error) {
      // Rollback optimistic update on error
      if (optimistic) {
        this.rollbackOptimisticUpdate(taskId);
      }

      this.telemetry.errors++;
      log(`Failed to update task ${taskId} status: ${error.message}`, 'error');
      throw new Error(`Status update failed: ${error.message}`);
    }
  }

  /**
   * Update status using Monday.com persistence
   * @private
   */
  async updateMondayStatus(taskId, newStatus, options = {}) {
    const { moveToGroup = true, triggerWebhooks = true, currentStatus } = options;

    try {
      // Use the mapping module to get Monday.com status
      const mappingResult = mapTaskStatusToMonday(newStatus, { validateInput: true });
      
      if (!mappingResult.success) {
        throw new Error(`Status mapping failed: ${mappingResult.error}`);
      }
      
      const mondayStatus = mappingResult.mondayStatus;
      
      // Update the status in Monday.com
      const mondayResult = await mondayUpdateTaskStatus(taskId, mondayStatus);
      
      // Additional Monday.com specific operations
      if (moveToGroup) {
        const targetGroup = getGroupForStatus(newStatus);
        log(`Moving task ${taskId} to group: ${targetGroup}`, 'debug');
        
        // The Monday persistence layer handles group movement automatically
        // but we track it for telemetry
      }

      return {
        mondayItemId: mondayResult.mondayItemId,
        mondayStatus,
        mappingResult,
        groupMoved: moveToGroup,
        targetGroup: moveToGroup ? getGroupForStatus(newStatus) : null
      };

    } catch (error) {
      throw new Error(`Monday.com status update failed: ${error.message}`);
    }
  }

  /**
   * Update status using local persistence
   * @private
   */
  async updateLocalStatus(taskId, newStatus, options = {}) {
    const { projectRoot, session } = options;

    try {
      // This will be handled by the existing persistence manager
      // through the regular task update mechanisms
      log(`Updating task ${taskId} status locally to ${newStatus}`, 'debug');
      
      return {
        localUpdate: true,
        persistenceMode: 'local'
      };

    } catch (error) {
      throw new Error(`Local status update failed: ${error.message}`);
    }
  }

  /**
   * Get current status for a task
   * @param {string|number} taskId - Task ID
   * @param {Object} options - Options
   * @returns {string|null} Current status
   */
  async getCurrentStatus(taskId, options = {}) {
    const { projectRoot, session, useCache = true } = options;

    try {
      // Check cache first
      if (useCache && this.statusCache.has(taskId)) {
        return this.statusCache.get(taskId);
      }

      // Get current task data
      const mode = persistenceManager.getStatus().mode;
      let currentStatus = null;

      if (mode === 'monday' || mode === 'hybrid') {
        // Use Monday.com persistence to get current status
        const tasks = await mondayPersistence.loadTasks();
        const task = tasks.tasks?.find(t => t.id.toString() === taskId.toString());
        
        if (task?.status) {
          // Map Monday.com status back to Task Master status if needed
          const mappingResult = mapMondayStatusToTask(task.status);
          currentStatus = mappingResult.success ? mappingResult.taskStatus : task.status;
        }
      } else {
        // Use local persistence through persistence manager
        // This would require a read operation through the persistence manager
        // For now, we'll indicate local mode
        currentStatus = 'pending'; // Default fallback
      }

      // Cache the result
      if (currentStatus && useCache) {
        this.statusCache.set(taskId, currentStatus);
      }

      return currentStatus;

    } catch (error) {
      log(`Failed to get current status for task ${taskId}: ${error.message}`, 'warn');
      return null;
    }
  }

  /**
   * Validate status transition
   * @param {string} currentStatus - Current status
   * @param {string} newStatus - Proposed new status
   * @returns {Object} Validation result
   */
  validateStatusTransition(currentStatus, newStatus) {
    return validateMappingTransition(currentStatus, newStatus, { strict: true });
  }

  /**
   * Apply optimistic update for immediate UI feedback
   * @param {string|number} taskId - Task ID
   * @param {string} newStatus - New status
   */
  applyOptimisticUpdate(taskId, newStatus) {
    this.optimisticUpdates.set(taskId, {
      status: newStatus,
      timestamp: Date.now()
    });
    this.telemetry.optimisticUpdates++;
    log(`Applied optimistic update for task ${taskId}: ${newStatus}`, 'debug');
  }

  /**
   * Clear optimistic update
   * @param {string|number} taskId - Task ID
   */
  clearOptimisticUpdate(taskId) {
    this.optimisticUpdates.delete(taskId);
  }

  /**
   * Rollback optimistic update
   * @param {string|number} taskId - Task ID
   */
  rollbackOptimisticUpdate(taskId) {
    this.optimisticUpdates.delete(taskId);
    this.telemetry.rollbacks++;
    log(`Rolled back optimistic update for task ${taskId}`, 'debug');
  }

  /**
   * Update dependent tasks based on status change
   * @param {string|number} taskId - Task ID that changed
   * @param {string} newStatus - New status
   * @param {Object} options - Options
   */
  async updateDependentTasks(taskId, newStatus, options = {}) {
    try {
      // This would integrate with the dependency manager
      // to check if any dependent tasks need status updates
      
      // For example, if a task is marked 'done', 
      // dependent tasks might be automatically moved to 'pending'
      
      log(`Checking dependent tasks for ${taskId} status change to ${newStatus}`, 'debug');
      
      // Implementation would be added here based on dependency manager integration
      
    } catch (error) {
      log(`Failed to update dependent tasks for ${taskId}: ${error.message}`, 'warn');
      // Don't throw error - dependent task updates are not critical
    }
  }

  /**
   * Map Task Master status to Monday.com status
   * @param {string} taskStatus - Task Master status
   * @returns {string} Monday.com status
   */
  mapTaskStatusToMonday(taskStatus) {
    const result = mapTaskStatusToMonday(taskStatus);
    return result.success ? result.mondayStatus : taskStatus;
  }

  /**
   * Map Monday.com status to Task Master status
   * @param {string} mondayStatus - Monday.com status
   * @returns {string} Task Master status
   */
  mapMondayStatusToTask(mondayStatus) {
    const result = mapMondayStatusToTask(mondayStatus);
    return result.success ? result.taskStatus : mondayStatus;
  }

  /**
   * Get Monday.com group for status
   * @param {string} status - Task Master status
   * @returns {string} Monday.com group
   */
  getGroupForStatus(status) {
    return getGroupForStatus(status);
  }

  /**
   * Get priority information for status
   * @param {string} status - Task Master status
   * @returns {Object} Priority information
   */
  getPriorityForStatus(status) {
    return getPriorityForStatus(status);
  }

  /**
   * Get status manager telemetry
   * @returns {Object} Telemetry data
   */
  getTelemetry() {
    return {
      ...this.telemetry,
      optimisticUpdatesActive: this.optimisticUpdates.size,
      pendingUpdatesActive: this.pendingUpdates.size,
      cachedStatuses: this.statusCache.size,
      initialized: this.initialized,
      mappingTelemetry: getMappingTelemetry()
    };
  }

  /**
   * Clear all caches and reset state
   */
  reset() {
    this.optimisticUpdates.clear();
    this.pendingUpdates.clear();
    this.statusCache.clear();
    this.telemetry = {
      statusUpdates: 0,
      groupMoves: 0,
      webhookTriggers: 0,
      optimisticUpdates: 0,
      rollbacks: 0,
      errors: 0
    };
    log('Status Manager reset completed', 'info');
  }
}

// Export singleton instance
export const mondayStatusManager = new MondayStatusManager();

// Export convenient wrapper functions
export async function updateTaskStatus(taskId, newStatus, options = {}) {
  return await mondayStatusManager.updateTaskStatus(taskId, newStatus, options);
}

export async function getCurrentTaskStatus(taskId, options = {}) {
  return await mondayStatusManager.getCurrentStatus(taskId, options);
}

export function validateStatusTransition(currentStatus, newStatus) {
  return mondayStatusManager.validateStatusTransition(currentStatus, newStatus);
}

export function getStatusTelemetry() {
  return mondayStatusManager.getTelemetry();
}

// Re-export mapping functions for convenience
export {
  mapTaskStatusToMonday,
  mapMondayStatusToTask,
  getGroupForStatus,
  getPriorityForStatus,
  TASK_STATUS_OPTIONS
} from './monday-status-mapping.js'; 