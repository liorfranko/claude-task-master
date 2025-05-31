/**
 * monday-api-client.js
 * Monday.com API Client Module - Direct API Integration
 * 
 * This module provides a clean abstraction layer for Monday.com API interactions
 * for Task Master's persistence operations using direct HTTP requests.
 */

import { log } from './utils.js';

/**
 * Monday.com API Client Class
 * Handles direct API calls to Monday.com GraphQL endpoint
 */
export class MondayApiClient {
  constructor(apiKey = null) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.monday.com/v2';
    this.initialized = false;
    this.retryAttempts = 3;
    this.retryDelay = 1000; // Start with 1 second
    this.rateLimitDelay = 60000; // 1 minute for rate limit backoff
  }

  /**
   * Initialize the Monday.com API client
   * @param {string} apiKey - Monday.com API key
   */
  async initializeClient(apiKey = null) {
    try {
      if (apiKey) {
        this.apiKey = apiKey;
      }
      
      if (!this.apiKey) {
        throw new Error('Monday.com API key is required');
      }
      
      // Test connection by attempting to get current user
      await this._executeWithRetry(async () => {
        await this._graphqlRequest(`
          query {
            me {
              id
              name
            }
          }
        `);
      });
      
      this.initialized = true;
      log('success', 'Monday.com API client initialized successfully');
      return { success: true, message: 'Client initialized' };
    } catch (error) {
      log('error', 'Failed to initialize Monday.com API client:', error.message);
      throw new Error(`Monday.com API initialization failed: ${error.message}`);
    }
  }

  /**
   * Get board schema (columns and groups)
   * @param {number} boardId - Monday.com board ID
   * @returns {Object} Board schema with columns and groups
   */
  async getBoardSchema(boardId) {
    this._validateInitialized();
    
    try {
      return await this._executeWithRetry(async () => {
        const query = `
          query {
            boards(ids: [${boardId}]) {
              id
              name
              description
              columns {
                id
                title
                type
                settings_str
              }
              groups {
                id
                title
                color
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(query);
        return this._standardizeResponse(result.data.boards[0], 'board_schema');
      });
    } catch (error) {
      log('error', `Failed to get board schema for board ${boardId}:`, error.message);
      throw new Error(`Board schema retrieval failed: ${error.message}`);
    }
  }

  /**
   * Get all items from a board
   * @param {number} boardId - Monday.com board ID
   * @param {number} limit - Maximum number of items to retrieve (default: 100)
   * @returns {Object} Array of board items
   */
  async getBoardItems(boardId, limit = 100) {
    this._validateInitialized();
    
    try {
      return await this._executeWithRetry(async () => {
        const query = `
          query {
            boards(ids: [${boardId}]) {
              items_page(limit: ${limit}) {
                items {
                  id
                  name
                  state
                  group {
                    id
                    title
                  }
                  column_values {
                    id
                    text
                    value
                  }
                  created_at
                  updated_at
                }
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(query);
        return this._standardizeResponse(result.data.boards[0].items_page.items, 'board_items');
      });
    } catch (error) {
      log('error', `Failed to get board items for board ${boardId}:`, error.message);
      throw new Error(`Board items retrieval failed: ${error.message}`);
    }
  }

  /**
   * Create a new item in a board
   * @param {number} boardId - Monday.com board ID
   * @param {string} name - Item name
   * @param {Object} columnValues - Column values object
   * @param {string} groupId - Optional group ID
   * @returns {Object} Created item data
   */
  async createItem(boardId, name, columnValues = {}, groupId = null) {
    this._validateInitialized();
    
    try {
      return await this._executeWithRetry(async () => {
        const columnValuesStr = JSON.stringify(columnValues).replace(/"/g, '\\"');
        const groupClause = groupId ? `, group_id: "${groupId}"` : '';
        
        const mutation = `
          mutation {
            create_item(
              board_id: ${boardId},
              item_name: "${name.replace(/"/g, '\\"')}"
              ${groupClause}
              ${Object.keys(columnValues).length > 0 ? `, column_values: "${columnValuesStr}"` : ''}
            ) {
              id
              name
              state
              group {
                id
                title
              }
              column_values {
                id
                text
                value
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.create_item, 'item_created');
      });
    } catch (error) {
      log('error', `Failed to create item "${name}" in board ${boardId}:`, error.message);
      throw new Error(`Item creation failed: ${error.message}`);
    }
  }

  /**
   * Update item column values
   * @param {number} boardId - Monday.com board ID
   * @param {number} itemId - Item ID to update
   * @param {Object} columnValues - Column values object
   * @returns {Object} Updated item data
   */
  async updateItem(boardId, itemId, columnValues) {
    this._validateInitialized();
    
    try {
      return await this._executeWithRetry(async () => {
        const columnValuesStr = JSON.stringify(columnValues).replace(/"/g, '\\"');
        
        const mutation = `
          mutation {
            change_multiple_column_values(
              board_id: ${boardId},
              item_id: ${itemId},
              column_values: "${columnValuesStr}"
            ) {
              id
              name
              column_values {
                id
                text
                value
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.change_multiple_column_values, 'item_updated');
      });
    } catch (error) {
      log('error', `Failed to update item ${itemId} in board ${boardId}:`, error.message);
      throw new Error(`Item update failed: ${error.message}`);
    }
  }

  /**
   * Delete an item
   * @param {number} itemId - Item ID to delete
   * @returns {Object} Deletion confirmation
   */
  async deleteItem(itemId) {
    this._validateInitialized();
    
    try {
      return await this._executeWithRetry(async () => {
        const mutation = `
          mutation {
            delete_item(item_id: ${itemId}) {
              id
            }
          }
        `;
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.delete_item, 'item_deleted');
      });
    } catch (error) {
      log('error', `Failed to delete item ${itemId}:`, error.message);
      throw new Error(`Item deletion failed: ${error.message}`);
    }
  }

  /**
   * Move item to a group
   * @param {number} itemId - Item ID to move
   * @param {string} groupId - Target group ID
   * @returns {Object} Move operation result
   */
  async moveItemToGroup(itemId, groupId) {
    this._validateInitialized();
    
    try {
      return await this._executeWithRetry(async () => {
        const mutation = `
          mutation {
            move_item_to_group(item_id: ${itemId}, group_id: "${groupId}") {
              id
              group {
                id
                title
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.move_item_to_group, 'item_moved');
      });
    } catch (error) {
      log('error', `Failed to move item ${itemId} to group ${groupId}:`, error.message);
      throw new Error(`Item move failed: ${error.message}`);
    }
  }

  /**
   * Create a board
   * @param {string} boardName - Name of the board
   * @param {string} boardKind - Board type (public, private, share)
   * @param {string} description - Board description
   * @returns {Object} Created board data
   */
  async createBoard(boardName, boardKind = 'public', description = '') {
    this._validateInitialized();
    
    try {
      return await this._executeWithRetry(async () => {
        const mutation = `
          mutation {
            create_board(
              board_name: "${boardName.replace(/"/g, '\\"')}",
              board_kind: ${boardKind}
              ${description ? `, description: "${description.replace(/"/g, '\\"')}"` : ''}
            ) {
              id
              name
              description
              board_kind
            }
          }
        `;
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.create_board, 'board_created');
      });
    } catch (error) {
      log('error', `Failed to create board "${boardName}":`, error.message);
      throw new Error(`Board creation failed: ${error.message}`);
    }
  }

  /**
   * Create a column in a board
   * @param {number} boardId - Board ID
   * @param {string} columnType - Column type
   * @param {string} columnTitle - Column title
   * @param {Object} defaults - Column default values/settings
   * @returns {Object} Created column data
   */
  async createColumn(boardId, columnType, columnTitle, defaults = {}) {
    this._validateInitialized();
    
    try {
      return await this._executeWithRetry(async () => {
        const defaultsStr = Object.keys(defaults).length > 0 ? 
          `, defaults: "${JSON.stringify(defaults).replace(/"/g, '\\"')}"` : '';
        
        const mutation = `
          mutation {
            create_column(
              board_id: ${boardId},
              title: "${columnTitle.replace(/"/g, '\\"')}",
              column_type: ${columnType}
              ${defaultsStr}
            ) {
              id
              title
              type
              settings_str
            }
          }
        `;
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.create_column, 'column_created');
      });
    } catch (error) {
      log('error', `Failed to create column "${columnTitle}" in board ${boardId}:`, error.message);
      throw new Error(`Column creation failed: ${error.message}`);
    }
  }

  /**
   * Create an update on an item
   * @param {number} itemId - Item ID
   * @param {string} body - Update body text
   * @returns {Object} Created update data
   */
  async createUpdate(itemId, body) {
    this._validateInitialized();
    
    try {
      return await this._executeWithRetry(async () => {
        const mutation = `
          mutation {
            create_update(
              item_id: ${itemId},
              body: "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
            ) {
              id
              body
              created_at
            }
          }
        `;
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.create_update, 'update_created');
      });
    } catch (error) {
      log('error', `Failed to create update for item ${itemId}:`, error.message);
      throw new Error(`Update creation failed: ${error.message}`);
    }
  }

  /**
   * Get current user information
   * @returns {Object} User data
   */
  async getCurrentUser() {
    this._validateInitialized();
    
    try {
      return await this._executeWithRetry(async () => {
        const query = `
          query {
            me {
              id
              name
              email
              account {
                id
                name
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(query);
        return this._standardizeResponse(result.data.me, 'current_user');
      });
    } catch (error) {
      log('error', 'Failed to get current user:', error.message);
      throw new Error(`User retrieval failed: ${error.message}`);
    }
  }

  // Private helper methods

  /**
   * Execute GraphQL request to Monday.com API
   * @private
   * @param {string} query - GraphQL query or mutation
   * @returns {Promise<Object>} API response
   */
  async _graphqlRequest(query) {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.apiKey
      },
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      if (response.status === 429) {
        // Rate limit hit
        throw new Error('RATE_LIMIT_EXCEEDED');
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.errors && data.errors.length > 0) {
      throw new Error(`GraphQL Error: ${data.errors[0].message}`);
    }

    return data;
  }

  /**
   * Validate that the client is initialized
   * @private
   */
  _validateInitialized() {
    if (!this.initialized) {
      throw new Error('Monday.com API client not initialized. Call initializeClient() first.');
    }
    if (!this.apiKey) {
      throw new Error('Monday.com API key is required but not provided.');
    }
  }

  /**
   * Execute a function with retry logic
   * @private
   * @param {Function} fn - Function to execute
   * @returns {Promise} Function result
   */
  async _executeWithRetry(fn) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        // Handle rate limiting
        if (error.message === 'RATE_LIMIT_EXCEEDED') {
          log('warn', `Rate limit exceeded, waiting ${this.rateLimitDelay}ms before retry...`);
          await this._sleep(this.rateLimitDelay);
          continue;
        }
        
        // Don't retry on certain error types
        if (this._isNonRetryableError(error)) {
          throw error;
        }
        
        if (attempt < this.retryAttempts) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
          log('warn', `Monday.com API call failed (attempt ${attempt}/${this.retryAttempts}), retrying in ${delay}ms...`);
          await this._sleep(delay);
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Check if an error should not be retried
   * @private
   * @param {Error} error - Error to check
   * @returns {boolean} True if error should not be retried
   */
  _isNonRetryableError(error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('not found') ||
      message.includes('invalid') ||
      message.includes('bad request') ||
      message.includes('graphql error')
    );
  }

  /**
   * Sleep for specified milliseconds
   * @private
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise} Promise that resolves after delay
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Standardize API response format
   * @private
   * @param {Object} result - Raw API result
   * @param {string} operation - Operation type for context
   * @returns {Object} Standardized response
   */
  _standardizeResponse(result, operation) {
    return {
      success: true,
      operation,
      data: result,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Create a singleton instance of the Monday API client
 */
let mondayClientInstance = null;

/**
 * Get or create Monday API client instance
 * @param {string} apiKey - Monday.com API key
 * @returns {MondayApiClient} Monday API client instance
 */
export function getMondayApiClient(apiKey = null) {
  if (!mondayClientInstance) {
    mondayClientInstance = new MondayApiClient(apiKey);
  } else if (apiKey && apiKey !== mondayClientInstance.apiKey) {
    mondayClientInstance.apiKey = apiKey;
  }
  
  return mondayClientInstance;
}

/**
 * Initialize Monday API client (convenience function)
 * @param {string} apiKey - Monday.com API key
 * @returns {Promise<MondayApiClient>} Initialized client
 */
export async function initializeMondayApiClient(apiKey = null) {
  const client = getMondayApiClient(apiKey);
  await client.initializeClient(apiKey);
  return client;
}

/**
 * Reset the client instance (useful for testing)
 */
export function resetMondayApiClient() {
  mondayClientInstance = null;
} 