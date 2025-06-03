/**
 * auto-sync-hooks.js
 * Automatic sync hooks for Monday.com integration
 * 
 * This module provides sync hooks that are called after task operations
 * to automatically synchronize with Monday.com when in hybrid mode.
 */

import { MondaySyncEngine } from '../monday-sync.js';
import { getPersistenceMode, getHybridAutoSync } from '../config-manager.js';
import { log } from '../utils.js';

/**
 * Check if auto-sync is enabled for the current persistence mode
 * @param {string} projectRoot - Project root directory
 * @param {Object} session - Optional session context for MCP
 * @returns {boolean} True if auto-sync should be performed
 */
function isAutoSyncEnabled(projectRoot, session = null) {
  try {
    const mode = getPersistenceMode(projectRoot, session);
    const autoSync = getHybridAutoSync(projectRoot);
    
    // Auto-sync is enabled when in hybrid mode AND the hybrid auto-sync setting is true
    return mode === 'hybrid' && autoSync === true;
  } catch (error) {
    log('debug', 'Error checking auto-sync status:', error.message);
    return false;
  }
}

/**
 * Create Monday sync engine instance if auto-sync is enabled
 * @param {string} projectRoot - Project root directory
 * @param {Object} session - Optional session context for MCP
 * @returns {MondaySyncEngine|null} Sync engine instance or null if disabled
 */
function createSyncEngine(projectRoot, session = null) {
  if (!isAutoSyncEnabled(projectRoot, session)) {
    return null;
  }

  try {
    return new MondaySyncEngine(projectRoot, session);
  } catch (error) {
    log('warn', 'Could not create Monday sync engine:', error.message);
    return null;
  }
}

/**
 * Sync hook for task creation - pushes new task to Monday.com
 * @param {string} projectRoot - Project root directory
 * @param {Object} task - The created task object
 * @param {Object} options - Options object
 * @param {Object} options.session - Optional session context for MCP
 * @param {Function} options.mcpLog - Optional MCP logger
 * @param {boolean} options.throwOnError - Whether to throw errors (default: false)
 * @returns {Promise<boolean>} True if sync succeeded, false otherwise
 */
export async function onTaskCreated(projectRoot, task, options = {}) {
  const { session, mcpLog, throwOnError = false } = options;
  const syncEngine = createSyncEngine(projectRoot, session);
  
  if (!syncEngine) {
    log('debug', 'Auto-sync disabled, skipping task creation sync');
    return true;
  }

  try {
    log('info', `Auto-syncing new task ${task.id} to Monday.com...`);
    
    // Use the correct method and pass the tasks file path
    const tasksPath = `${projectRoot}/.taskmaster/tasks/tasks.json`;
    const result = await syncEngine.syncTask(task, tasksPath, task.id);
    
    if (result.success) {
      log('info', `✅ Task ${task.id} successfully synced to Monday.com`);
      return true;
    } else {
      log('warn', `⚠️ Failed to sync task ${task.id} to Monday.com: ${result.error || 'Unknown error'}`);
      if (throwOnError) {
        throw new Error(`Failed to sync task to Monday.com: ${result.error || 'Unknown error'}`);
      }
      return false;
    }
  } catch (error) {
    log('error', `Error auto-syncing task ${task.id}:`, error.message);
    if (throwOnError) {
      throw new Error(`Auto-sync failed: ${error.message}`);
    }
    return false;
  }
}

/**
 * Sync hook for task updates - pushes updated task to Monday.com
 * @param {string} projectRoot - Project root directory
 * @param {Object} task - The updated task object
 * @param {Object} options - Options object
 * @param {Object} options.session - Optional session context for MCP
 * @param {Function} options.mcpLog - Optional MCP logger
 * @param {boolean} options.throwOnError - Whether to throw errors (default: false)
 * @returns {Promise<boolean>} True if sync succeeded, false otherwise
 */
