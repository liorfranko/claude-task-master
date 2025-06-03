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
 * Monday.com Sync Engine for Task Master
 * 
 * This engine synchronizes tasks from tasks/tasks.json to Monday.com boards.
 * 
 * IMPORTANT: This implementation uses tasks/tasks.json as the SINGLE SOURCE OF TRUTH.
 * - All task data is read exclusively from tasks/tasks.json
 * - Individual task files (.txt/.md) in tasks/ folder are NOT used for sync
 * - MCP tool responses are NOT used as data sources
 * 
 * CURRENT SCOPE (Phase 1):
 * - Syncs main task fields: id, title, description, details, status, priority, testStrategy
 * - Syncs subtasks as real Monday.com subitems under their parent tasks
 * - Dependencies are excluded from sync (to be implemented in Phase 2)
 * 
 * FIELD MAPPING:
 * The engine maps Task Master fields to Monday.com columns based on configuration:
 * - task.id -> mondayIntegration.columnMapping.taskId
 * - task.title -> mondayIntegration.columnMapping.title
 * - task.description -> mondayIntegration.columnMapping.description
 * - task.details -> mondayIntegration.columnMapping.details
 * - task.status -> mondayIntegration.columnMapping.status
 * - task.priority -> mondayIntegration.columnMapping.priority
 * - task.testStrategy -> mondayIntegration.columnMapping.testStrategy
 * - task.dependencies -> mondayIntegration.columnMapping.dependencies
 * - task.subtasks -> Synced as Monday.com subitems under their parent tasks
 */
export class MondaySyncEngine {
  /**
   * Initialize the sync engine with configuration
   * @param {string} projectRoot - Project root directory
   * @param {Object} session - Optional session context
   */
  constructor(projectRoot, session = null) {
    this.projectRoot = projectRoot;
    
    const config = getMondayIntegrationConfig(projectRoot, session);
    
    if (!config || !config.boardId) {
      throw new Error('Monday.com integration not configured. Please run "task-master config-monday" first.');
    }
    
    const apiToken = getMondayApiToken(projectRoot, session);
    if (!apiToken) {
      throw new Error('Monday API token not found in config or environment variables');
    }
    
    this.boardId = config.boardId;
    this.columnMapping = config.columnMapping || {};
    this.client = new MondayClient(apiToken);
    this.session = session;
  }

  /**
   * Map Task Master status to Monday.com status labels
   * @param {string} taskStatus Task Master status value
   * @returns {string} Monday.com status label
   */
  mapStatus(taskStatus) {
    const statusMap = {
      'pending': 'Pending',             // Map pending to our custom "Pending" label
      'in-progress': 'In Progress',     // Map in-progress to our custom "In Progress" label 
      'in_progress': 'In Progress',     // Map in_progress to our custom "In Progress" label
      'review': 'In Progress',          // Map review to our custom "In Progress" label
      'done': 'Done',                   // Map done to our custom "Done" label
      'cancelled': 'Done',              // Map cancelled to our custom "Done" label
      'deferred': 'Deferred'            // Map deferred to our custom "Deferred" label
    };
    return statusMap[taskStatus] || 'Pending';  // Default to "Pending"
  }

