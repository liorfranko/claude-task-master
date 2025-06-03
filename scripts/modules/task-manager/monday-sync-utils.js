import { readJSON, writeJSON } from '../utils.js';

/**
 * Extend a task with Monday.com integration fields
 * @param {Object} task - The task object to extend
 * @param {Object} options - Options for extending
 * @param {string} [options.mondayItemId] - Monday.com item ID
 * @param {string} [options.syncStatus] - Sync status ('synced', 'pending', 'error')
 * @param {string} [options.lastSyncedAt] - Last sync timestamp (ISO string)
 * @param {string} [options.syncError] - Error message if sync failed
 * @returns {Object} Extended task object
 */
export function extendTaskWithMondayFields(task, options = {}) {
  return {
    ...task,
    mondayItemId: options.mondayItemId || task.mondayItemId || null,
    lastSyncedAt: options.lastSyncedAt || task.lastSyncedAt || null,
    syncStatus: options.syncStatus || task.syncStatus || 'pending',
    syncError: options.syncError || task.syncError || null
  };
}

/**
 * Mark a task for sync by setting its sync status to 'pending'
 * @param {string} tasksPath - Path to tasks.json file
 * @param {number|string} taskId - Task ID to mark for sync
 * @returns {boolean} Success status
 */
export function markTaskForSync(tasksPath, taskId) {
  try {
    const data = readJSON(tasksPath);
    if (!data || !data.tasks) {
      return false;
    }

    const task = data.tasks.find(t => t.id == taskId);
    if (!task) {
      return false;
    }

    // Extend task with Monday fields and mark as pending sync
    Object.assign(task, extendTaskWithMondayFields(task, { 
      syncStatus: 'pending',
      syncError: null // Clear any previous errors
    }));

    writeJSON(tasksPath, data);
    return true;
  } catch (error) {
    console.error('Error marking task for sync:', error);
    return false;
  }
}

/**
 * Update a task's sync status after sync operation
 * @param {string} tasksPath - Path to tasks.json file
 * @param {number|string} taskId - Task ID to update
 * @param {string} mondayItemId - Monday.com item ID
 * @param {string} status - Sync status ('synced', 'pending', 'error')
 * @param {string|null} error - Error message if sync failed
 * @returns {boolean} Success status
 */
export function updateTaskSyncStatus(tasksPath, taskId, mondayItemId, status = 'synced', error = null) {
  try {
    const data = readJSON(tasksPath);
    if (!data || !data.tasks) {
      return false;
    }

    const task = data.tasks.find(t => t.id == taskId);
    if (!task) {
      return false;
    }

    // Update sync fields
    Object.assign(task, extendTaskWithMondayFields(task, {
      mondayItemId: mondayItemId,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: status,
      syncError: error
    }));

    writeJSON(tasksPath, data);
    return true;
  } catch (error) {
    console.error('Error updating task sync status:', error);
    return false;
  }
}

/**
 * Mark a subtask for sync by setting its sync status to 'pending'
 * @param {string} tasksPath - Path to tasks.json file
 * @param {string} subtaskId - Subtask ID in format "parentId.subtaskId"
 * @returns {boolean} Success status
 */
export function markSubtaskForSync(tasksPath, subtaskId) {
  try {
    const data = readJSON(tasksPath);
    if (!data || !data.tasks) {
      return false;
    }

    const [parentId, subId] = subtaskId.split('.');
    const parentTask = data.tasks.find(t => t.id == parentId);
    if (!parentTask || !parentTask.subtasks) {
      return false;
    }

    const subtask = parentTask.subtasks.find(st => st.id == subId);
    if (!subtask) {
      return false;
    }

    // Extend subtask with Monday fields and mark as pending sync
    Object.assign(subtask, extendTaskWithMondayFields(subtask, { 
      syncStatus: 'pending',
      syncError: null // Clear any previous errors
    }));

    writeJSON(tasksPath, data);
    return true;
  } catch (error) {
    console.error('Error marking subtask for sync:', error);
    return false;
  }
}

/**
 * Update a subtask's sync status after sync operation
 * @param {string} tasksPath - Path to tasks.json file
 * @param {string} subtaskId - Subtask ID in format "parentId.subtaskId"
 * @param {string} mondayItemId - Monday.com item ID
 * @param {string} status - Sync status ('synced', 'pending', 'error')
 * @param {string|null} error - Error message if sync failed
 * @returns {boolean} Success status
 */
export function updateSubtaskSyncStatus(tasksPath, subtaskId, mondayItemId, status = 'synced', error = null) {
  try {
    const data = readJSON(tasksPath);
    if (!data || !data.tasks) {
      return false;
    }

    const [parentId, subId] = subtaskId.split('.');
    const parentTask = data.tasks.find(t => t.id == parentId);
    if (!parentTask || !parentTask.subtasks) {
      return false;
    }

    const subtask = parentTask.subtasks.find(st => st.id == subId);
    if (!subtask) {
      return false;
    }

    // Update sync fields
    Object.assign(subtask, extendTaskWithMondayFields(subtask, {
      mondayItemId: mondayItemId,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: status,
      syncError: error
    }));

    writeJSON(tasksPath, data);
    return true;
  } catch (error) {
    console.error('Error updating subtask sync status:', error);
    return false;
  }
}

/**
 * Get all tasks that need syncing (have syncStatus 'pending' or 'error')
 * @param {string} tasksPath - Path to tasks.json file
 * @returns {Array} Array of tasks that need syncing
 */
  export function getTasksNeedingSync(tasksPath) {
  try {
    const data = readJSON(tasksPath);
    if (!data || !data.tasks) {
      return [];
    }

    const needsSync = [];

    // Check main tasks
    data.tasks.forEach(task => {
      if (task.syncStatus === 'pending' || task.syncStatus === 'error') {
        needsSync.push({
          type: 'task',
          id: task.id,
          task: task
        });
      }

      // Check subtasks
      if (task.subtasks) {
        task.subtasks.forEach(subtask => {
          if (subtask.syncStatus === 'pending' || subtask.syncStatus === 'error') {
            needsSync.push({
              type: 'subtask',
              id: `${task.id}.${subtask.id}`,
              task: subtask,
              parentTask: task
            });
          }
        });
      }
    });

    return needsSync;
  } catch (error) {
    console.error('Error getting tasks needing sync:', error);
    return [];
  }
}

/**
 * Initialize Monday.com fields for all existing tasks
 * @param {string} tasksPath - Path to tasks.json file
 * @returns {Object} Result with success status and count of updated tasks
 */
export function initializeMondayFieldsForAllTasks(tasksPath) {
  try {
    const data = readJSON(tasksPath);
    if (!data || !data.tasks) {
      return { success: false, error: 'No tasks found' };
    }

    let updatedCount = 0;

    // Initialize main tasks
    data.tasks.forEach(task => {
      if (!task.hasOwnProperty('mondayItemId')) {
        Object.assign(task, extendTaskWithMondayFields(task));
        updatedCount++;
      }

      // Initialize subtasks
      if (task.subtasks) {
        task.subtasks.forEach(subtask => {
          if (!subtask.hasOwnProperty('mondayItemId')) {
            Object.assign(subtask, extendTaskWithMondayFields(subtask));
            updatedCount++;
          }
        });
      }
    });

    if (updatedCount > 0) {
      writeJSON(tasksPath, data);
    }

    return { 
      success: true, 
      updatedCount,
      message: `Initialized Monday.com fields for ${updatedCount} tasks/subtasks`
    };
  } catch (error) {
    console.error('Error initializing Monday fields:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
} 