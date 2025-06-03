/**
 * Integration tests for Monday Storage Provider
 * Tests the actual module loading and interface compliance
 */

import { jest } from '@jest/globals';

describe('MondayStorageProvider Integration', () => {
	let MondayStorageProvider;

	beforeAll(async () => {
		// Test that the module can be imported
		try {
			const module = await import('../../../scripts/modules/storage/monday-storage-provider.js');
			MondayStorageProvider = module.default;
		} catch (error) {
			console.error('Failed to import MondayStorageProvider:', error);
			throw error;
		}
	});

	describe('module loading', () => {
		test('should import MondayStorageProvider successfully', () => {
			expect(MondayStorageProvider).toBeDefined();
			expect(typeof MondayStorageProvider).toBe('function');
		});

		test('should be a constructor function', () => {
			expect(MondayStorageProvider.name).toBe('MondayStorageProvider');
		});
	});

	describe('instance creation', () => {
		test('should create instance without throwing', () => {
			expect(() => {
				new MondayStorageProvider();
			}).not.toThrow();
		});

		test('should create instance with config', () => {
			const config = {
				boardId: 'test-board',
				columnMapping: {
					status: 'status_col',
					title: 'name'
				}
			};

			expect(() => {
				new MondayStorageProvider(config);
			}).not.toThrow();
		});
	});

	describe('interface compliance', () => {
		let provider;

		beforeEach(() => {
			provider = new MondayStorageProvider();
		});

		test('should implement BaseStorageProvider interface', () => {
			const requiredMethods = [
				'initialize',
				'getTasks',
				'getTask',
				'createTask',
				'updateTask',
				'deleteTask',
				'getSubtasks',
				'createSubtask',
				'updateSubtask',
				'deleteSubtask',
				'saveTasks',
				'validate',
				'getProviderInfo'
			];

			requiredMethods.forEach(method => {
				expect(provider[method]).toBeDefined();
				expect(typeof provider[method]).toBe('function');
			});
		});

		test('should have mapping methods', () => {
			const mappingMethods = [
				'_mapTaskStatusToMondayStatus',
				'_mapMondayStatusToTaskStatus',
				'_mapTaskPriorityToMondayPriority',
				'_mapMondayPriorityToTaskPriority',
				'_parseDependencies',
				'_escapeForGraphQL'
			];

			mappingMethods.forEach(method => {
				expect(provider[method]).toBeDefined();
				expect(typeof provider[method]).toBe('function');
			});
		});

		test('should have cache management methods', () => {
			const cacheMethods = [
				'_isCacheValid',
				'_invalidateCache'
			];

			cacheMethods.forEach(method => {
				expect(provider[method]).toBeDefined();
				expect(typeof provider[method]).toBe('function');
			});
		});
	});

	describe('status mapping functionality', () => {
		let provider;

		beforeEach(() => {
			provider = new MondayStorageProvider();
		});

		test('should map task statuses correctly', () => {
			expect(provider._mapTaskStatusToMondayStatus('pending')).toBe('Not Started');
			expect(provider._mapTaskStatusToMondayStatus('in-progress')).toBe('Working on it');
			expect(provider._mapTaskStatusToMondayStatus('done')).toBe('Done');
			expect(provider._mapTaskStatusToMondayStatus('blocked')).toBe('Stuck');
		});

		test('should map Monday statuses correctly', () => {
			expect(provider._mapMondayStatusToTaskStatus('Not Started')).toBe('pending');
			expect(provider._mapMondayStatusToTaskStatus('Working on it')).toBe('in-progress');
			expect(provider._mapMondayStatusToTaskStatus('Done')).toBe('done');
			expect(provider._mapMondayStatusToTaskStatus('Stuck')).toBe('blocked');
		});
	});

	describe('priority mapping functionality', () => {
		let provider;

		beforeEach(() => {
			provider = new MondayStorageProvider();
		});

		test('should map task priorities correctly', () => {
			expect(provider._mapTaskPriorityToMondayPriority('low')).toBe('Low');
			expect(provider._mapTaskPriorityToMondayPriority('medium')).toBe('Medium');
			expect(provider._mapTaskPriorityToMondayPriority('high')).toBe('High');
			expect(provider._mapTaskPriorityToMondayPriority('critical')).toBe('Critical');
		});

		test('should map Monday priorities correctly', () => {
			expect(provider._mapMondayPriorityToTaskPriority('Low')).toBe('low');
			expect(provider._mapMondayPriorityToTaskPriority('Medium')).toBe('medium');
			expect(provider._mapMondayPriorityToTaskPriority('High')).toBe('high');
			expect(provider._mapMondayPriorityToTaskPriority('Critical')).toBe('critical');
		});
	});

	describe('utility functions', () => {
		let provider;

		beforeEach(() => {
			provider = new MondayStorageProvider();
		});

		test('should parse dependencies correctly', () => {
			expect(provider._parseDependencies('1, 2, 3')).toEqual([1, 2, 3]);
			expect(provider._parseDependencies('1,2,3')).toEqual([1, 2, 3]);
			expect(provider._parseDependencies('1')).toEqual([1]);
			expect(provider._parseDependencies('')).toEqual([]);
			expect(provider._parseDependencies(null)).toEqual([]);
		});

		test('should escape GraphQL strings correctly', () => {
			expect(provider._escapeForGraphQL('Hello "World"')).toBe('Hello \\"World\\"');
			expect(provider._escapeForGraphQL('Line 1\nLine 2')).toBe('Line 1\\nLine 2');
			expect(provider._escapeForGraphQL('Tab\tSeparated')).toBe('Tab\\tSeparated');
			expect(provider._escapeForGraphQL('Back\\slash')).toBe('Back\\\\slash');
			expect(provider._escapeForGraphQL('')).toBe('');
			expect(provider._escapeForGraphQL(null)).toBe('');
		});
	});

	describe('cache functionality', () => {
		let provider;

		beforeEach(() => {
			provider = new MondayStorageProvider();
		});

		test('should manage cache state correctly', () => {
			// Initially cache should be invalid
			expect(provider._isCacheValid()).toBe(false);

			// Set up cache
			provider.cache = [{ id: 1, title: 'Test' }];
			provider.lastFetched = Date.now();

			// Should be valid now
			expect(provider._isCacheValid()).toBe(true);

			// Invalidate cache
			provider._invalidateCache();

			// Should be invalid again
			expect(provider._isCacheValid()).toBe(false);
			expect(provider.cache).toBeNull();
			expect(provider.lastFetched).toBeNull();
		});

		test('should detect expired cache', () => {
			provider.cache = [{ id: 1, title: 'Test' }];
			provider.lastFetched = Date.now() - 31000; // 31 seconds ago (cache timeout is 30s)

			expect(provider._isCacheValid()).toBe(false);
		});
	});
}); 