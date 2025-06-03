import { GraphQLClient } from 'graphql-request';
import { setTimeout } from 'timers/promises';

/**
 * Monday.com API Client
 * Handles GraphQL requests to Monday.com API with rate limiting and error handling
 */
export class MondayClient {
  /**
   * Initialize Monday.com API client
   * @param {string} token - Personal Access Token for Monday.com
   */
  constructor(token) {
    if (!token) {
      throw new Error('Monday.com API token is required');
    }

    this.client = new GraphQLClient('https://api.monday.com/v2', {
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json'
      }
    });
    
    this.rateLimitDelay = 100; // Start with 100ms between requests
    this.lastRequestTime = 0;
  }

  /**
   * Execute GraphQL request with rate limiting and exponential backoff
   * @param {string} operation - GraphQL operation string
   * @param {object} variables - Variables for the GraphQL operation
   * @returns {Promise<object>} API response data
   */
  async _executeWithRateLimit(operation, variables = {}) {
    // Implement rate limiting logic
    const now = Date.now();
    const timeElapsed = now - this.lastRequestTime;
    
    if (timeElapsed < this.rateLimitDelay) {
      await setTimeout(this.rateLimitDelay - timeElapsed);
    }
    
    try {
      this.lastRequestTime = Date.now();
      return await this.client.request(operation, variables);
    } catch (error) {
      // Handle rate limiting with exponential backoff
      if (error.response?.status === 429) {
        // Rate limited, increase backoff and retry
        this.rateLimitDelay = Math.min(this.rateLimitDelay * 2, 5000);
        await setTimeout(1000);
        return this._executeWithRateLimit(operation, variables);
      }
      throw error;
    }
  }

  /**
   * Test connection to Monday.com API
   * @returns {Promise<object>} Connection test result
   */
  async testConnection() {
    const query = `query { me { name } }`;
    try {
      const data = await this._executeWithRateLimit(query);
      return { 
        success: true, 
        data,
        message: 'Successfully connected to Monday.com API'
      };
    } catch (error) {
      return { 
        success: false, 
        error: error.message,
        message: 'Failed to connect to Monday.com API'
      };
    }
  }

  /**
   * Test access to a specific Monday.com board
   * @param {string} boardId - Monday.com board ID
   * @returns {Promise<object>} Board access test result
   */
  async testBoardAccess(boardId) {
    const query = `
      query GetBoard($boardId: [ID!]!) {
        boards(ids: $boardId) {
          id
          name
          columns {
            id
            title
            type
          }
        }
      }
    `;
    
    try {
      const data = await this._executeWithRateLimit(query, { boardId: [boardId] });
      
      if (!data.boards || data.boards.length === 0) {
        return {
          success: false,
          error: `Board ${boardId} not found or not accessible`,
          message: 'Board access test failed'
        };
      }
      
      return {
        success: true,
        data: data.boards[0],
        message: `Successfully accessed board: ${data.boards[0].name}`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Board access test failed'
      };
    }
  }

  /**
   * Create a new column on a Monday.com board
   * @param {string} boardId - Monday.com board ID
   * @param {string} title - Column title
   * @param {string} type - Column type (text, long_text, status, dropdown, etc.)
   * @param {string} description - Optional column description
   * @param {string} customId - Optional custom ID for the column
   * @param {object} defaults - Optional default settings for the column
   * @returns {Promise<object>} Creation result with success status and column data
   */
  async createColumn(boardId, title, type, description = null, customId = null, defaults = null) {
    const mutation = `
      mutation CreateColumn($boardId: ID!, $title: String!, $columnType: ColumnType!, $description: String, $id: String, $defaults: JSON) {
        create_column(
          board_id: $boardId,
          title: $title,
          column_type: $columnType,
          description: $description,
          id: $id,
          defaults: $defaults
        ) {
          id
          title
          type
          description
        }
      }
    `;

    const variables = {
      boardId,
      title,
      columnType: type,
      description,
      id: customId,
      defaults: defaults ? JSON.stringify(defaults) : null
    };

    try {
      const data = await this._executeWithRateLimit(mutation, variables);
      
      if (data.create_column) {
        return {
          success: true,
          data: data.create_column,
          message: `Successfully created column: ${title}`
        };
      } else {
        return {
          success: false,
          error: 'Column creation returned no data',
          message: 'Failed to create column'
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: `Failed to create column: ${title}`
      };
    }
  }

  /**
   * Update an existing dropdown column with the correct labels
   * @param {string} boardId - Monday.com board ID
   * @param {string} columnId - Column ID to update
   * @param {Array} labels - Array of label objects with name and color
   * @returns {Promise<object>} Result with success status
   */
  async updateDropdownColumnLabels(boardId, columnId, labels) {
    try {
      // Create a test item to add the labels to the dropdown
      const testItemMutation = `
        mutation {
          create_item(board_id: ${boardId}, item_name: "Temp Test Item for Labels") {
            id
          }
        }
      `;
      
      const testItemResult = await this._executeWithRateLimit(testItemMutation);
      const testItemId = testItemResult.create_item.id;
      
      try {
        // Add each label to the dropdown by setting values
        for (const label of labels) {
          const updateMutation = `
            mutation {
              change_simple_column_value(
                board_id: ${boardId}, 
                item_id: ${testItemId}, 
                column_id: "${columnId}", 
                value: "${label.name}",
                create_labels_if_missing: true
              ) {
                id
              }
            }
          `;
          
          await this._executeWithRateLimit(updateMutation);
        }
        
        return {
          success: true,
          message: `Successfully updated dropdown column ${columnId} with labels: ${labels.map(l => l.name).join(', ')}`
        };
      } finally {
        // Clean up the test item
        const deleteItemMutation = `
          mutation {
            delete_item(item_id: ${testItemId}) {
              id
            }
          }
        `;
        
        await this._executeWithRateLimit(deleteItemMutation);
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: `Failed to update dropdown column labels: ${error.message}`
      };
    }
  }

  /**
   * Create missing columns for Task Master integration on a Monday.com board
   * @param {string} boardId - Monday.com board ID
   * @param {object} requiredColumns - Object mapping column purposes to desired column specs
   * @returns {Promise<object>} Result with success status and details about created columns
   */
  async createMissingTaskMasterColumns(boardId, requiredColumns = {}) {
    const defaultRequiredColumns = {
      status: {
        title: 'Status',
        type: 'dropdown',
        description: 'Current status of the task',
        customId: 'task_status',
        defaults: {
          labels: [
            { name: 'Pending', color: '#FFD93D' },
            { name: 'In Progress', color: '#579BFC' },
            { name: 'Done', color: '#00D200' },
            { name: 'Deferred', color: '#C4C4C4' }
          ]
        }
      },
      description: {
        title: 'Description',
        type: 'long_text',
        description: 'Brief summary of what the task involves',
        customId: 'description'
      },
      details: {
        title: 'Task Details',
        type: 'long_text',
        description: 'Detailed implementation notes and requirements for the task',
        customId: 'task_details'
      },
      taskId: {
        title: 'Task ID',
        type: 'text',
        description: 'Unique identifier for the task in Task Master',
        customId: 'task_id_field'
      },
      priority: {
        title: 'Priority',
        type: 'dropdown',
        description: 'Task priority level (High, Medium, Low)',
        customId: 'task_priority',
        defaults: {
          labels: [
            { name: 'High', color: '#FF6B6B' },
            { name: 'Medium', color: '#FFD93D' },
            { name: 'Low', color: '#6BCF7F' }
          ]
        }
      },
      testStrategy: {
        title: 'Test Strategy',
        type: 'long_text',
        description: 'Testing approach and verification strategy for the task',
        customId: 'test_strategy'
      },
      dependencies: {
        title: 'Dependencies',
        type: 'text',
        description: 'Task dependencies (comma-separated Task IDs)',
        customId: 'task_dependencies'
      }
    };

    const columnsToCreate = { ...defaultRequiredColumns, ...requiredColumns };
    
    try {
      // First, get current board structure
      const boardResult = await this.testBoardAccess(boardId);
      if (!boardResult.success) {
        return {
          success: false,
          error: `Cannot access board ${boardId}: ${boardResult.error}`,
          message: 'Failed to create missing columns'
        };
      }

      const existingColumns = boardResult.data.columns;
      const existingColumnIds = existingColumns.map(col => col.id);
      const existingColumnTitles = existingColumns.map(col => col.title.toLowerCase());
      
      const createdColumns = [];
      const skippedColumns = [];
      const failedColumns = [];
      const updatedColumns = [];

      // Check each required column
      for (const [purpose, columnSpec] of Object.entries(columnsToCreate)) {
        const { title, type, description, customId } = columnSpec;
        
        // Check if column already exists by custom ID or title
        const existsByCustomId = customId && existingColumnIds.includes(customId);
        const existsByTitle = existingColumnTitles.includes(title.toLowerCase());
        
        if (existsByCustomId || existsByTitle) {
          const existingCol = existingColumns.find(col => 
            col.id === customId || col.title.toLowerCase() === title.toLowerCase()
          );
          
          // Special handling for priority dropdown column
          if (purpose === 'priority' && type === 'dropdown' && columnSpec.defaults && columnSpec.defaults.labels) {
            // Try to update the existing priority dropdown with the required labels
            console.log(`Found existing priority column: ${existingCol.id}. Ensuring it has the correct labels...`);
            const updateResult = await this.updateDropdownColumnLabels(
              boardId, 
              existingCol.id, 
              columnSpec.defaults.labels
            );
            
            if (updateResult.success) {
              updatedColumns.push({
                purpose,
                column: existingCol,
                action: 'Updated with required labels'
              });
              console.log(`✅ Updated priority column ${existingCol.id} with required labels`);
            } else {
              console.log(`⚠️ Could not update existing priority column: ${updateResult.error}`);
              skippedColumns.push({
                purpose,
                column: existingCol,
                reason: existsByCustomId ? 'Custom ID already exists' : 'Title already exists',
                note: `Could not update labels: ${updateResult.error}`
              });
            }
          } else if (purpose === 'status' && type === 'status' && columnSpec.defaults && columnSpec.defaults.labels) {
            // Special handling for status column
            console.log(`Found existing status column: ${existingCol.id}. Note: Built-in status columns cannot be modified via API.`);
            
            if (existingCol.id === 'status') {
              // This is the built-in status column - we can't modify its labels
              skippedColumns.push({
                purpose,
                column: existingCol,
                reason: 'Built-in status column exists',
                note: 'Built-in status columns cannot have their labels modified via API. Task Master will map to available labels: Working on it, Done, Stuck'
              });
              console.log(`⚠️ Using built-in status column. Available labels: Working on it, Done, Stuck`);
            } else {
              // This might be a custom status/dropdown column - try to update it
              console.log(`Found custom status column: ${existingCol.id}. Attempting to update labels...`);
              const updateResult = await this.updateDropdownColumnLabels(
                boardId, 
                existingCol.id, 
                columnSpec.defaults.labels
              );
              
              if (updateResult.success) {
                updatedColumns.push({
                  purpose,
                  column: existingCol,
                  action: 'Updated with required labels'
                });
                console.log(`✅ Updated custom status column ${existingCol.id} with required labels`);
              } else {
                console.log(`⚠️ Could not update existing status column: ${updateResult.error}`);
                skippedColumns.push({
                  purpose,
                  column: existingCol,
                  reason: existsByCustomId ? 'Custom ID already exists' : 'Title already exists',
                  note: `Could not update labels: ${updateResult.error}`
                });
              }
            }
          } else if (purpose === 'status' && type === 'dropdown' && columnSpec.defaults && columnSpec.defaults.labels) {
            // Special handling for status dropdown column (similar to priority)
            console.log(`Found existing status column: ${existingCol.id}. Ensuring it has the correct labels...`);
            const updateResult = await this.updateDropdownColumnLabels(
              boardId, 
              existingCol.id, 
              columnSpec.defaults.labels
            );
            
            if (updateResult.success) {
              updatedColumns.push({
                purpose,
                column: existingCol,
                action: 'Updated with required labels'
              });
              console.log(`✅ Updated status column ${existingCol.id} with required labels`);
            } else {
              console.log(`⚠️ Could not update existing status column: ${updateResult.error}`);
              skippedColumns.push({
                purpose,
                column: existingCol,
                reason: existsByCustomId ? 'Custom ID already exists' : 'Title already exists',
                note: `Could not update labels: ${updateResult.error}`
              });
            }
          } else {
            skippedColumns.push({
              purpose,
              column: existingCol,
              reason: existsByCustomId ? 'Custom ID already exists' : 'Title already exists'
            });
          }
          continue;
        }

        // Create the column
        console.log(`Creating ${purpose} column: ${title} (${type})`);
        const createResult = await this.createColumn(
          boardId, 
          title, 
          type, 
          description, 
          customId, 
          columnSpec.defaults
        );
        
        if (createResult.success) {
          createdColumns.push({
            purpose,
            column: createResult.data
          });
          console.log(`✅ Created ${purpose} column: ${createResult.data.id}`);
        } else {
          failedColumns.push({
            purpose,
            title,
            error: createResult.error
          });
          console.error(`❌ Failed to create ${purpose} column: ${createResult.error}`);
        }
      }

      return {
        success: failedColumns.length === 0,
        data: {
          created: createdColumns,
          skipped: skippedColumns,
          failed: failedColumns,
          updated: updatedColumns,
          summary: {
            totalRequired: Object.keys(columnsToCreate).length,
            created: createdColumns.length,
            skipped: skippedColumns.length,
            failed: failedColumns.length,
            updated: updatedColumns.length
          }
        },
        message: `Column creation completed: ${createdColumns.length} created, ${skippedColumns.length} skipped, ${failedColumns.length} failed, ${updatedColumns.length} updated`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Failed to create missing columns'
      };
    }
  }

  // Additional methods will be implemented in future tasks
}

/**
 * Create a Monday.com client from environment variables
 * @returns {MondayClient|null} Configured client or null if no token found
 */
export function createMondayClientFromEnv() {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    console.warn('MONDAY_API_TOKEN environment variable not set');
    return null;
  }
  return new MondayClient(token);
} 