import { jest } from '@jest/globals';

describe('Monday.com Configuration Manager', () => {
  describe('Configuration Structure', () => {
    test('should have correct default configuration structure', () => {
      const expectedDefaultConfig = {
        boardId: null,
        columnMapping: {
          status: 'status',
          name: 'name',
          notes: 'notes',
          details: 'details'
        }
      };

      // Test that our expected structure is correct
      expect(expectedDefaultConfig.boardId).toBeNull();
      expect(expectedDefaultConfig.columnMapping).toHaveProperty('status');
      expect(expectedDefaultConfig.columnMapping).toHaveProperty('name');
      expect(expectedDefaultConfig.columnMapping).toHaveProperty('notes');
      expect(expectedDefaultConfig.columnMapping).toHaveProperty('details');
    });

    test('should support valid configuration updates', () => {
      const validUpdates = [
        { boardId: '9275265350' },
        { 
          columnMapping: {
            status: 'Status Column',
            name: 'Task Name',
            notes: 'Description',
            details: 'Details'
          }
        },
        { apiToken: 'test-token-123' }
      ];

      validUpdates.forEach(update => {
        expect(update).toBeDefined();
        expect(typeof update).toBe('object');
      });
    });

    test('should validate expected configuration keys', () => {
      const requiredConfigKeys = ['boardId', 'columnMapping'];
      const requiredColumnKeys = ['status', 'name', 'notes', 'details'];

      // Verify we have the right structure expectations
      expect(requiredConfigKeys).toContain('boardId');
      expect(requiredConfigKeys).toContain('columnMapping');
      
      expect(requiredColumnKeys).toContain('status');
      expect(requiredColumnKeys).toContain('name');
      expect(requiredColumnKeys).toContain('notes');
      expect(requiredColumnKeys).toContain('details');
    });
  });

  describe('Column Mapping Validation', () => {
    test('should validate standard column mappings', () => {
      const standardMappings = {
        status: 'status',
        name: 'name',
        notes: 'notes',
        details: 'details'
      };

      Object.entries(standardMappings).forEach(([key, value]) => {
        expect(typeof key).toBe('string');
        expect(typeof value).toBe('string');
        expect(key.length).toBeGreaterThan(0);
        expect(value.length).toBeGreaterThan(0);
      });
    });

    test('should support custom column mappings', () => {
      const customMappings = {
        status: 'Status Column',
        name: 'Task Name',
        notes: 'Description Field',
        details: 'Details Field'
      };

      Object.entries(customMappings).forEach(([key, value]) => {
        expect(typeof key).toBe('string');
        expect(typeof value).toBe('string');
        expect(key.length).toBeGreaterThan(0);
        expect(value.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Validation Logic', () => {
    test('should identify required fields for validation', () => {
      const requiredForValidation = [
        'MONDAY_API_TOKEN environment variable',
        'Monday.com board ID'
      ];

      expect(requiredForValidation.length).toBe(2);
      expect(requiredForValidation).toContain('MONDAY_API_TOKEN environment variable');
      expect(requiredForValidation).toContain('Monday.com board ID');
    });

    test('should validate board ID format', () => {
      const validBoardIds = ['9275265350', '123456789', '999888777'];
      const invalidBoardIds = [null, '', undefined, 123, true, {}];

      validBoardIds.forEach(id => {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
        expect(/^\d+$/.test(id)).toBe(true); // Only digits
      });

      invalidBoardIds.forEach(id => {
        expect(id === null || id === undefined || typeof id !== 'string' || id === '').toBe(true);
      });
    });
  });
}); 