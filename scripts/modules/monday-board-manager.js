/**
 * monday-board-manager.js
 * Monday Board Manager Module - Handles board creation, schema setup, and validation
 * 
 * This module manages Monday.com board creation and configuration specifically
 * for Task Master projects, ensuring consistent schema and structure.
 */

import { initializeMondayApiClient } from './monday-api-client.js';
import { log } from './utils.js';

/**
 * Task Master required column schema for Monday.com boards
 */
export const TASK_MASTER_SCHEMA = {
  columns: {
    // Core task information
    task_id: {
      title: 'Task ID',
      type: 'text',
      required: true,
      description: 'Unique identifier for the task (e.g., 1, 1.1, 2.3)'
    },
    description: {
      title: 'Description',
      type: 'long_text',
      required: true,
      description: 'Detailed task description and requirements'
    },
    status: {
      title: 'Status',
      type: 'status',
      required: true,
      labels: {
        '1': 'Pending',
        '2': 'In Progress', 
        '3': 'Done',
        '4': 'Deferred',
        '5': 'Cancelled',
        '6': 'Review',
        '7': 'Blocked'
      },
      description: 'Current task status'
    },
    priority: {
      title: 'Priority',
      type: 'dropdown',
      required: true,
      labels: {
        '1': 'Low',
        '2': 'Medium',
        '3': 'High', 
        '4': 'Critical'
      },
      description: 'Task priority level'
    },
    
    // Task relationships
    dependencies: {
      title: 'Dependencies',
      type: 'text',
      required: false,
      description: 'Comma-separated list of task IDs this task depends on'
    },
    parent_task: {
      title: 'Parent Task',
      type: 'text',
      required: false,
      description: 'Parent task ID if this is a subtask'
    },
    
    // Implementation details
    details: {
      title: 'Implementation Details',
      type: 'long_text',
      required: false,
      description: 'Technical implementation details and notes'
    },
    test_strategy: {
      title: 'Test Strategy',
      type: 'long_text',
      required: false,
      description: 'Testing approach and verification methods'
    },
    
    // Task metadata
    task_type: {
      title: 'Task Type',
      type: 'dropdown',
      required: false,
      labels: {
        '1': 'Feature',
        '2': 'Bug Fix',
        '3': 'Refactor',
        '4': 'Documentation',
        '5': 'Test',
        '6': 'Research',
        '7': 'Setup'
      },
      description: 'Type of task being performed'
    },
    complexity_score: {
      title: 'Complexity Score',
      type: 'numbers',
      required: false,
      description: 'Complexity score from 1-10 (used for task breakdown)'
    },
    
    // Assignment and tracking
    created_by: {
      title: 'Created By',
      type: 'people',
      required: false,
      description: 'Person who created this task'
    },
    assigned_to: {
      title: 'Assigned To',
      type: 'people',
      required: false,
      description: 'Person assigned to work on this task'
    }
  },
  
  groups: {
    pending: {
      title: 'Pending Tasks',
      color: '#0086c0',
      description: 'Tasks ready to be worked on'
    },
    in_progress: {
      title: 'In Progress',
      color: '#fdab3d',
      description: 'Tasks currently being worked on'
    },
    completed: {
      title: 'Completed',
      color: '#00c875',
      description: 'Successfully completed tasks'
    },
    blocked: {
      title: 'Blocked/Deferred',
      color: '#e2445c',
      description: 'Tasks that are blocked or deferred'
    },
    subtasks: {
      title: 'Subtasks',
      color: '#a25ddc',
      description: 'Subtasks and detailed implementation items'
    }
  }
};

/**
 * Monday Board Manager Class
 * Handles board creation, schema management, and validation
 */
export class MondayBoardManager {
  constructor(apiKey = null) {
    this.apiKey = apiKey;
    this.client = null;
    this.initialized = false;
  }

