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