export async function onTaskUpdated(projectRoot, task, options = {}) {
  const { session, mcpLog, throwOnError = false } = options;
  const syncEngine = createSyncEngine(projectRoot, session);
  
  if (!syncEngine) {
    log('debug', 'Auto-sync disabled, skipping task update sync');
    return true;
  }

  try {
    log('info', `Auto-syncing updated task ${task.id} to Monday.com...`);
    
    // Use the correct method and pass the tasks file path
    const tasksPath = `${projectRoot}/.taskmaster/tasks/tasks.json`;
    const result = await syncEngine.syncTask(task, tasksPath, task.id);
    
    if (result.success) {
      log('info', `✅ Task ${task.id} changes successfully synced to Monday.com`);
      return true;
    } else {
      log('warn', `⚠️ Failed to sync task ${task.id} changes to Monday.com: ${result.error || 'Unknown error'}`);
      if (throwOnError) {
        throw new Error(`Failed to sync task changes to Monday.com: ${result.error || 'Unknown error'}`);
      }
      return false;
    }
  } catch (error) {
    log('error', `Error auto-syncing task ${task.id} changes:`, error.message);
    if (throwOnError) {
      throw new Error(`Auto-sync failed: ${error.message}`);
    }
    return false;
  }
}

/**
 * Sync hook for task status changes - updates status in Monday.com
 * @param {string} projectRoot - Project root directory
 * @param {Object} task - The task object with updated status
 * @param {string} oldStatus - The previous status
 * @param {Object} options - Options object
 * @param {Object} options.session - Optional session context for MCP
 * @param {Function} options.mcpLog - Optional MCP logger
 * @param {boolean} options.throwOnError - Whether to throw errors (default: false)
 * @returns {Promise<boolean>} True if sync succeeded, false otherwise
 */
export async function onTaskStatusChanged(projectRoot, task, oldStatus, options = {}) {
  const { session, mcpLog, throwOnError = false } = options;
  const syncEngine = createSyncEngine(projectRoot, session);
  
  if (!syncEngine) {
    log('debug', 'Auto-sync disabled, skipping task status sync');
    return true;
  }

  try {
    log('info', `Auto-syncing status change for task ${task.id} from '${oldStatus}' to '${task.status}' to Monday.com...`);
    
    // Use the correct method and pass the tasks file path
    const tasksPath = `${projectRoot}/.taskmaster/tasks/tasks.json`;
    const result = await syncEngine.syncTask(task, tasksPath, task.id);
    
    if (result.success) {
      log('info', `✅ Task ${task.id} status change successfully synced to Monday.com`);
      return true;
    } else {
      log('warn', `⚠️ Failed to sync task ${task.id} status change to Monday.com: ${result.error || 'Unknown error'}`);
      if (throwOnError) {
        throw new Error(`Failed to sync task status to Monday.com: ${result.error || 'Unknown error'}`);
      }
      return false;
    }
  } catch (error) {
    log('error', `Error auto-syncing task ${task.id} status change:`, error.message);
    if (throwOnError) {
      throw new Error(`Auto-sync failed: ${error.message}`);
    }
    return false;
  }
}

/**
 * Sync hook for task deletion - removes task from Monday.com
 * @param {string} projectRoot - Project root directory
 * @param {Object} task - The task object being deleted
 * @param {Object} options - Options object
 * @param {Object} options.session - Optional session context for MCP
 * @param {Function} options.mcpLog - Optional MCP logger
 * @param {boolean} options.throwOnError - Whether to throw errors (default: false)
 * @returns {Promise<boolean>} True if sync succeeded, false otherwise
 */
export async function onTaskDeleted(projectRoot, task, options = {}) {
  const { session, mcpLog, throwOnError = false } = options;
  const syncEngine = createSyncEngine(projectRoot, session);
  
  if (!syncEngine) {
    log('debug', 'Auto-sync disabled, skipping task deletion sync');
    return true;
  }

  // Only attempt deletion if task has a Monday item ID
  if (!task.mondayItemId) {
    log('debug', `Task ${task.id} has no Monday item ID, skipping deletion sync`);
    return true;
  }

  try {
    log('info', `Auto-syncing task ${task.id} deletion to Monday.com...`);
    
    // Use the Monday client directly to delete the item
    const result = await syncEngine.client.deleteItem(task.mondayItemId);
    
    if (result.success) {
      log('info', `✅ Task ${task.id} successfully deleted from Monday.com`);
      return true;
    } else {
      log('warn', `⚠️ Failed to delete task ${task.id} from Monday.com: ${result.error || 'Unknown error'}`);
      if (throwOnError) {
        throw new Error(`Failed to delete task from Monday.com: ${result.error || 'Unknown error'}`);
      }
      return false;
    }
  } catch (error) {
    log('error', `Error auto-syncing task ${task.id} deletion:`, error.message);
    if (throwOnError) {
      throw new Error(`Auto-sync failed: ${error.message}`);
    }
    return false;
  }
}

