/**
 * Unit tests for the LocalStorageProvider
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

// Mock the entire utils module properly before any imports
const mockUtils = {
	readJSON: jest.fn(),
	writeJSON: jest.fn(),
	log: jest.fn(),
	findTaskById: jest.fn(),
	taskExists: jest.fn(),
	enableSilentMode: jest.fn(),
	disableSilentMode: jest.fn(),
	isSilentMode: jest.fn().mockReturnValue(false),
	resolveEnvVariable: jest.fn(),
	findProjectRoot: jest.fn()
};

// Mock all modules before importing anything
jest.unstable_mockModule('../../scripts/modules/utils.js', () => mockUtils);

// Now import the modules after setting up the mocks
const { default: LocalStorageProvider } = await import('../../scripts/modules/storage/local-storage-provider.js');
const { BaseStorageProvider } = await import('../../scripts/modules/persistence-manager.js');

describe('LocalStorageProvider', () => {
	let provider;
	let tempDir;
	let tempTasksPath;

	beforeEach(() => {
		// Create temporary directory for tests
		tempDir = fs.mkdtempSync(path.join(tmpdir(), 'taskmaster-test-'));
		tempTasksPath = path.join(tempDir, 'tasks.json');
		
		provider = new LocalStorageProvider({
			tasksPath: tempTasksPath
		});

		// Reset all mocks
		jest.clearAllMocks();
		Object.values(mockUtils).forEach(mockFn => {
			if (typeof mockFn === 'function') {
				mockFn.mockClear();
			}
		});
	});

	afterEach(() => {
		// Clean up temporary directory
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('should extend BaseStorageProvider', () => {
		expect(provider).toBeInstanceOf(BaseStorageProvider);
	});

	test('should initialize with default configuration', () => {
		const defaultProvider = new LocalStorageProvider();
		expect(defaultProvider.tasksPath).toBe(path.join(process.cwd(), 'tasks', 'tasks.json'));
	});

	test('should initialize provider and create tasks.json if it does not exist', async () => {
		// Mock that file doesn't exist initially
		jest.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
			if (filePath === tempTasksPath) return false; // File doesn't exist
			if (filePath === path.dirname(tempTasksPath)) return false; // Dir doesn't exist initially
			return true; // Other paths exist
		});
		
		jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
		jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
		
		// Mock the utils functions
		mockUtils.writeJSON.mockImplementation(() => {});
		mockUtils.readJSON.mockReturnValue({ tasks: [] });
		
		await provider.initialize();
		
		expect(provider.isInitialized).toBe(true);
		expect(mockUtils.writeJSON).toHaveBeenCalledWith(tempTasksPath, { tasks: [] });
		expect(mockUtils.readJSON).toHaveBeenCalledWith(tempTasksPath);
	});

	test('should load existing tasks.json during initialization', async () => {
		const mockData = { tasks: [{ id: 1, title: 'Test Task' }] };
		
		// Mock that file exists
		jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
		jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
		mockUtils.readJSON.mockReturnValue(mockData);
		
		await provider.initialize();
		
		expect(mockUtils.readJSON).toHaveBeenCalledWith(tempTasksPath);
		expect(provider.tasksData).toEqual(mockData);
	});

	test('should handle initialization errors gracefully', async () => {
		jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
		jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
		mockUtils.readJSON.mockImplementation(() => {
			throw new Error('File read error');
		});
		
		await expect(provider.initialize()).rejects.toThrow('File read error');
	});

	test('should return provider info', () => {
		const info = provider.getProviderInfo();
		
		expect(info.name).toBe('local');
		expect(info.version).toBe('1.0.0');
		expect(info.tasksPath).toBe(tempTasksPath);
		expect(info.capabilities).toContain('read');
		expect(info.capabilities).toContain('write');
		expect(info.capabilities).toContain('delete');
		expect(info.capabilities).toContain('batch');
	});

	test('should set new tasks path', async () => {
		const newTasksPath = path.join(tempDir, 'new-tasks.json');
		
		// Mock file operations for the new path
		jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
		jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
		mockUtils.readJSON.mockReturnValue({ tasks: [] });
		
		await provider.setTasksPath(newTasksPath);
		
		expect(provider.tasksPath).toBe(newTasksPath);
		expect(mockUtils.readJSON).toHaveBeenCalledWith(newTasksPath);
	});

	test('should reload tasks data', async () => {
		// Setup initial state
		jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
		mockUtils.readJSON.mockReturnValue({ tasks: [{ id: 1, title: 'Test Task' }] });
		
		await provider.reload();
		
		expect(mockUtils.readJSON).toHaveBeenCalledWith(tempTasksPath);
	});

	test('should return statistics', async () => {
		// Mock initialization
		jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
		jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
		mockUtils.readJSON.mockReturnValue({ 
			tasks: [
				{ id: 1, title: 'Task 1', status: 'pending', priority: 'high' },
				{ id: 2, title: 'Task 2', status: 'done', priority: 'medium' },
				{ id: 3, title: 'Task 3', status: 'pending', priority: 'high' }
			] 
		});
		
		await provider.initialize();
		const stats = provider.getStats();
		
		expect(stats.total).toBe(3);
		expect(stats.byStatus.pending).toBe(2);
		expect(stats.byStatus.done).toBe(1);
		expect(stats.byPriority.high).toBe(2);
		expect(stats.byPriority.medium).toBe(1);
	});

	describe('getTasks', () => {
		beforeEach(async () => {
			const mockData = {
				tasks: [
					{ id: 1, title: 'Task 1', status: 'pending' },
					{ id: 2, title: 'Task 2', status: 'done' },
					{ id: 3, title: 'Task 3', status: 'pending' }
				]
			};
			
			jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.readJSON.mockReturnValue(mockData);
			
			await provider.initialize();
		});

		test('should return all tasks when no filter provided', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const tasks = await provider.getTasks();
			expect(tasks).toHaveLength(3);
		});

		test('should filter tasks by status', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const tasks = await provider.getTasks({ status: 'pending' });
			expect(tasks).toHaveLength(2);
			expect(tasks.every(task => task.status === 'pending')).toBe(true);
		});

		test('should filter tasks by IDs', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const tasks = await provider.getTasks({ ids: [1, 3] });
			expect(tasks).toHaveLength(2);
			expect(tasks.map(t => t.id)).toEqual([1, 3]);
		});

		test('should filter tasks by search term', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const tasks = await provider.getTasks({ search: 'Task 1' });
			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe('Task 1');
		});
	});

	describe('getTask', () => {
		beforeEach(async () => {
			const mockData = { tasks: [{ id: 1, title: 'Task 1' }] };
			
			jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.readJSON.mockReturnValue(mockData);
			
			await provider.initialize();
		});

		test('should get a task by ID', async () => {
			const mockTask = { id: 1, title: 'Task 1' };
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.findTaskById.mockReturnValue({ task: mockTask });
			
			const task = await provider.getTask(1);
			
			expect(task).toEqual(mockTask);
			expect(mockUtils.findTaskById).toHaveBeenCalledWith(provider.tasksData.tasks, 1, null, undefined);
		});

		test('should return null for non-existent task', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.findTaskById.mockReturnValue({ task: null });
			
			const task = await provider.getTask(999);
			
			expect(task).toBeNull();
		});
	});

	describe('createTask', () => {
		beforeEach(async () => {
			const mockData = { tasks: [{ id: 1, title: 'Existing Task' }] };
			
			jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.readJSON.mockReturnValue(mockData);
			mockUtils.writeJSON.mockImplementation(() => {});
			
			await provider.initialize();
		});

		test('should create a new task with auto-generated ID', async () => {
			const taskData = { title: 'New Task', priority: 'high' };
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const task = await provider.createTask(taskData);
			
			expect(task.id).toBe(2);
			expect(task.title).toBe('New Task');
			expect(task.priority).toBe('high');
			expect(task.status).toBe('pending');
			expect(mockUtils.writeJSON).toHaveBeenCalled();
		});

		test('should validate dependencies before creating', async () => {
			const taskData = { 
				title: 'Dependent Task', 
				dependencies: [999] // Non-existent dependency
			};
			
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.taskExists.mockReturnValue(false);
			
			await expect(provider.createTask(taskData)).rejects.toThrow('Invalid dependencies: 999');
		});

		test('should emit taskCreated event', async () => {
			const taskData = { title: 'New Task' };
			const eventSpy = jest.fn();
			provider.on('taskCreated', eventSpy);
			
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.taskExists.mockReturnValue(true);
			
			const task = await provider.createTask(taskData);
			
			expect(eventSpy).toHaveBeenCalledWith(task);
		});
	});

	describe('updateTask', () => {
		beforeEach(async () => {
			const mockData = { tasks: [{ id: 1, title: 'Original Task', status: 'pending' }] };
			
			jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.readJSON.mockReturnValue(mockData);
			mockUtils.writeJSON.mockImplementation(() => {});
			
			await provider.initialize();
		});

		test('should update an existing task', async () => {
			const updateData = { title: 'Updated Task', status: 'done' };
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.findTaskById.mockReturnValue({ task: provider.tasksData.tasks[0] });
			
			const updatedTask = await provider.updateTask(1, updateData);
			
			expect(updatedTask.title).toBe('Updated Task');
			expect(updatedTask.status).toBe('done');
			expect(mockUtils.writeJSON).toHaveBeenCalled();
		});

		test('should throw error for non-existent task', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.findTaskById.mockReturnValue({ task: null });
			
			await expect(provider.updateTask(999, { title: 'Updated' }))
				.rejects.toThrow('Task 999 not found');
		});

		test('should validate dependencies when updating', async () => {
			const updateData = { dependencies: [999] }; // Non-existent dependency
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.findTaskById.mockReturnValue({ task: provider.tasksData.tasks[0] });
			mockUtils.taskExists.mockReturnValue(false);
			
			await expect(provider.updateTask(1, updateData))
				.rejects.toThrow('Invalid dependencies: 999');
		});

		test('should emit taskUpdated event', async () => {
			const updateData = { title: 'Updated Task' };
			const eventSpy = jest.fn();
			provider.on('taskUpdated', eventSpy);
			
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.findTaskById.mockReturnValue({ task: provider.tasksData.tasks[0] });
			mockUtils.taskExists.mockReturnValue(true);
			
			const updatedTask = await provider.updateTask(1, updateData);
			
			expect(eventSpy).toHaveBeenCalledWith(updatedTask);
		});
	});

	describe('deleteTask', () => {
		beforeEach(async () => {
			const mockData = { 
				tasks: [
					{ id: 1, title: 'Task 1' },
					{ id: 2, title: 'Task 2', dependencies: [1] }
				] 
			};
			
			jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.readJSON.mockReturnValue(mockData);
			mockUtils.writeJSON.mockImplementation(() => {});
			
			await provider.initialize();
		});

		test('should delete an existing task', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const result = await provider.deleteTask(1);
			
			expect(result).toBe(true);
			expect(provider.tasksData.tasks).toHaveLength(1);
			expect(provider.tasksData.tasks[0].id).toBe(2);
			expect(mockUtils.writeJSON).toHaveBeenCalled();
		});

		test('should clean up dependencies when deleting task', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			await provider.deleteTask(1);
			
			// Task 2 should have its dependency on task 1 removed
			const remainingTask = provider.tasksData.tasks.find(t => t.id === 2);
			expect(remainingTask.dependencies).toEqual([]);
		});

		test('should return false for non-existent task', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const result = await provider.deleteTask(999);
			
			expect(result).toBe(false);
		});

		test('should emit taskDeleted event', async () => {
			const eventSpy = jest.fn();
			provider.on('taskDeleted', eventSpy);
			
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			await provider.deleteTask(1);
			
			expect(eventSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('subtask operations', () => {
		beforeEach(async () => {
			const mockData = { 
				tasks: [{ 
					id: 1, 
					title: 'Parent Task',
					subtasks: [{ id: 1, title: 'Existing Subtask' }]
				}] 
			};
			
			jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.readJSON.mockReturnValue(mockData);
			mockUtils.writeJSON.mockImplementation(() => {});
			
			await provider.initialize();
		});

		test('should get subtasks for a parent task', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const subtasks = await provider.getSubtasks(1);
			
			expect(subtasks).toHaveLength(1);
			expect(subtasks[0].title).toBe('Existing Subtask');
		});

		test('should return empty array for task without subtasks', async () => {
			provider.tasksData.tasks[0].subtasks = [];
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const subtasks = await provider.getSubtasks(1);
			
			expect(subtasks).toEqual([]);
		});

		test('should create a new subtask', async () => {
			const subtaskData = { title: 'New Subtask', description: 'Test description' };
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const subtask = await provider.createSubtask(1, subtaskData);
			
			expect(subtask.id).toBe(2);
			expect(subtask.title).toBe('New Subtask');
			expect(mockUtils.writeJSON).toHaveBeenCalled();
		});

		test('should update a subtask', async () => {
			const updateData = { title: 'Updated Subtask' };
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const updatedSubtask = await provider.updateSubtask(1, 1, updateData);
			
			expect(updatedSubtask.title).toBe('Updated Subtask');
			expect(mockUtils.writeJSON).toHaveBeenCalled();
		});

		test('should delete a subtask', async () => {
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			
			const result = await provider.deleteSubtask(1, 1);
			
			expect(result).toBe(true);
			expect(provider.tasksData.tasks[0].subtasks).toHaveLength(0);
			expect(mockUtils.writeJSON).toHaveBeenCalled();
		});
	});

	describe('saveTasks', () => {
		test('should save tasks array', async () => {
			const tasks = [
				{ id: 1, title: 'Task 1' },
				{ id: 2, title: 'Task 2' }
			];
			
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.writeJSON.mockImplementation(() => {});
			
			await provider.saveTasks(tasks);
			
			expect(mockUtils.writeJSON).toHaveBeenCalledWith(tempTasksPath, { tasks });
		});

		test('should validate tasks structure', async () => {
			const invalidTasks = "invalid data";
			
			await expect(provider.saveTasks(invalidTasks))
				.rejects.toThrow('Tasks must be an array');
		});

		test('should emit tasksSaved event', async () => {
			const tasks = [{ id: 1, title: 'Task 1' }];
			const eventSpy = jest.fn();
			provider.on('tasksSaved', eventSpy);
			
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.writeJSON.mockImplementation(() => {});
			
			await provider.saveTasks(tasks);
			
			expect(eventSpy).toHaveBeenCalledWith(tasks);
		});
	});

	describe('validate', () => {
		test('should validate provider configuration', async () => {
			jest.spyOn(fs, 'existsSync').mockImplementation(() => true);
			jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() });
			mockUtils.readJSON.mockReturnValue({ tasks: [] });
			
			const isValid = await provider.validate();
			
			expect(isValid).toBe(true);
			expect(mockUtils.readJSON).toHaveBeenCalledWith(tempTasksPath);
		});

		test('should return false for invalid configuration', async () => {
			// Set an invalid tasks path
			provider.tasksPath = '/invalid';
			
			const isValid = await provider.validate();
			
			expect(isValid).toBe(false);
		});
	});
}); 