  /**
   * Initialize the board manager
   */
  async initialize() {
    try {
      if (!this.apiKey) {
        throw new Error('Monday.com API key is required');
      }

      this.client = await initializeMondayApiClient(this.apiKey);
      this.initialized = true;
      
      log('[SUCCESS] Monday Board Manager initialized successfully', 'success');
      return true;
    } catch (error) {
      log(`[ERROR] Failed to initialize Monday Board Manager: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Create a new project board with Task Master schema
   * @param {string} projectName - Name of the project
   * @param {Object} options - Additional options for board creation
   * @returns {Object} Board creation result with board ID and schema info
   */
  async createProjectBoard(projectName, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    const {
      description = `Task Master board for ${projectName}`,
      kind = 'private',
      workspace_id = null
    } = options;

    try {
      log(`[INFO] Creating Task Master board for project: ${projectName}`, 'info');

      // Create the board
      const boardResult = await this.client.createBoard(
        `Task Master - ${projectName}`,
        kind,
        description,
        workspace_id
      );

      const boardId = boardResult.data.id;
      log(`[SUCCESS] Board created with ID: ${boardId}`, 'success');

      // Setup the schema
      const schemaResult = await this.setupBoardColumns(boardId);
      const groupsResult = await this.setupBoardGroups(boardId);

      return {
        success: true,
        board: {
          id: boardId,
          name: boardResult.data.name,
          url: boardResult.data.url || `https://monday.com/boards/${boardId}`
        },
        schema: {
          columns: schemaResult.columns,
          groups: groupsResult.groups,
          columnsCreated: schemaResult.created,
          groupsCreated: groupsResult.created
        }
      };

    } catch (error) {
      log(`[ERROR] Failed to create project board: ${error.message}`, 'error');
      throw new Error(`Board creation failed: ${error.message}`);
    }
  }

  /**
   * Setup all required columns for Task Master on a board
   * @param {string} boardId - Monday.com board ID
   * @returns {Object} Column setup results
   */
  async setupBoardColumns(boardId) {
    if (!this.initialized) {
      await this.initialize();
    }

    const results = {
      columns: {},
      created: [],
      skipped: [],
      errors: []
    };

    try {
      log(`[INFO] Setting up Task Master columns for board ${boardId}`, 'info');

      // Get current board schema to avoid duplicate columns
      const currentSchema = await this.client.getBoardSchema(boardId);
      const existingColumns = currentSchema.data.columns.reduce((acc, col) => {
        acc[col.title.toLowerCase()] = col;
        return acc;
      }, {});

      // Create each required column
      for (const [key, columnDef] of Object.entries(TASK_MASTER_SCHEMA.columns)) {
        const columnTitle = columnDef.title;
        const lowerTitle = columnTitle.toLowerCase();

        try {
          // Skip if column already exists
          if (existingColumns[lowerTitle] || existingColumns[columnTitle.toLowerCase().replace(/\s+/g, '_')]) {
            log(`[INFO] Column "${columnTitle}" already exists, skipping`, 'info');
            results.skipped.push(columnTitle);
            results.columns[key] = existingColumns[lowerTitle] || existingColumns[columnTitle.toLowerCase().replace(/\s+/g, '_')];
            continue;
          }

          // Create the column
          const columnResult = await this.client.createColumn(
            boardId,
            columnDef.type,
            columnTitle,
            columnDef.labels || {}
          );

          results.columns[key] = columnResult.data;
          results.created.push(columnTitle);
          log(`[SUCCESS] Created column: ${columnTitle} (${columnDef.type})`, 'success');

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 200));

        } catch (error) {
          log(`[ERROR] Failed to create column "${columnTitle}": ${error.message}`, 'error');
          results.errors.push({
            column: columnTitle,
            error: error.message
          });

          // Try with fallback column type if original failed
          if (columnDef.type !== 'text') {
            try {
              log(`[INFO] Trying fallback text column for "${columnTitle}"`, 'info');
              const fallbackResult = await this.client.createColumn(
                boardId,
                'text',
                columnTitle,
                {}
              );
              results.columns[key] = fallbackResult.data;
              results.created.push(`${columnTitle} (text fallback)`);
              log(`[SUCCESS] Created fallback text column: ${columnTitle}`, 'success');
            } catch (fallbackError) {
              log(`[ERROR] Fallback also failed for "${columnTitle}": ${fallbackError.message}`, 'error');
            }
          }
        }
      }

      log(`[SUCCESS] Column setup completed. Created: ${results.created.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`, 'success');
      return results;

    } catch (error) {
      log(`[ERROR] Failed to setup board columns: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Setup board groups for task organization
   * @param {string} boardId - Monday.com board ID
   * @returns {Object} Groups setup results
   */
  async setupBoardGroups(boardId) {
    if (!this.initialized) {
      await this.initialize();
    }

    const results = {
      groups: {},
      created: [],
      skipped: [],
      errors: []
    };

    try {
      log(`[INFO] Setting up Task Master groups for board ${boardId}`, 'info');

      // Get current groups
      const currentSchema = await this.client.getBoardSchema(boardId);
      const existingGroups = currentSchema.data.groups.reduce((acc, group) => {
        acc[group.title.toLowerCase()] = group;
        return acc;
      }, {});

      // Create each required group
      for (const [key, groupDef] of Object.entries(TASK_MASTER_SCHEMA.groups)) {
        const groupTitle = groupDef.title;
        const lowerTitle = groupTitle.toLowerCase();

        try {
          // Skip if group already exists
          if (existingGroups[lowerTitle]) {
            log(`[INFO] Group "${groupTitle}" already exists, skipping`, 'info');
            results.skipped.push(groupTitle);
            results.groups[key] = existingGroups[lowerTitle];
            continue;
          }

          // Create the group
          const groupResult = await this.client.createGroup(
            boardId,
            groupTitle,
            groupDef.color
          );

          results.groups[key] = groupResult.data;
          results.created.push(groupTitle);
          log(`[SUCCESS] Created group: ${groupTitle}`, 'success');

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 200));

        } catch (error) {
          log(`[ERROR] Failed to create group "${groupTitle}": ${error.message}`, 'error');
          results.errors.push({
            group: groupTitle,
            error: error.message
          });
        }
      }

      log(`[SUCCESS] Groups setup completed. Created: ${results.created.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`, 'success');
      return results;

    } catch (error) {
      log(`[ERROR] Failed to setup board groups: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Validate that a board has the required Task Master schema
   * @param {string} boardId - Monday.com board ID
   * @returns {Object} Validation results
   */
  async validateBoardSchema(boardId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      log(`[INFO] Validating board schema for board ${boardId}`, 'info');

      const schema = await this.client.getBoardSchema(boardId);
      const validation = {
        valid: true,
        missingColumns: [],
        missingGroups: [],
        extraColumns: [],
        extraGroups: [],
        columnMismatches: [],
        suggestions: []
      };

      // Check columns
      const existingColumns = schema.data.columns.reduce((acc, col) => {
        acc[col.title.toLowerCase()] = col;
        return acc;
      }, {});

      // Check for missing required columns
      for (const [key, columnDef] of Object.entries(TASK_MASTER_SCHEMA.columns)) {
        const expectedTitle = columnDef.title.toLowerCase();
        if (!existingColumns[expectedTitle] && columnDef.required) {
          validation.missingColumns.push(columnDef.title);
          validation.valid = false;
        }
      }

      // Check groups
      const existingGroups = schema.data.groups.reduce((acc, group) => {
        acc[group.title.toLowerCase()] = group;
        return acc;
      }, {});

      // Check for missing groups
      for (const [key, groupDef] of Object.entries(TASK_MASTER_SCHEMA.groups)) {
        const expectedTitle = groupDef.title.toLowerCase();
        if (!existingGroups[expectedTitle]) {
          validation.missingGroups.push(groupDef.title);
          validation.valid = false;
        }
      }

      // Generate suggestions
      if (validation.missingColumns.length > 0) {
        validation.suggestions.push(`Run setupBoardColumns() to add missing columns: ${validation.missingColumns.join(', ')}`);
      }
      if (validation.missingGroups.length > 0) {
        validation.suggestions.push(`Run setupBoardGroups() to add missing groups: ${validation.missingGroups.join(', ')}`);
      }

      const statusText = validation.valid ? 'VALID' : 'INVALID';
      log(`[${statusText}] Board schema validation completed`, validation.valid ? 'success' : 'warn');

      return validation;

    } catch (error) {
      log(`[ERROR] Failed to validate board schema: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Migrate board schema to match current Task Master requirements
   * @param {string} boardId - Monday.com board ID
   * @param {Object} options - Migration options
   * @returns {Object} Migration results
   */
  async migrateBoardSchema(boardId, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    const { dryRun = false, backup = true } = options;

    try {
      log(`[INFO] ${dryRun ? 'Analyzing' : 'Performing'} board schema migration for board ${boardId}`, 'info');

      // First, validate current schema
      const validation = await this.validateBoardSchema(boardId);
      
      if (validation.valid) {
        log('[INFO] Board schema is already up to date', 'info');
        return {
          success: true,
          changes: [],
          message: 'Schema is already up to date'
        };
      }

      const changes = [];

      if (dryRun) {
        // Just report what would be changed
        validation.missingColumns.forEach(col => {
          changes.push(`Would add column: ${col}`);
        });
        validation.missingGroups.forEach(group => {
          changes.push(`Would add group: ${group}`);
        });

        return {
          success: true,
          dryRun: true,
          changes,
          validation
        };
      }

      // Perform actual migration
      let columnResults = { created: [], errors: [] };
      let groupResults = { created: [], errors: [] };

      if (validation.missingColumns.length > 0) {
        log('[INFO] Adding missing columns...', 'info');
        columnResults = await this.setupBoardColumns(boardId);
        changes.push(...columnResults.created.map(col => `Added column: ${col}`));
      }

      if (validation.missingGroups.length > 0) {
        log('[INFO] Adding missing groups...', 'info');
        groupResults = await this.setupBoardGroups(boardId);
        changes.push(...groupResults.created.map(group => `Added group: ${group}`));
      }

      // Final validation
      const finalValidation = await this.validateBoardSchema(boardId);

      return {
        success: finalValidation.valid,
        changes,
        columnResults,
        groupResults,
        finalValidation,
        message: finalValidation.valid ? 'Migration completed successfully' : 'Migration completed with some issues'
      };

    } catch (error) {
      log(`[ERROR] Failed to migrate board schema: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Get board information and schema summary
   * @param {string} boardId - Monday.com board ID
   * @returns {Object} Board information
   */
  async getBoardInfo(boardId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const schema = await this.client.getBoardSchema(boardId);
      const validation = await this.validateBoardSchema(boardId);

      return {
        board: {
          id: boardId,
          name: schema.data.name,
          description: schema.data.description
        },
        schema: {
          columns: schema.data.columns.length,
          groups: schema.data.groups.length,
          items: schema.data.items?.length || 0
        },
        validation,
        taskMasterReady: validation.valid
      };

    } catch (error) {
      log(`[ERROR] Failed to get board info: ${error.message}`, 'error');
      throw error;
    }
  }
}

/**
 * Utility functions for board management
 */

/**
 * Initialize a Monday Board Manager instance
 * @param {string} apiKey - Monday.com API key
 * @returns {MondayBoardManager} Initialized board manager
 */
export async function initializeMondayBoardManager(apiKey) {
  const manager = new MondayBoardManager(apiKey);
  await manager.initialize();
  return manager;
}

/**
 * Quick function to create a Task Master board
 * @param {string} apiKey - Monday.com API key
 * @param {string} projectName - Project name
 * @param {Object} options - Board creation options
 * @returns {Object} Board creation result
 */
export async function createTaskMasterBoard(apiKey, projectName, options = {}) {
  const manager = await initializeMondayBoardManager(apiKey);
  return await manager.createProjectBoard(projectName, options);
}

/**
 * Quick function to validate a board's Task Master compatibility
 * @param {string} apiKey - Monday.com API key
 * @param {string} boardId - Board ID to validate
 * @returns {Object} Validation results
 */
export async function validateTaskMasterBoard(apiKey, boardId) {
  const manager = await initializeMondayBoardManager(apiKey);
  return await manager.validateBoardSchema(boardId);
} 