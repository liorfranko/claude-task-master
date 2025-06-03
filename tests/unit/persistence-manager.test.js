/**
 * Unit tests for the Persistence Manager abstraction layer
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { PersistenceManager, BaseStorageProvider } from '../../scripts/modules/persistence-manager.js';

// Mock the config-manager and utils
jest.mock('../../scripts/modules/config-manager.js', () => ({
	getConfig: jest.fn(() => ({
		persistence: { mode: 'local' }
	}))
}));

jest.mock('../../scripts/modules/utils.js', () => ({
	log: jest.fn()
}));

describe('BaseStorageProvider', () => {
	let provider;

	beforeEach(() => {
		provider = new BaseStorageProvider({});
	});

	test('should extend EventEmitter', () => {
		expect(provider).toBeInstanceOf(EventEmitter);
	});

	test('should throw errors for unimplemented methods', async () => {
		await expect(provider.initialize()).rejects.toThrow('initialize() must be implemented by storage provider');
		await expect(provider.getTasks()).rejects.toThrow('getTasks() must be implemented by storage provider');
		await expect(provider.getTask(1)).rejects.toThrow('getTask() must be implemented by storage provider');
		await expect(provider.createTask({})).rejects.toThrow('createTask() must be implemented by storage provider');
		await expect(provider.updateTask(1, {})).rejects.toThrow('updateTask() must be implemented by storage provider');
		await expect(provider.deleteTask(1)).rejects.toThrow('deleteTask() must be implemented by storage provider');
		await expect(provider.getSubtasks(1)).rejects.toThrow('getSubtasks() must be implemented by storage provider');
		await expect(provider.createSubtask(1, {})).rejects.toThrow('createSubtask() must be implemented by storage provider');
		await expect(provider.updateSubtask(1, 1, {})).rejects.toThrow('updateSubtask() must be implemented by storage provider');
		await expect(provider.deleteSubtask(1, 1)).rejects.toThrow('deleteSubtask() must be implemented by storage provider');
		await expect(provider.saveTasks([])).rejects.toThrow('saveTasks() must be implemented by storage provider');
		await expect(provider.validate()).rejects.toThrow('validate() must be implemented by storage provider');
	});

	test('should return default provider info', () => {
		const info = provider.getProviderInfo();
		expect(info).toEqual({
			name: 'base',
			version: '1.0.0',
			capabilities: ['read', 'write']
		});
	});
});

describe('PersistenceManager', () => {
	let manager;
	let mockProvider;

	beforeEach(() => {
		manager = new PersistenceManager();
		
		// Create a mock provider
		mockProvider = {
			initialize: jest.fn().mockResolvedValue(),
			getTasks: jest.fn().mockResolvedValue([]),
			getTask: jest.fn().mockResolvedValue(null),
			createTask: jest.fn().mockResolvedValue({ id: 1, title: 'Test Task' }),
			updateTask: jest.fn().mockResolvedValue({ id: 1, title: 'Updated Task' }),
			deleteTask: jest.fn().mockResolvedValue(true),
			getSubtasks: jest.fn().mockResolvedValue([]),
			createSubtask: jest.fn().mockResolvedValue({ id: 1, title: 'Test Subtask' }),
			updateSubtask: jest.fn().mockResolvedValue({ id: 1, title: 'Updated Subtask' }),
			deleteSubtask: jest.fn().mockResolvedValue(true),
			saveTasks: jest.fn().mockResolvedValue(),
			validate: jest.fn().mockResolvedValue(true),
			getProviderInfo: jest.fn().mockReturnValue({ name: 'mock', version: '1.0.0' }),
			isInitialized: false,
			on: jest.fn(),
			emit: jest.fn()
		};

		// Make it extend BaseStorageProvider for validation
		Object.setPrototypeOf(mockProvider, BaseStorageProvider.prototype);
	});

	test('should initialize with default configuration', () => {
		expect(manager.currentMode).toBe('local');
		expect(manager.isInitialized).toBe(false);
	});

	test('should register a storage provider', () => {
		manager.registerProvider('mock', mockProvider);
		
		expect(manager.providers.has('mock')).toBe(true);
		expect(mockProvider.on).toHaveBeenCalledWith('error', expect.any(Function));
		expect(mockProvider.on).toHaveBeenCalledWith('taskCreated', expect.any(Function));
		expect(mockProvider.on).toHaveBeenCalledWith('taskUpdated', expect.any(Function));
		expect(mockProvider.on).toHaveBeenCalledWith('taskDeleted', expect.any(Function));
	});

	test('should throw error when registering invalid provider', () => {
		const invalidProvider = {};
		
		expect(() => {
			manager.registerProvider('invalid', invalidProvider);
		}).toThrow('Provider must extend BaseStorageProvider');
	});

	test('should get current provider', () => {
		manager.registerProvider('local', mockProvider);
		
		const currentProvider = manager.getCurrentProvider();
		expect(currentProvider).toBe(mockProvider);
	});

	test('should throw error when no provider registered for current mode', () => {
		expect(() => {
			manager.getCurrentProvider();
		}).toThrow('No provider registered for mode: local');
	});

	test('should switch storage mode', async () => {
		manager.registerProvider('local', mockProvider);
		manager.registerProvider('mock', mockProvider);
		
		await manager.switchMode('mock');
		
		expect(manager.currentMode).toBe('mock');
		expect(mockProvider.initialize).toHaveBeenCalled();
	});

	test('should throw error when switching to unregistered mode', async () => {
		await expect(manager.switchMode('nonexistent')).rejects.toThrow('No provider registered for mode: nonexistent');
	});

	test('should initialize persistence manager', async () => {
		manager.registerProvider('local', mockProvider);
		
		await manager.initialize();
		
		expect(manager.isInitialized).toBe(true);
		expect(mockProvider.initialize).toHaveBeenCalled();
	});

	test('should not initialize twice', async () => {
		manager.registerProvider('local', mockProvider);
		
		await manager.initialize();
		await manager.initialize(); // Second call
		
		expect(mockProvider.initialize).toHaveBeenCalledTimes(1);
	});

	test('should register and execute hooks', async () => {
		const hookFn = jest.fn().mockReturnValue({ modifiedField: 'test' });
		
		manager.registerHook('beforeGetTasks', hookFn);
		
		const context = { options: {} };
		const result = await manager.executeHooks('beforeGetTasks', context);
		
		expect(hookFn).toHaveBeenCalledWith(context);
		expect(result).toEqual({ options: {}, modifiedField: 'test' });
	});

	test('should handle hook errors gracefully', async () => {
		const errorHook = jest.fn().mockRejectedValue(new Error('Hook error'));
		const successHook = jest.fn().mockReturnValue({ success: true });
		
		manager.registerHook('beforeGetTasks', errorHook);
		manager.registerHook('beforeGetTasks', successHook);
		
		const context = { options: {} };
		const result = await manager.executeHooks('beforeGetTasks', context);
		
		expect(result).toEqual({ options: {}, success: true });
	});

	describe('CRUD operations', () => {
		beforeEach(async () => {
			manager.registerProvider('local', mockProvider);
		});

		test('should get all tasks', async () => {
			const mockTasks = [{ id: 1, title: 'Task 1' }];
			mockProvider.getTasks.mockResolvedValue(mockTasks);
			
			const tasks = await manager.getTasks();
			
			expect(tasks).toEqual(mockTasks);
			expect(mockProvider.getTasks).toHaveBeenCalledWith({});
		});

		test('should get a specific task', async () => {
			const mockTask = { id: 1, title: 'Task 1' };
			mockProvider.getTask.mockResolvedValue(mockTask);
			
			const task = await manager.getTask(1);
			
			expect(task).toEqual(mockTask);
			expect(mockProvider.getTask).toHaveBeenCalledWith(1, {});
		});

		test('should create a task', async () => {
			const taskData = { title: 'New Task' };
			const mockTask = { id: 1, ...taskData };
			mockProvider.createTask.mockResolvedValue(mockTask);
			
			const task = await manager.createTask(taskData);
			
			expect(task).toEqual(mockTask);
			expect(mockProvider.createTask).toHaveBeenCalledWith(taskData, {});
		});

		test('should update a task', async () => {
			const updateData = { title: 'Updated Task' };
			const mockTask = { id: 1, ...updateData };
			mockProvider.updateTask.mockResolvedValue(mockTask);
			
			const task = await manager.updateTask(1, updateData);
			
			expect(task).toEqual(mockTask);
			expect(mockProvider.updateTask).toHaveBeenCalledWith(1, updateData, {});
		});

		test('should delete a task', async () => {
			mockProvider.deleteTask.mockResolvedValue(true);
			
			const result = await manager.deleteTask(1);
			
			expect(result).toBe(true);
			expect(mockProvider.deleteTask).toHaveBeenCalledWith(1, {});
		});

		test('should save tasks', async () => {
			const tasks = [{ id: 1, title: 'Task 1' }];
			
			await manager.saveTasks(tasks);
			
			expect(mockProvider.saveTasks).toHaveBeenCalledWith(tasks, {});
		});

		test('should handle operation errors', async () => {
			const error = new Error('Provider error');
			mockProvider.getTasks.mockRejectedValue(error);
			
			await expect(manager.getTasks()).rejects.toThrow('Provider error');
		});
	});

	test('should validate provider', async () => {
		manager.registerProvider('local', mockProvider);
		
		const isValid = await manager.validate();
		
		expect(isValid).toBe(true);
		expect(mockProvider.validate).toHaveBeenCalled();
	});

	test('should return provider info', () => {
		manager.registerProvider('local', mockProvider);
		
		const info = manager.getProviderInfo();
		
		expect(info).toEqual({
			mode: 'local',
			name: 'mock',
			version: '1.0.0',
			isInitialized: false
		});
	});

	test('should return error when getting provider info for unregistered mode', () => {
		const info = manager.getProviderInfo();
		
		expect(info).toEqual({
			mode: 'local',
			error: 'No provider registered for mode: local',
			isInitialized: false
		});
	});

	test('should get all providers', () => {
		manager.registerProvider('local', mockProvider);
		manager.registerProvider('mock', mockProvider);
		
		const providers = manager.getAllProviders();
		
		expect(providers).toHaveLength(2);
		expect(providers[0]).toEqual({
			mode: 'local',
			name: 'mock',
			version: '1.0.0',
			isInitialized: false,
			isActive: true
		});
		expect(providers[1]).toEqual({
			mode: 'mock',
			name: 'mock',
			version: '1.0.0',
			isInitialized: false,
			isActive: false
		});
	});

	test('should emit events', async () => {
		const eventSpy = jest.fn();
		manager.on('taskCreated', eventSpy);
		manager.registerProvider('local', mockProvider);
		
		const taskData = { title: 'New Task' };
		await manager.createTask(taskData);
		
		expect(eventSpy).toHaveBeenCalledWith({ task: expect.any(Object) });
	});
}); 