/**
 * Sync hook for subtask creation - pushes new subtask to Monday.com
 * @param {string} projectRoot - Project root directory
 * @param {Object} parentTask - The parent task object
 * @param {Object} subtask - The created subtask object
 * @param {Object} options - Options object
 * @param {Object} options.session - Optional session context for MCP
 * @param {Function} options.mcpLog - Optional MCP logger
 * @param {boolean} options.throwOnError - Whether to throw errors (default: false)
 * @returns {Promise<boolean>} True if sync succeeded, false otherwise
 */
export async function onSubtaskCreated(projectRoot, parentTask, subtask, options = {}) {
  const { session, mcpLog, throwOnError = false } = options;
  const syncEngine = createSyncEngine(projectRoot, session);
  
  if (!syncEngine) {
    log('debug', 'Auto-sync disabled, skipping subtask creation sync');
    return true;
  }

  try {
    log('info', `Auto-syncing new subtask ${parentTask.id}.${subtask.id} to Monday.com...`);
    
    // Use the correct method and pass the tasks file path
    const tasksPath = `${projectRoot}/.taskmaster/tasks/tasks.json`;
    const result = await syncEngine.syncSubtask(subtask, parentTask, tasksPath, subtask.id);
    
    if (result.success) {
      log('info', `✅ Subtask ${parentTask.id}.${subtask.id} successfully synced to Monday.com`);
      return true;
    } else {
      log('warn', `⚠️ Failed to sync subtask ${parentTask.id}.${subtask.id} to Monday.com: ${result.error || 'Unknown error'}`);
      if (throwOnError) {
        throw new Error(`Failed to sync subtask to Monday.com: ${result.error || 'Unknown error'}`);
      }
      return false;
    }
  } catch (error) {
    log('error', `Error auto-syncing subtask ${parentTask.id}.${subtask.id}:`, error.message);
    if (throwOnError) {
      throw new Error(`Auto-sync failed: ${error.message}`);
    }
    return false;
  }
}

/**
 * Sync hook for subtask updates - pushes updated subtask to Monday.com
 * @param {string} projectRoot - Project root directory
 * @param {Object} parentTask - The parent task object
 * @param {Object} subtask - The updated subtask object
 * @param {Object} options - Options object
 * @param {Object} options.session - Optional session context for MCP
 * @param {Function} options.mcpLog - Optional MCP logger
 * @param {boolean} options.throwOnError - Whether to throw errors (default: false)
 * @returns {Promise<boolean>} True if sync succeeded, false otherwise
 */
export async function onSubtaskUpdated(projectRoot, parentTask, subtask, options = {}) {
  const { session, mcpLog, throwOnError = false } = options;
  const syncEngine = createSyncEngine(projectRoot, session);
  
  if (!syncEngine) {
    log('debug', 'Auto-sync disabled, skipping subtask update sync');
    return true;
  }

  try {
    log('info', `Auto-syncing updated subtask ${parentTask.id}.${subtask.id} to Monday.com...`);
    
    // Use the correct method and pass the tasks file path
    const tasksPath = `${projectRoot}/.taskmaster/tasks/tasks.json`;
    const result = await syncEngine.syncSubtask(subtask, parentTask, tasksPath, subtask.id);
    
    if (result.success) {
      log('info', `✅ Subtask ${parentTask.id}.${subtask.id} changes successfully synced to Monday.com`);
      return true;
    } else {
      log('warn', `⚠️ Failed to sync subtask ${parentTask.id}.${subtask.id} changes to Monday.com: ${result.error || 'Unknown error'}`);
      if (throwOnError) {
        throw new Error(`Failed to sync subtask changes to Monday.com: ${result.error || 'Unknown error'}`);
      }
      return false;
    }
  } catch (error) {
    log('error', `Error auto-syncing subtask ${parentTask.id}.${subtask.id} changes:`, error.message);
    if (throwOnError) {
      throw new Error(`Auto-sync failed: ${error.message}`);
    }
    return false;
  }
}

