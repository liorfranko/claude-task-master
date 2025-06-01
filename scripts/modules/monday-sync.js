import { MondayClient } from './monday-client.js';
import { getMondayApiToken, getMondayIntegrationConfig } from './config-manager.js';
import { 
  updateTaskSyncStatus, 
  updateSubtaskSyncStatus,
  markTaskForSync,
  markSubtaskForSync,
  getTasksNeedingSync 
} from './task-manager/monday-sync-utils.js';

/**
 * Monday.com Sync Engine
 * Handles mapping and synchronization between Task Master tasks and Monday.com items
 */
export class MondaySyncEngine {
  /**
   * Initialize the sync engine with configuration
   * @param {string} projectRoot - Project root directory
   * @param {Object} session - Optional session context
   */
  constructor(projectRoot, session = null) {
    this.projectRoot = projectRoot;
    this.session = session;
    
    // Get configuration
    const config = getMondayIntegrationConfig(projectRoot, session);
    if (!config || !config.boardId) {
      throw new Error('Monday.com integration not configured. Please run "task-master config-monday" first.');
    }

    // Get API token
    const token = getMondayApiToken(projectRoot, session);
    if (!token) {
      throw new Error('Monday API token not found in config or environment variables. Please set MONDAY_API_TOKEN or configure via "task-master config-monday --token=YOUR_TOKEN"');
    }

    this.config = config;
    this.client = new MondayClient(token);
    this.boardId = config.boardId;
    this.columnMapping = config.columnMapping;
  }

  /**
   * Map Task Master status to Monday status
   * @param {string} taskStatus - Task Master status
   * @returns {string} Monday.com status label
   */
  mapStatus(taskStatus) {
    const statusMap = {
      'pending': 'Pending',
      'in-progress': 'In Progress', 
      'in_progress': 'In Progress',
      'review': 'In Progress', // Map review to In Progress since board doesn't have a review status
      'done': 'Done',
      'cancelled': 'Done',
      'deferred': 'Deferred'
    };
    return statusMap[taskStatus] || 'Pending';
  }

