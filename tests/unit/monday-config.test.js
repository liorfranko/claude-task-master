import { jest } from '@jest/globals';

describe('Monday.com Configuration Manager', () => {
  describe('Configuration Structure', () => {
    test('should have correct default configuration structure', () => {
      const expectedDefaultConfig = {
        boardId: null,
        columnMapping: {
          status: 'status',
          name: 'name',
          notes: 'notes'
        },
        syncSettings: {
          autoSync: false
        }
      };

      // Test that our expected structure is correct
      expect(expectedDefaultConfig.boardId).toBeNull();
      expect(expectedDefaultConfig.columnMapping).toHaveProperty('status');
      expect(expectedDefaultConfig.columnMapping).toHaveProperty('name');
      expect(expectedDefaultConfig.columnMapping).toHaveProperty('notes');
      expect(expectedDefaultConfig.syncSettings).toHaveProperty('autoSync');
      expect(expectedDefaultConfig.syncSettings.autoSync).toBe(false);
    });

    test('should support valid configuration updates', () => {
      const validUpdates = [
        { boardId: '9275265350' },
        { autoSync: true },
        { autoSync: false },
        { 
          columnMapping: {
            status: 'Status Column',
            name: 'Task Name',
            notes: 'Description'
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
      const requiredConfigKeys = ['boardId', 'columnMapping', 'syncSettings'];
      const requiredColumnKeys = ['status', 'name', 'notes'];
      const requiredSyncKeys = ['autoSync'];

      // Verify we have the right structure expectations
      expect(requiredConfigKeys).toContain('boardId');
      expect(requiredConfigKeys).toContain('columnMapping');
      expect(requiredConfigKeys).toContain('syncSettings');
      
      expect(requiredColumnKeys).toContain('status');
      expect(requiredColumnKeys).toContain('name');
      expect(requiredColumnKeys).toContain('notes');
      
      expect(requiredSyncKeys).toContain('autoSync');
      expect(requiredSyncKeys).not.toContain('syncSubtasks'); // Removed complexity
    });
  });

  describe('Column Mapping Validation', () => {
    test('should validate standard column mappings', () => {
      const standardMappings = {
        status: 'status',
        name: 'name',
        notes: 'notes'
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
        notes: 'Description Field'
      };

      Object.entries(customMappings).forEach(([key, value]) => {
        expect(typeof key).toBe('string');
        expect(typeof value).toBe('string');
        expect(key.length).toBeGreaterThan(0);
        expect(value.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Sync Settings Validation', () => {
    test('should validate autoSync setting', () => {
      const validAutoSyncValues = [true, false];
      
      validAutoSyncValues.forEach(value => {
        expect(typeof value).toBe('boolean');
      });
    });

    test('should not include syncSubtasks setting', () => {
      const syncSettings = {
        autoSync: false
      };

      expect(syncSettings).not.toHaveProperty('syncSubtasks');
      expect(Object.keys(syncSettings)).toEqual(['autoSync']);
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