/**
 * Sync hook for subtask deletion - removes subtask from Monday.com
 * @param {string} projectRoot - Project root directory
 * @param {Object} parentTask - The parent task object
 * @param {Object} subtask - The subtask object being deleted
 * @param {Object} options - Options object
 * @param {Object} options.session - Optional session context for MCP
 * @param {Function} options.mcpLog - Optional MCP logger
 * @param {boolean} options.throwOnError - Whether to throw errors (default: false)
 * @returns {Promise<boolean>} True if sync succeeded, false otherwise
 */
export async function onSubtaskDeleted(projectRoot, parentTask, subtask, options = {}) {
  const { session, mcpLog, throwOnError = false } = options;
  const syncEngine = createSyncEngine(projectRoot, session);
  
  if (!syncEngine) {
    log('debug', 'Auto-sync disabled, skipping subtask deletion sync');
    return true;
  }

  // Only attempt deletion if subtask has a Monday item ID
  if (!subtask.mondayItemId) {
    log('debug', `Subtask ${parentTask.id}.${subtask.id} has no Monday item ID, skipping deletion sync`);
    return true;
  }

  try {
    log('info', `Auto-syncing subtask ${parentTask.id}.${subtask.id} deletion to Monday.com...`);
    
    // Use the Monday client directly to delete the item
    const result = await syncEngine.client.deleteItem(subtask.mondayItemId);
    
    if (result.success) {
      log('info', `✅ Subtask ${parentTask.id}.${subtask.id} successfully deleted from Monday.com`);
      return true;
    } else {
      log('warn', `⚠️ Failed to delete subtask ${parentTask.id}.${subtask.id} from Monday.com: ${result.error || 'Unknown error'}`);
      if (throwOnError) {
        throw new Error(`Failed to delete subtask from Monday.com: ${result.error || 'Unknown error'}`);
      }
      return false;
    }
  } catch (error) {
    log('error', `Error auto-syncing subtask ${parentTask.id}.${subtask.id} deletion:`, error.message);
    if (throwOnError) {
      throw new Error(`Auto-sync failed: ${error.message}`);
    }
    return false;
  }
}

/**
 * Sync hook for subtask status changes - updates subtask status in Monday.com
 * @param {string} projectRoot - Project root directory
 * @param {Object} parentTask - The parent task object
 * @param {Object} subtask - The subtask object with updated status
 * @param {string} oldStatus - The previous status
 * @param {Object} options - Options object
 * @param {Object} options.session - Optional session context for MCP
 * @param {Function} options.mcpLog - Optional MCP logger
 * @param {boolean} options.throwOnError - Whether to throw errors (default: false)
 * @returns {Promise<boolean>} True if sync succeeded, false otherwise
 */
export async function onSubtaskStatusChanged(projectRoot, parentTask, subtask, oldStatus, options = {}) {
  const { session, mcpLog, throwOnError = false } = options;
  const syncEngine = createSyncEngine(projectRoot, session);
  
  if (!syncEngine) {
    log('debug', 'Auto-sync disabled, skipping subtask status sync');
    return true;
  }

  try {
    log('info', `Auto-syncing status change for subtask ${parentTask.id}.${subtask.id} from '${oldStatus}' to '${subtask.status}' to Monday.com...`);
    
    // Use the correct method and pass the tasks file path
    const tasksPath = `${projectRoot}/.taskmaster/tasks/tasks.json`;
    const result = await syncEngine.syncSubtask(subtask, parentTask, tasksPath, subtask.id);
    
    if (result.success) {
      log('info', `✅ Subtask ${parentTask.id}.${subtask.id} status change successfully synced to Monday.com`);
      return true;
    } else {
      log('warn', `⚠️ Failed to sync subtask ${parentTask.id}.${subtask.id} status change to Monday.com: ${result.error || 'Unknown error'}`);
      if (throwOnError) {
        throw new Error(`Failed to sync subtask status to Monday.com: ${result.error || 'Unknown error'}`);
      }
      return false;
    }
  } catch (error) {
    log('error', `Error auto-syncing subtask ${parentTask.id}.${subtask.id} status change:`, error.message);
    if (throwOnError) {
      throw new Error(`Auto-sync failed: ${error.message}`);
    }
    return false;
  }
} 