  /**
   * Escape special characters for GraphQL mutations
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeForGraphQL(text) {
    if (!text) return '';
    return text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  /**
   * Create a new item on Monday board
   * @param {Object} task - Task Master task object
   * @returns {Promise<Object>} Result with success status and Monday item ID
   */
  async createItem(task) {
    const escapedTitle = this.escapeForGraphQL(task.title);
    
    const mutation = `
      mutation {
        create_item(board_id: ${this.boardId}, item_name: "${escapedTitle}") {
          id
        }
      }
    `;
    
    try {
      const result = await this.client._executeWithRateLimit(mutation);
      const mondayItemId = result.create_item.id;
      
      // Update item with additional fields
      await this.updateItemFields(mondayItemId, task);
      
      return {
        success: true,
        mondayItemId
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update existing item on Monday board
   * @param {string} mondayItemId - Monday.com item ID
   * @param {Object} task - Task Master task object
   * @returns {Promise<Object>} Result with success status
   */
  async updateItem(mondayItemId, task) {
    try {
      await this.updateItemFields(mondayItemId, task);
      return {
        success: true,
        mondayItemId
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update item fields based on column mapping
   * @param {string} mondayItemId - Monday.com item ID
   * @param {Object} task - Task Master task object
   * @returns {Promise<void>}
   */
  async updateItemFields(mondayItemId, task) {
    // Update status
    if (this.columnMapping.status) {
      const mondayStatus = this.mapStatus(task.status);
      const mutation = `
        mutation {
          change_column_value(
            board_id: ${this.boardId}, 
            item_id: ${mondayItemId}, 
            column_id: "${this.columnMapping.status}", 
            value: "{\\"label\\":\\"${mondayStatus}\\"}"
          ) {
            id
          }
        }
      `;
      await this.client._executeWithRateLimit(mutation);
    }
    
    // Update description/notes
    if (this.columnMapping.description && task.description) {
      const escapedDescription = this.escapeForGraphQL(task.description);
      const mutation = `
        mutation {
          change_column_value(
            board_id: ${this.boardId}, 
            item_id: ${mondayItemId}, 
            column_id: "${this.columnMapping.description}", 
            value: "{\\"text\\":\\"${escapedDescription}\\"}"
          ) {
            id
          }
        }
      `;
      await this.client._executeWithRateLimit(mutation);
    }

    // Update details field if available and different from description
    if (this.columnMapping.details && task.details && task.details !== task.description) {
      const escapedDetails = this.escapeForGraphQL(task.details);
      const mutation = `
        mutation {
          change_column_value(
            board_id: ${this.boardId}, 
            item_id: ${mondayItemId}, 
            column_id: "${this.columnMapping.details}", 
            value: "{\\"text\\":\\"${escapedDetails}\\"}"
          ) {
            id
          }
        }
      `;
      await this.client._executeWithRateLimit(mutation);
    }

    // Update priority if mapping exists
    if (this.columnMapping.priority && task.priority) {
      const priorityValue = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
      const mutation = `
        mutation {
          change_column_value(
            board_id: ${this.boardId}, 
            item_id: ${mondayItemId}, 
            column_id: "${this.columnMapping.priority}", 
            value: "{\\"label\\":\\"${priorityValue}\\"}"
          ) {
            id
          }
        }
      `;
      await this.client._executeWithRateLimit(mutation);
    }
  }

  /**
   * Sync a single task to Monday
   * @param {Object} task - Task Master task object
   * @param {string} tasksPath - Path to tasks.json file
   * @param {string} taskId - Task ID (for status updates)
   * @returns {Promise<Object>} Result with success status and Monday item ID
   */
  async syncTask(task, tasksPath, taskId) {
    try {
      let result;
      
      if (task.mondayItemId) {
        // Update existing item
        result = await this.updateItem(task.mondayItemId, task);
        result.mondayItemId = task.mondayItemId;
      } else {
        // Create new item
        result = await this.createItem(task);
      }
      
      // Update sync status in tasks.json
      if (result.success) {
        updateTaskSyncStatus(tasksPath, taskId, result.mondayItemId, 'synced');
      } else {
        updateTaskSyncStatus(tasksPath, taskId, task.mondayItemId || null, 'error', result.error);
      }
      
      return result;
    } catch (error) {
      // Update sync status with error
      updateTaskSyncStatus(tasksPath, taskId, task.mondayItemId || null, 'error', error.message);
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Sync a single subtask to Monday
   * @param {Object} subtask - Task Master subtask object
   * @param {Object} parentTask - Parent task object
   * @param {string} tasksPath - Path to tasks.json file
   * @param {string} subtaskId - Subtask ID in format "parentId.subtaskId"
   * @returns {Promise<Object>} Result with success status and Monday item ID
   */
  async syncSubtask(subtask, parentTask, tasksPath, subtaskId) {
    try {
      // Create a formatted title that includes parent context
      const formattedSubtask = {
        ...subtask,
        title: `[${parentTask.title}] ${subtask.title}`,
        description: subtask.description || `Subtask of: ${parentTask.title}`
      };

      let result;
      
      if (subtask.mondayItemId) {
        // Update existing item
        result = await this.updateItem(subtask.mondayItemId, formattedSubtask);
        result.mondayItemId = subtask.mondayItemId;
      } else {
        // Create new item
        result = await this.createItem(formattedSubtask);
      }
      
      // Update subtask sync status in tasks.json
      if (result.success) {
        updateSubtaskSyncStatus(tasksPath, subtaskId, result.mondayItemId, 'synced');
      } else {
        updateSubtaskSyncStatus(tasksPath, subtaskId, subtask.mondayItemId || null, 'error', result.error);
      }
      
      return result;
    } catch (error) {
      // Update sync status with error
      updateSubtaskSyncStatus(tasksPath, subtaskId, subtask.mondayItemId || null, 'error', error.message);
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Sync all pending tasks and subtasks to Monday
   * @param {string} tasksPath - Path to tasks.json file
   * @returns {Promise<Object>} Result with sync statistics
   */
  async syncAll(tasksPath) {
    const itemsToSync = getTasksNeedingSync(tasksPath);
    
    const results = {
      success: true,
      totalItems: itemsToSync.length,
      synced: 0,
      errors: 0,
      details: []
    };

    for (const item of itemsToSync) {
      let result;
      
      if (item.type === 'task') {
        result = await this.syncTask(item.task, tasksPath, item.id);
      } else {
        result = await this.syncSubtask(item.task, item.parentTask, tasksPath, item.id);
      }

      if (result.success) {
        results.synced++;
      } else {
        results.errors++;
        results.success = false;
      }

      results.details.push({
        id: item.id,
        type: item.type,
        title: item.task.title,
        success: result.success,
        error: result.error || null,
        mondayItemId: result.mondayItemId || null
      });
    }

    return results;
  }

  /**
   * Test the sync engine configuration and connection
   * @returns {Promise<Object>} Test result with success status and details
   */
  async testSync() {
    try {
      // Test Monday.com connection
      const connectionTest = await this.client.testConnection();
      if (!connectionTest.success) {
        return {
          success: false,
          error: 'Failed to connect to Monday.com API',
          details: connectionTest
        };
      }

      // Test board access
      const boardTest = await this.client.testBoardAccess(this.boardId);
      if (!boardTest.success) {
        return {
          success: false,
          error: `Failed to access Monday.com board ${this.boardId}`,
          details: boardTest
        };
      }

      return {
        success: true,
        message: 'Sync engine configuration and connection test successful',
        details: {
          connection: connectionTest,
          board: boardTest,
          config: {
            boardId: this.boardId,
            columnMapping: this.columnMapping
          }
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

/**
 * Create a Monday.com sync engine instance
 * @param {string} projectRoot - Project root directory
 * @param {Object} session - Optional session context
 * @returns {MondaySyncEngine} Configured sync engine instance
 */
export function createMondaySyncEngine(projectRoot, session = null) {
  return new MondaySyncEngine(projectRoot, session);
}

export default MondaySyncEngine; 