import { jest } from '@jest/globals';

// Mock graphql-request using unstable_mockModule for ES modules
const mockRequest = jest.fn();
const MockGraphQLClient = jest.fn().mockImplementation(() => ({
  request: mockRequest
}));

jest.unstable_mockModule('graphql-request', () => ({
  GraphQLClient: MockGraphQLClient
}));

// Mock timers/promises
jest.unstable_mockModule('timers/promises', () => ({
  setTimeout: jest.fn(() => Promise.resolve())
}));

// Import the module to test (AFTER mocks)
const { MondayClient, createMondayClientFromEnv } = await import('../../scripts/modules/monday-client.js');

describe('MondayClient', () => {
  let originalEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = process.env.MONDAY_API_TOKEN;
    
    // Reset mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original environment
    if (originalEnv !== undefined) {
      process.env.MONDAY_API_TOKEN = originalEnv;
    } else {
      delete process.env.MONDAY_API_TOKEN;
    }
  });

  describe('Constructor', () => {
    test('should create client with valid token', () => {
      const client = new MondayClient('test-token');
      expect(client).toBeInstanceOf(MondayClient);
      expect(client.rateLimitDelay).toBe(100);
      expect(client.lastRequestTime).toBe(0);
    });

    test('should throw error with empty token', () => {
      expect(() => new MondayClient('')).toThrow('Monday.com API token is required');
    });

    test('should throw error with null token', () => {
      expect(() => new MondayClient(null)).toThrow('Monday.com API token is required');
    });
  });

  describe('testConnection', () => {
    test('should return success for valid connection', async () => {
      const mockResponse = { me: { name: 'Test User' } };
      mockRequest.mockResolvedValue(mockResponse);

      const client = new MondayClient('test-token');
      const result = await client.testConnection();

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse);
      expect(result.message).toBe('Successfully connected to Monday.com API');
      expect(mockRequest).toHaveBeenCalledWith('query { me { name } }', {});
    });

    test('should return failure for invalid connection', async () => {
      const mockError = new Error('Authentication failed');
      mockRequest.mockRejectedValue(mockError);

      const client = new MondayClient('invalid-token');
      const result = await client.testConnection();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Authentication failed');
      expect(result.message).toBe('Failed to connect to Monday.com API');
    });
  });

  describe('testBoardAccess', () => {
    test('should return success for accessible board', async () => {
      const mockResponse = {
        boards: [{
          id: '9275265350',
          name: 'Test Board',
          columns: [
            { id: 'col1', title: 'Status', type: 'color' },
            { id: 'col2', title: 'Text', type: 'text' }
          ]
        }]
      };
      mockRequest.mockResolvedValue(mockResponse);

      const client = new MondayClient('test-token');
      const result = await client.testBoardAccess('9275265350');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.boards[0]);
      expect(result.message).toBe('Successfully accessed board: Test Board');
    });

    test('should return failure for non-existent board', async () => {
      const mockResponse = { boards: [] };
      mockRequest.mockResolvedValue(mockResponse);

      const client = new MondayClient('test-token');
      const result = await client.testBoardAccess('9275265350');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Board 9275265350 not found or not accessible');
      expect(result.message).toBe('Board access test failed');
    });

    test('should return failure for API error', async () => {
      const mockError = new Error('Access denied');
      mockRequest.mockRejectedValue(mockError);

      const client = new MondayClient('test-token');
      const result = await client.testBoardAccess('9275265350');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
      expect(result.message).toBe('Board access test failed');
    });
  });

  describe('Rate Limiting', () => {
    test('should handle rate limiting with exponential backoff', async () => {
      const mockError = {
        response: { status: 429 },
        message: 'Rate limited'
      };
      const mockResponse = { me: { name: 'Test User' } };

      // First call fails with 429, second succeeds
      mockRequest
        .mockRejectedValueOnce(mockError)
        .mockResolvedValueOnce(mockResponse);

      const client = new MondayClient('test-token');
      const result = await client.testConnection();

      expect(result.success).toBe(true);
      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(client.rateLimitDelay).toBe(200); // Should double from 100 to 200
    });
  });

  describe('createMondayClientFromEnv', () => {
    test('should create client when MONDAY_API_TOKEN is set', () => {
      process.env.MONDAY_API_TOKEN = 'test-token';
      
      const client = createMondayClientFromEnv();
      
      expect(client).toBeInstanceOf(MondayClient);
    });

    test('should return null when MONDAY_API_TOKEN is not set', () => {
      delete process.env.MONDAY_API_TOKEN;
      
      // Mock console.warn to avoid noise in tests
      const mockWarn = jest.spyOn(console, 'warn').mockImplementation();
      
      const client = createMondayClientFromEnv();
      
      expect(client).toBeNull();
      expect(mockWarn).toHaveBeenCalledWith('MONDAY_API_TOKEN environment variable not set');
      
      mockWarn.mockRestore();
    });
  });
}); 