  /**
   * Create properly escaped JSON value for GraphQL mutations
   * @param {string} text - Text to escape
   * @returns {string} Properly escaped JSON value as a quoted string
   */
  createJsonValue(text) {
    if (!text) return '""';
    
    // Create the JSON object for Monday.com text columns
    const jsonObject = { text: String(text) };
    
    // Convert to JSON string - this handles all internal escaping
    const jsonString = JSON.stringify(jsonObject);
    
    // Now we need to escape this JSON string for use in GraphQL
    // Escape backslashes and quotes for GraphQL string literal
    const escapedForGraphQL = jsonString
      .replace(/\\/g, '\\\\')   // Escape backslashes first
      .replace(/"/g, '\\"');    // Escape quotes
    
    // Return as a quoted string for GraphQL
    return `"${escapedForGraphQL}"`;
  }

  /**
   * Escape text for use in GraphQL string literals (for titles, etc.)
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeForGraphQL(text) {
    if (!text) return '';
    
    // Convert to string if not already
    text = String(text);
    
    // Escape characters that would break GraphQL string literals
    return text
      .replace(/\\/g, '\\\\')        // Escape backslashes first
      .replace(/"/g, '\\"')          // Escape double quotes
      .replace(/\n/g, '\\n')         // Escape newlines
      .replace(/\r/g, '\\r')         // Escape carriage returns
      .replace(/\t/g, '\\t');        // Escape tabs
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
    // Update status (requires change_column_value for status/dropdown columns)
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
    
    // Update description/notes (use simple column value for better persistence)
    if (this.columnMapping.description && task.description) {
      const escapedDescription = this.escapeForGraphQL(task.description);
      const mutation = `
        mutation {
          change_simple_column_value(
            board_id: ${this.boardId}, 
            item_id: ${mondayItemId}, 
            column_id: "${this.columnMapping.description}", 
            value: "${escapedDescription}"
          ) {
            id
          }
        }
      `;
      await this.client._executeWithRateLimit(mutation);
    }

    // Update details field if available and different from description (use simple column value)
    if (this.columnMapping.details && task.details && task.details !== task.description) {
      const escapedDetails = this.escapeForGraphQL(task.details);
      const mutation = `
        mutation {
          change_simple_column_value(
            board_id: ${this.boardId}, 
            item_id: ${mondayItemId}, 
            column_id: "${this.columnMapping.details}", 
            value: "${escapedDetails}"
          ) {
            id
          }
        }
      `;
      await this.client._executeWithRateLimit(mutation);
    }

    // Update priority (requires change_column_value for dropdown columns)
    if (this.columnMapping.priority && task.priority) {
      const priorityValue = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
      
      try {
        const mutation = `
          mutation {
            change_column_value(
              board_id: ${this.boardId}, 
              item_id: ${mondayItemId}, 
              column_id: "${this.columnMapping.priority}", 
              value: "{\\"labels\\":[\\"${priorityValue}\\"]}"
            ) {
              id
            }
          }
        `;
        await this.client._executeWithRateLimit(mutation);
      } catch (error) {
        // If priority dropdown doesn't have the required labels, skip priority update
        // This is common when the Monday.com board dropdown is not properly configured
        if (error.message && error.message.includes('does not exist, possible labels are')) {
          console.log(`⚠️ Skipping priority update for task ${task.id}: Monday.com dropdown column doesn't have the required priority labels. Please configure the dropdown with values: High, Medium, Low`);
        } else {
          // Re-throw other errors
          throw error;
        }
      }
    }

    // Update Task ID (already using simple column value for better persistence)
    if (this.columnMapping.taskId && task.id) {
      const taskIdValue = String(task.id);
      const mutation = `
        mutation {
          change_simple_column_value(
            board_id: ${this.boardId}, 
            item_id: ${mondayItemId}, 
            column_id: "${this.columnMapping.taskId}", 
            value: "${taskIdValue}"
          ) {
            id
          }
        }
      `;
      await this.client._executeWithRateLimit(mutation);
    }

    // Update Test Strategy (use simple column value for better persistence)
    if (this.columnMapping.testStrategy && task.testStrategy) {
      const escapedTestStrategy = this.escapeForGraphQL(task.testStrategy);
      const mutation = `
        mutation {
          change_simple_column_value(
            board_id: ${this.boardId}, 
            item_id: ${mondayItemId}, 
            column_id: "${this.columnMapping.testStrategy}", 
            value: "${escapedTestStrategy}"
          ) {
            id
          }
        }
      `;
      await this.client._executeWithRateLimit(mutation);
    }

    // Update Dependencies (use simple column value for better persistence)
    if (this.columnMapping.dependencies && task.dependencies) {
      let dependenciesText = '';
      if (Array.isArray(task.dependencies)) {
        dependenciesText = task.dependencies.length > 0 ? task.dependencies.join(', ') : '';
      } else {
        dependenciesText = String(task.dependencies);
      }
      
      if (dependenciesText) {
        const escapedDependencies = this.escapeForGraphQL(dependenciesText);
        const mutation = `
          mutation {
            change_simple_column_value(
              board_id: ${this.boardId}, 
              item_id: ${mondayItemId}, 
              column_id: "${this.columnMapping.dependencies}", 
              value: "${escapedDependencies}"
            ) {
              id
            }
          }
        `;
        await this.client._executeWithRateLimit(mutation);
      }
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
   * Create a new subitem on Monday board
   * @param {Object} subtask - Task Master subtask object
   * @param {string} parentMondayItemId - Parent Monday.com item ID
   * @returns {Promise<Object>} Result with success status and Monday subitem ID
   */
  async createSubitem(subtask, parentMondayItemId) {
    const escapedTitle = this.escapeForGraphQL(subtask.title);
    
    const mutation = `
      mutation {
        create_subitem(parent_item_id: ${parentMondayItemId}, item_name: "${escapedTitle}") {
          id
          board {
            id
          }
        }
      }
    `;
    
    try {
      const result = await this.client._executeWithRateLimit(mutation);
      const mondaySubitemId = result.create_subitem.id;
      
      // Update subitem with additional fields
      await this.updateItemFields(mondaySubitemId, subtask);
      
      return {
        success: true,
        mondayItemId: mondaySubitemId
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Sync a single subtask to Monday as a real subitem
   * @param {Object} subtask - Task Master subtask object
   * @param {Object} parentTask - Parent task object
   * @param {string} tasksPath - Path to tasks.json file
   * @param {string} subtaskId - Subtask ID in format "parentId.subtaskId"
   * @returns {Promise<Object>} Result with success status and Monday item ID
   */
  async syncSubtask(subtask, parentTask, tasksPath, subtaskId) {
    try {
      // Ensure parent task has a Monday item ID
      if (!parentTask.mondayItemId) {
        const errorMsg = `Parent task (ID: ${parentTask.id}) must be synced to Monday.com before its subtasks can be synced`;
        // Update sync status with error before returning
        updateSubtaskSyncStatus(tasksPath, subtaskId, null, 'error', errorMsg);
        return {
          success: false,
          error: errorMsg
        };
      }

      let result;
      
      if (subtask.mondayItemId) {
        // Update existing subitem
        result = await this.updateItem(subtask.mondayItemId, subtask);
        result.mondayItemId = subtask.mondayItemId;
      } else {
        // Create new subitem under parent
        result = await this.createSubitem(subtask, parentTask.mondayItemId);
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
    
    // Separate tasks and subtasks for proper sync order
    const tasksToSync = itemsToSync.filter(item => item.type === 'task');
    const subtasksToSync = itemsToSync.filter(item => item.type === 'subtask');
    
    const results = {
      success: true,
      totalItems: itemsToSync.length,
      synced: 0,
      errors: 0,
      details: []
    };

    // First, sync all parent tasks
    for (const item of tasksToSync) {
      const result = await this.syncTask(item.task, tasksPath, item.id);

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

    // Then, sync all subtasks (now that parent tasks should have Monday item IDs)
    for (const item of subtasksToSync) {
      const result = await this.syncSubtask(item.task, item.parentTask, tasksPath, item.id);

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