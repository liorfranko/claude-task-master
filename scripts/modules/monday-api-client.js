/**
 * monday-api-client.js
 * Monday.com API Client Module - Direct API Integration
 * 
 * This module provides a clean abstraction layer for Monday.com API interactions
 * for Task Master's persistence operations using direct HTTP requests.
 */

import { log } from './utils.js';
import { 
  mondayValidation, 
  mondayErrorHandler, 
  mondayRateLimiter,
  MONDAY_ERROR_TYPES,
  MONDAY_LIMITS 
} from './monday-validation.js';

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
    
    // Validate board ID
    const boardIdValidation = mondayValidation.validateId(boardId, 'board');
    if (!boardIdValidation.valid) {
      throw new Error(boardIdValidation.message);
    }
    
    try {
      return await this._executeWithRetry(async () => {
        const query = `
          query {
            boards(ids: [${boardIdValidation.sanitized}]) {
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
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'getBoardSchema', 
        boardId: boardIdValidation.sanitized,
        resourceType: 'board'
      });
      
      log('error', `Failed to get board schema for board ${boardIdValidation.sanitized}:`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
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
    
    // Validate board ID
    const boardIdValidation = mondayValidation.validateId(boardId, 'board');
    if (!boardIdValidation.valid) {
      throw new Error(boardIdValidation.message);
    }
    
    // Validate limit
    const sanitizedLimit = Math.min(Math.max(1, parseInt(limit) || 100), 1000); // Cap at 1000 items
    
    try {
      return await this._executeWithRetry(async () => {
        const query = `
          query {
            boards(ids: [${boardIdValidation.sanitized}]) {
              items_page(limit: ${sanitizedLimit}) {
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
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'getBoardItems', 
        boardId: boardIdValidation.sanitized,
        resourceType: 'board'
      });
      
      log('error', `Failed to get board items for board ${boardIdValidation.sanitized}:`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
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
    
    // Validate board ID
    const boardIdValidation = mondayValidation.validateId(boardId, 'board');
    if (!boardIdValidation.valid) {
      throw new Error(boardIdValidation.message);
    }
    
    // Validate item name
    const nameValidation = mondayValidation.validateItemName(name);
    if (!nameValidation.valid) {
      throw new Error(nameValidation.message);
    }
    
    // Check rate limits before making the request
    const rateLimitCheck = await mondayRateLimiter.canMakeRequest(500); // Estimate 500 complexity points for creation
    if (!rateLimitCheck.allowed) {
      if (rateLimitCheck.reason === 'DAILY_LIMIT_EXCEEDED') {
        throw new Error(`Daily API limit exceeded. Reset time: ${rateLimitCheck.resetTime}`);
      } else if (rateLimitCheck.reason === 'COMPLEXITY_BUDGET_EXHAUSTED') {
        throw new Error(`Complexity budget exhausted. Reset time: ${rateLimitCheck.resetTime}`);
      } else if (rateLimitCheck.reason === 'CONCURRENT_LIMIT_EXCEEDED') {
        await new Promise(resolve => setTimeout(resolve, rateLimitCheck.waitTime));
      }
    }
    
    try {
      return await this._executeWithRetry(async () => {
        const columnValuesStr = Object.keys(columnValues).length > 0 
          ? JSON.stringify(columnValues).replace(/"/g, '\\"')
          : '';
        const groupClause = groupId ? `, group_id: "${groupId}"` : '';
        
        const mutation = `
          mutation {
            create_item(
              board_id: ${boardIdValidation.sanitized},
              item_name: "${nameValidation.sanitized.replace(/"/g, '\\"')}"
              ${groupClause}
              ${columnValuesStr ? `, column_values: "${columnValuesStr}"` : ''}
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
        
        // Track the API request
        mondayRateLimiter.trackRequest(500);
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.create_item, 'item_created');
      });
    } catch (error) {
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'createItem', 
        boardId: boardIdValidation.sanitized,
        itemName: nameValidation.sanitized
      });
      
      log('error', `Failed to create item "${nameValidation.sanitized}" in board ${boardIdValidation.sanitized}:`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
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
    
    // Validate board ID
    const boardIdValidation = mondayValidation.validateId(boardId, 'board');
    if (!boardIdValidation.valid) {
      throw new Error(boardIdValidation.message);
    }
    
    // Validate item ID
    const itemIdValidation = mondayValidation.validateId(itemId, 'item');
    if (!itemIdValidation.valid) {
      throw new Error(itemIdValidation.message);
    }
    
    // Check rate limits
    const rateLimitCheck = await mondayRateLimiter.canMakeRequest(300);
    if (!rateLimitCheck.allowed) {
      if (rateLimitCheck.reason === 'DAILY_LIMIT_EXCEEDED') {
        throw new Error(`Daily API limit exceeded. Reset time: ${rateLimitCheck.resetTime}`);
      } else if (rateLimitCheck.reason === 'COMPLEXITY_BUDGET_EXHAUSTED') {
        await mondayRateLimiter.waitForRateLimit(60000); // Wait 1 minute for complexity reset
      }
    }
    
    try {
      return await this._executeWithRetry(async () => {
        const columnValuesStr = JSON.stringify(columnValues).replace(/"/g, '\\"');
        
        const mutation = `
          mutation {
            change_multiple_column_values(
              board_id: ${boardIdValidation.sanitized},
              item_id: ${itemIdValidation.sanitized},
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
        
        // Track the API request
        mondayRateLimiter.trackRequest(300);
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.change_multiple_column_values, 'item_updated');
      });
    } catch (error) {
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'updateItem', 
        boardId: boardIdValidation.sanitized,
        itemId: itemIdValidation.sanitized
      });
      
      log('error', `Failed to update item ${itemIdValidation.sanitized} in board ${boardIdValidation.sanitized}:`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
    }
  }

  /**
   * Delete an item
   * @param {number} itemId - Item ID to delete
   * @returns {Object} Deletion confirmation
   */
  async deleteItem(itemId) {
    this._validateInitialized();
    
    // Validate item ID
    const itemIdValidation = mondayValidation.validateId(itemId, 'item');
    if (!itemIdValidation.valid) {
      throw new Error(itemIdValidation.message);
    }
    
    // Check rate limits
    const rateLimitCheck = await mondayRateLimiter.canMakeRequest(200);
    if (!rateLimitCheck.allowed) {
      if (rateLimitCheck.reason === 'DAILY_LIMIT_EXCEEDED') {
        throw new Error(`Daily API limit exceeded. Reset time: ${rateLimitCheck.resetTime}`);
      } else if (rateLimitCheck.reason === 'COMPLEXITY_BUDGET_EXHAUSTED') {
        await mondayRateLimiter.waitForRateLimit(60000);
      }
    }
    
    try {
      return await this._executeWithRetry(async () => {
        const mutation = `
          mutation {
            delete_item(item_id: ${itemIdValidation.sanitized}) {
              id
            }
          }
        `;
        
        // Track the API request
        mondayRateLimiter.trackRequest(200);
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.delete_item, 'item_deleted');
      });
    } catch (error) {
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'deleteItem', 
        itemId: itemIdValidation.sanitized
      });
      
      log('error', `Failed to delete item ${itemIdValidation.sanitized}:`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
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
    
    // Validate item ID
    const itemIdValidation = mondayValidation.validateId(itemId, 'item');
    if (!itemIdValidation.valid) {
      throw new Error(itemIdValidation.message);
    }
    
    // Validate group ID (basic string validation)
    if (!groupId || typeof groupId !== 'string') {
      throw new Error('Group ID must be a non-empty string');
    }
    
    // Check rate limits
    const rateLimitCheck = await mondayRateLimiter.canMakeRequest(250);
    if (!rateLimitCheck.allowed) {
      if (rateLimitCheck.reason === 'DAILY_LIMIT_EXCEEDED') {
        throw new Error(`Daily API limit exceeded. Reset time: ${rateLimitCheck.resetTime}`);
      } else if (rateLimitCheck.reason === 'COMPLEXITY_BUDGET_EXHAUSTED') {
        await mondayRateLimiter.waitForRateLimit(60000);
      }
    }
    
    try {
      return await this._executeWithRetry(async () => {
        const mutation = `
          mutation {
            move_item_to_group(item_id: ${itemIdValidation.sanitized}, group_id: "${groupId}") {
              id
              group {
                id
                title
              }
            }
          }
        `;
        
        // Track the API request
        mondayRateLimiter.trackRequest(250);
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.move_item_to_group, 'item_moved');
      });
    } catch (error) {
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'moveItemToGroup', 
        itemId: itemIdValidation.sanitized,
        groupId
      });
      
      log('error', `Failed to move item ${itemIdValidation.sanitized} to group ${groupId}:`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
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
    
    // Validate board name (similar to item name validation)
    const nameValidation = mondayValidation.validateItemName(boardName);
    if (!nameValidation.valid) {
      throw new Error(`Board name validation failed: ${nameValidation.message}`);
    }
    
    // Check rate limits
    const rateLimitCheck = await mondayRateLimiter.canMakeRequest(800); // Board creation is more complex
    if (!rateLimitCheck.allowed) {
      if (rateLimitCheck.reason === 'DAILY_LIMIT_EXCEEDED') {
        throw new Error(`Daily API limit exceeded. Reset time: ${rateLimitCheck.resetTime}`);
      } else if (rateLimitCheck.reason === 'COMPLEXITY_BUDGET_EXHAUSTED') {
        await mondayRateLimiter.waitForRateLimit(60000);
      }
    }
    
    try {
      return await this._executeWithRetry(async () => {
        const mutation = `
          mutation {
            create_board(
              board_name: "${nameValidation.sanitized.replace(/"/g, '\\"')}",
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
        
        // Track the API request
        mondayRateLimiter.trackRequest(800);
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.create_board, 'board_created');
      });
    } catch (error) {
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'createBoard', 
        boardName: nameValidation.sanitized
      });
      
      log('error', `Failed to create board "${nameValidation.sanitized}":`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
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
   * Get current user info
   * @returns {Object} Current user information
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
              is_admin
              is_verified
              account {
                id
                name
                plan {
                  max_users
                  period
                  tier
                }
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(query);
        return this._standardizeResponse(result.data.me, 'get_current_user');
      });
    } catch (error) {
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'getCurrentUser',
        resourceType: 'user'
      });
      
      log('error', 'Failed to get current user info:', errorResponse.error.message);
      throw new Error(errorResponse.error.message);
    }
  }

  /**
   * Add a board relation (dependency) between items using Connect Boards column
   * @param {number} itemId - Source item ID
   * @param {string} relationColumnId - Connect Boards column ID
   * @param {number|Array} targetItemIds - Target item ID(s) to connect
   * @returns {Object} Relation creation result
   */
  async addBoardRelation(itemId, relationColumnId, targetItemIds) {
    this._validateInitialized();
    
    // Validate item ID
    const itemIdValidation = mondayValidation.validateId(itemId, 'item');
    if (!itemIdValidation.valid) {
      throw new Error(itemIdValidation.message);
    }
    
    // Validate relation column ID
    if (!relationColumnId || typeof relationColumnId !== 'string') {
      throw new Error('Relation column ID must be a non-empty string');
    }
    
    // Normalize target item IDs to array
    const targetIds = Array.isArray(targetItemIds) ? targetItemIds : [targetItemIds];
    
    // Validate each target ID
    const validatedTargetIds = [];
    for (const targetId of targetIds) {
      const targetValidation = mondayValidation.validateId(targetId, 'item');
      if (!targetValidation.valid) {
        throw new Error(`Invalid target item ID: ${targetValidation.message}`);
      }
      validatedTargetIds.push(targetValidation.sanitized);
    }
    
    try {
      return await this._executeWithRetry(async () => {
        // Build the JSON value for Connect Boards column
        const connectionValue = {
          item_ids: validatedTargetIds
        };
        
        const mutation = `
          mutation {
            change_column_value(
              item_id: ${itemIdValidation.sanitized}
              column_id: "${relationColumnId}"
              value: "${JSON.stringify(connectionValue).replace(/"/g, '\\"')}"
            ) {
              id
              name
              column_values(ids: ["${relationColumnId}"]) {
                id
                value
                text
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.change_column_value, 'add_board_relation');
      });
    } catch (error) {
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'addBoardRelation',
        itemId: itemIdValidation.sanitized,
        targetIds: validatedTargetIds,
        resourceType: 'item_relation'
      });
      
      log('error', `Failed to add board relation for item ${itemIdValidation.sanitized}:`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
    }
  }

  /**
   * Remove a board relation (dependency) between items using Connect Boards column
   * @param {number} itemId - Source item ID
   * @param {string} relationColumnId - Connect Boards column ID
   * @param {number|Array} targetItemIds - Target item ID(s) to disconnect
   * @returns {Object} Relation removal result
   */
  async removeBoardRelation(itemId, relationColumnId, targetItemIds) {
    this._validateInitialized();
    
    // Validate item ID
    const itemIdValidation = mondayValidation.validateId(itemId, 'item');
    if (!itemIdValidation.valid) {
      throw new Error(itemIdValidation.message);
    }
    
    // Validate relation column ID
    if (!relationColumnId || typeof relationColumnId !== 'string') {
      throw new Error('Relation column ID must be a non-empty string');
    }
    
    // Normalize target item IDs to array
    const targetIds = Array.isArray(targetItemIds) ? targetItemIds : [targetItemIds];
    
    // Validate each target ID
    const validatedTargetIds = [];
    for (const targetId of targetIds) {
      const targetValidation = mondayValidation.validateId(targetId, 'item');
      if (!targetValidation.valid) {
        throw new Error(`Invalid target item ID: ${targetValidation.message}`);
      }
      validatedTargetIds.push(targetValidation.sanitized);
    }
    
    try {
      return await this._executeWithRetry(async () => {
        // First, get the current relations to determine what to keep
        const currentQuery = `
          query {
            items(ids: [${itemIdValidation.sanitized}]) {
              column_values(ids: ["${relationColumnId}"]) {
                id
                value
                text
              }
            }
          }
        `;
        
        const currentResult = await this._graphqlRequest(currentQuery);
        const currentColumn = currentResult.data.items[0]?.column_values[0];
        
        let updatedItemIds = [];
        
        if (currentColumn && currentColumn.value) {
          try {
            const currentValue = JSON.parse(currentColumn.value);
            const currentItemIds = currentValue.item_ids || [];
            
            // Filter out the target IDs to remove
            updatedItemIds = currentItemIds.filter(id => 
              !validatedTargetIds.includes(parseInt(id, 10))
            );
          } catch (parseError) {
            log('warn', 'Failed to parse current relation value, setting empty relations');
            updatedItemIds = [];
          }
        }
        
        // Update the column with the filtered relations
        const connectionValue = {
          item_ids: updatedItemIds
        };
        
        const mutation = `
          mutation {
            change_column_value(
              item_id: ${itemIdValidation.sanitized}
              column_id: "${relationColumnId}"
              value: "${JSON.stringify(connectionValue).replace(/"/g, '\\"')}"
            ) {
              id
              name
              column_values(ids: ["${relationColumnId}"]) {
                id
                value
                text
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(mutation);
        return this._standardizeResponse(result.data.change_column_value, 'remove_board_relation');
      });
    } catch (error) {
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'removeBoardRelation',
        itemId: itemIdValidation.sanitized,
        targetIds: validatedTargetIds,
        resourceType: 'item_relation'
      });
      
      log('error', `Failed to remove board relation for item ${itemIdValidation.sanitized}:`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
    }
  }

  /**
   * Get board relations (dependencies) for an item using Connect Boards column
   * @param {number} itemId - Item ID to get relations for
   * @param {string} relationColumnId - Connect Boards column ID
   * @returns {Object} Item relations data
   */
  async getBoardRelations(itemId, relationColumnId) {
    this._validateInitialized();
    
    // Validate item ID
    const itemIdValidation = mondayValidation.validateId(itemId, 'item');
    if (!itemIdValidation.valid) {
      throw new Error(itemIdValidation.message);
    }
    
    // Validate relation column ID
    if (!relationColumnId || typeof relationColumnId !== 'string') {
      throw new Error('Relation column ID must be a non-empty string');
    }
    
    try {
      return await this._executeWithRetry(async () => {
        const query = `
          query {
            items(ids: [${itemIdValidation.sanitized}]) {
              id
              name
              column_values(ids: ["${relationColumnId}"]) {
                id
                value
                text
                ... on ConnectBoardsValue {
                  connected_board_items {
                    id
                    name
                    state
                    board {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(query);
        const item = result.data.items[0];
        
        if (!item) {
          throw new Error(`Item ${itemIdValidation.sanitized} not found`);
        }
        
        const relationColumn = item.column_values[0];
        const relations = {
          itemId: itemIdValidation.sanitized,
          itemName: item.name,
          columnId: relationColumnId,
          connectedItems: [],
          connectedItemIds: []
        };
        
        if (relationColumn && relationColumn.connected_board_items) {
          relations.connectedItems = relationColumn.connected_board_items;
          relations.connectedItemIds = relationColumn.connected_board_items.map(item => parseInt(item.id, 10));
        } else if (relationColumn && relationColumn.value) {
          // Fallback: parse JSON value if connected_board_items is not available
          try {
            const parsedValue = JSON.parse(relationColumn.value);
            relations.connectedItemIds = parsedValue.item_ids || [];
          } catch (parseError) {
            log('warn', 'Failed to parse relation column value');
          }
        }
        
        return this._standardizeResponse(relations, 'get_board_relations');
      });
    } catch (error) {
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'getBoardRelations',
        itemId: itemIdValidation.sanitized,
        resourceType: 'item_relation'
      });
      
      log('error', `Failed to get board relations for item ${itemIdValidation.sanitized}:`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
    }
  }

  /**
   * Get dependency impact analysis - find all items that depend on a given item
   * @param {number} itemId - Item ID to analyze impact for
   * @param {number} boardId - Board ID to search within
   * @param {string} relationColumnId - Connect Boards column ID
   * @returns {Object} Impact analysis result
   */
  async getDependencyImpactAnalysis(itemId, boardId, relationColumnId) {
    this._validateInitialized();
    
    // Validate item ID
    const itemIdValidation = mondayValidation.validateId(itemId, 'item');
    if (!itemIdValidation.valid) {
      throw new Error(itemIdValidation.message);
    }
    
    // Validate board ID
    const boardIdValidation = mondayValidation.validateId(boardId, 'board');
    if (!boardIdValidation.valid) {
      throw new Error(boardIdValidation.message);
    }
    
    // Validate relation column ID
    if (!relationColumnId || typeof relationColumnId !== 'string') {
      throw new Error('Relation column ID must be a non-empty string');
    }
    
    try {
      return await this._executeWithRetry(async () => {
        const query = `
          query {
            boards(ids: [${boardIdValidation.sanitized}]) {
              items_page(limit: 500) {
                items {
                  id
                  name
                  state
                  column_values(ids: ["${relationColumnId}"]) {
                    id
                    value
                    text
                    ... on ConnectBoardsValue {
                      connected_board_items {
                        id
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        `;
        
        const result = await this._graphqlRequest(query);
        const items = result.data.boards[0]?.items_page?.items || [];
        
        const dependentItems = [];
        const targetItemId = itemIdValidation.sanitized;
        
        // Find all items that have the target item as a dependency
        for (const item of items) {
          const relationColumn = item.column_values[0];
          
          if (relationColumn) {
            let connectedItemIds = [];
            
            // Check connected_board_items first
            if (relationColumn.connected_board_items) {
              connectedItemIds = relationColumn.connected_board_items.map(connectedItem => 
                parseInt(connectedItem.id, 10)
              );
            } else if (relationColumn.value) {
              // Fallback: parse JSON value
              try {
                const parsedValue = JSON.parse(relationColumn.value);
                connectedItemIds = parsedValue.item_ids || [];
              } catch (parseError) {
                // Skip items with unparseable relation values
                continue;
              }
            }
            
            // Check if this item depends on the target item
            if (connectedItemIds.includes(targetItemId)) {
              dependentItems.push({
                id: parseInt(item.id, 10),
                name: item.name,
                state: item.state,
                dependsOn: connectedItemIds
              });
            }
          }
        }
        
        const impactAnalysis = {
          targetItemId: targetItemId,
          boardId: boardIdValidation.sanitized,
          dependentItems,
          totalImpactedItems: dependentItems.length,
          impactLevels: this._calculateDependencyImpactLevels(dependentItems, items, relationColumnId)
        };
        
        return this._standardizeResponse(impactAnalysis, 'dependency_impact_analysis');
      });
    } catch (error) {
      const errorResponse = await mondayErrorHandler.handleError(error, { 
        operation: 'getDependencyImpactAnalysis',
        itemId: itemIdValidation.sanitized,
        boardId: boardIdValidation.sanitized,
        resourceType: 'dependency_analysis'
      });
      
      log('error', `Failed to analyze dependency impact for item ${itemIdValidation.sanitized}:`, errorResponse.error.message);
      throw new Error(errorResponse.error.message);
    }
  }

  /**
   * Calculate dependency impact levels (helper method)
   * @private
   * @param {Array} dependentItems - Items that depend on the target
   * @param {Array} allItems - All items in the board
   * @param {string} relationColumnId - Connect Boards column ID
   * @returns {Object} Impact levels analysis
   */
  _calculateDependencyImpactLevels(dependentItems, allItems, relationColumnId) {
    const impactLevels = {
      direct: [], // Items that directly depend on the target
      indirect: [], // Items that depend on items that depend on the target
      chains: [] // Dependency chains
    };
    
    // Direct dependencies are the items we already found
    impactLevels.direct = dependentItems.map(item => ({
      id: item.id,
      name: item.name,
      state: item.state
    }));
    
    // Find indirect dependencies by checking what depends on the direct dependencies
    const directItemIds = dependentItems.map(item => item.id);
    
    for (const item of allItems) {
      const relationColumn = item.column_values?.[0];
      
      if (relationColumn) {
        let connectedItemIds = [];
        
        // Extract connected item IDs
        if (relationColumn.connected_board_items) {
          connectedItemIds = relationColumn.connected_board_items.map(connectedItem => 
            parseInt(connectedItem.id, 10)
          );
        } else if (relationColumn.value) {
          try {
            const parsedValue = JSON.parse(relationColumn.value);
            connectedItemIds = parsedValue.item_ids || [];
          } catch (parseError) {
            continue;
          }
        }
        
        // Check if this item depends on any of the direct dependencies
        const dependsOnDirectItems = connectedItemIds.filter(id => directItemIds.includes(id));
        
        if (dependsOnDirectItems.length > 0 && !directItemIds.includes(parseInt(item.id, 10))) {
          impactLevels.indirect.push({
            id: parseInt(item.id, 10),
            name: item.name,
            state: item.state,
            dependsOnDirect: dependsOnDirectItems
          });
        }
      }
    }
    
    return impactLevels;
  }

  // Private helper methods

  /**
   * Execute GraphQL request to Monday.com API
   * @private
   * @param {string} query - GraphQL query or mutation
   * @returns {Promise<Object>} API response
   */
  async _graphqlRequest(query) {
    // Track concurrent request
    mondayRateLimiter.trackConcurrentRequest(true);
    
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.apiKey
        },
        body: JSON.stringify({ query }),
        timeout: MONDAY_LIMITS.DEFAULT_TIMEOUT
      });

      if (!response.ok) {
        if (response.status === 429) {
          // Rate limit hit - extract retry-after header if available
          const retryAfter = response.headers.get('Retry-After');
          const retryDelay = retryAfter ? parseInt(retryAfter) * 1000 : MONDAY_LIMITS.RATE_LIMIT_RETRY_DELAY;
          throw new Error(`RATE_LIMIT_EXCEEDED:${retryDelay}`);
        }
        
        // Handle other HTTP errors
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      
      if (data.errors && data.errors.length > 0) {
        // Handle GraphQL errors with Monday.com specific error detection
        const error = data.errors[0];
        const errorMessage = error.message || 'GraphQL Error';
        
        // Check for complexity budget exhaustion
        if (errorMessage.includes('complexity') || errorMessage.includes('budget')) {
          throw new Error(`COMPLEXITY_BUDGET_EXHAUSTED:${errorMessage}`);
        }
        
        // Check for daily limit exceeded
        if (errorMessage.includes('daily') || errorMessage.includes('quota')) {
          throw new Error(`DAILY_LIMIT_EXCEEDED:${errorMessage}`);
        }
        
        throw new Error(`GraphQL Error: ${errorMessage}`);
      }

      return data;
      
    } catch (error) {
      // Handle timeout errors
      if (error.name === 'AbortError' || error.message.includes('timeout')) {
        throw new Error('NETWORK_TIMEOUT:Request timed out');
      }
      
      // Re-throw other errors as-is for higher-level handling
      throw error;
      
    } finally {
      // Always decrement concurrent request counter
      mondayRateLimiter.trackConcurrentRequest(false);
    }
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
        
        // Handle rate limiting with specific retry delays
        if (error.message.startsWith('RATE_LIMIT_EXCEEDED')) {
          const retryDelay = error.message.split(':')[1] || MONDAY_LIMITS.RATE_LIMIT_RETRY_DELAY;
          log('warn', `Rate limit exceeded, waiting ${retryDelay}ms before retry...`);
          await this._sleep(parseInt(retryDelay));
          continue;
        }
        
        // Handle complexity budget exhaustion
        if (error.message.startsWith('COMPLEXITY_BUDGET_EXHAUSTED')) {
          log('warn', `Complexity budget exhausted, waiting 60 seconds before retry...`);
          await this._sleep(60000);
          continue;
        }
        
        // Handle network timeouts
        if (error.message.startsWith('NETWORK_TIMEOUT')) {
          const delay = Math.min(this.retryDelay * Math.pow(2, attempt - 1), MONDAY_LIMITS.RETRY_DELAY_MAX);
          log('warn', `Network timeout, retrying in ${delay}ms...`);
          await this._sleep(delay);
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
      message.includes('daily_limit_exceeded') ||
      (message.includes('graphql error') && !message.includes('server error'))
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