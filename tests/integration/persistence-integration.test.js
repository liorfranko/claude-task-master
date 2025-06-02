/**
 * Integration tests for the Persistence Manager and LocalStorageProvider
 * Tests actual file operations without mocking
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { PersistenceManager } from '../../scripts/modules/persistence-manager.js';
import LocalStorageProvider from '../../scripts/modules/storage/local-storage-provider.js';

describe('Persistence Manager Integration Tests', () => {
	let tempDir;
	let tempTasksPath;
	let persistenceManager;

	beforeEach(() => {
		// Create temporary directory for tests
		tempDir = fs.mkdtempSync(path.join(tmpdir(), 'taskmaster-integration-'));
		tempTasksPath = path.join(tempDir, 'tasks.json');
		
		// Create persistence manager with local provider
		persistenceManager = new PersistenceManager({
			persistence: { mode: 'local' }
		});
		
		const localProvider = new LocalStorageProvider({
			tasksPath: tempTasksPath
		});
		
		persistenceManager.registerProvider('local', localProvider);
	});

	afterEach(() => {
		// Clean up temporary directory
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('should initialize persistence manager with local provider', async () => {
		await persistenceManager.initialize();
		
		expect(persistenceManager.isInitialized).toBe(true);
		expect(fs.existsSync(tempTasksPath)).toBe(true);
		
		const tasksData = JSON.parse(fs.readFileSync(tempTasksPath, 'utf8'));
		expect(tasksData).toEqual({ tasks: [] });
	});

	test('should create and retrieve tasks', async () => {
		await persistenceManager.initialize();
		
		const taskData = {
			title: 'Test Task',
			description: 'Integration test task',
			priority: 'high'
		};
		
		const createdTask = await persistenceManager.createTask(taskData);
		
		expect(createdTask.id).toBe(1);
		expect(createdTask.title).toBe('Test Task');
		expect(createdTask.status).toBe('pending');
		expect(createdTask.priority).toBe('high');
		
		// Verify task is persisted to file
		const tasksData = JSON.parse(fs.readFileSync(tempTasksPath, 'utf8'));
		expect(tasksData.tasks).toHaveLength(1);
		expect(tasksData.tasks[0].title).toBe('Test Task');
		
		// Retrieve task
		const retrievedTask = await persistenceManager.getTask(1);
		expect(retrievedTask).toEqual(createdTask);
		
		// Get all tasks
		const allTasks = await persistenceManager.getTasks();
		expect(allTasks).toHaveLength(1);
		expect(allTasks[0]).toEqual(createdTask);
	});

	test('should update tasks', async () => {
		await persistenceManager.initialize();
		
		// Create a task
		const taskData = { title: 'Original Task', status: 'pending' };
		const createdTask = await persistenceManager.createTask(taskData);
		
		// Update the task
		const updateData = { title: 'Updated Task', status: 'done' };
		const updatedTask = await persistenceManager.updateTask(createdTask.id, updateData);
		
		expect(updatedTask.id).toBe(createdTask.id);
		expect(updatedTask.title).toBe('Updated Task');
		expect(updatedTask.status).toBe('done');
		
		// Verify persistence
		const retrievedTask = await persistenceManager.getTask(createdTask.id);
		expect(retrievedTask.title).toBe('Updated Task');
		expect(retrievedTask.status).toBe('done');
	});

	test('should delete tasks', async () => {
		await persistenceManager.initialize();
		
		// Create two tasks
		await persistenceManager.createTask({ title: 'Task 1' });
		const task2 = await persistenceManager.createTask({ title: 'Task 2' });
		
		// Delete first task
		const deleted = await persistenceManager.deleteTask(1);
		expect(deleted).toBe(true);
		
		// Verify deletion
		const allTasks = await persistenceManager.getTasks();
		expect(allTasks).toHaveLength(1);
		expect(allTasks[0].id).toBe(2);
		expect(allTasks[0].title).toBe('Task 2');
		
		// Try to get deleted task
		const deletedTask = await persistenceManager.getTask(1);
		expect(deletedTask).toBeNull();
	});

	test('should handle task dependencies', async () => {
		await persistenceManager.initialize();
		
		// Create base task
		const baseTask = await persistenceManager.createTask({ title: 'Base Task' });
		
		// Create dependent task
		const dependentTask = await persistenceManager.createTask({
			title: 'Dependent Task',
			dependencies: [baseTask.id]
		});
		
		expect(dependentTask.dependencies).toEqual([baseTask.id]);
		
		// Try to create task with invalid dependency
		await expect(persistenceManager.createTask({
			title: 'Invalid Task',
			dependencies: [999]
		})).rejects.toThrow('Invalid dependencies: 999');
	});

	test('should filter tasks by status', async () => {
		await persistenceManager.initialize();
		
		// Create tasks with different statuses
		await persistenceManager.createTask({ title: 'Pending Task', status: 'pending' });
		await persistenceManager.createTask({ title: 'Done Task', status: 'done' });
		await persistenceManager.createTask({ title: 'In Progress Task', status: 'in-progress' });
		
		// Filter by status
		const pendingTasks = await persistenceManager.getTasks({ status: 'pending' });
		expect(pendingTasks).toHaveLength(1);
		expect(pendingTasks[0].title).toBe('Pending Task');
		
		const doneTasks = await persistenceManager.getTasks({ status: 'done' });
		expect(doneTasks).toHaveLength(1);
		expect(doneTasks[0].title).toBe('Done Task');
	});

	test('should handle subtasks', async () => {
		await persistenceManager.initialize();
		
		// Create parent task
		const parentTask = await persistenceManager.createTask({ title: 'Parent Task' });
		
		// Create subtask through provider (LocalStorageProvider handles subtasks)
		const provider = persistenceManager.getCurrentProvider();
		const subtask = await provider.createSubtask(parentTask.id, {
			title: 'Test Subtask',
			description: 'A test subtask'
		});
		
		expect(subtask.id).toBe(1);
		expect(subtask.title).toBe('Test Subtask');
		
		// Get subtasks
		const subtasks = await provider.getSubtasks(parentTask.id);
		expect(subtasks).toHaveLength(1);
		expect(subtasks[0]).toEqual(subtask);
	});

	test('should handle provider switching', async () => {
		const tempTasksPath2 = path.join(tempDir, 'tasks2.json');
		
		// Register second local provider
		const localProvider2 = new LocalStorageProvider({
			tasksPath: tempTasksPath2
		});
		persistenceManager.registerProvider('local2', localProvider2);
		
		// Initialize and create task in default provider
		await persistenceManager.initialize();
		await persistenceManager.createTask({ title: 'Task in Provider 1' });
		
		// Switch to second provider
		await persistenceManager.switchMode('local2');
		await persistenceManager.createTask({ title: 'Task in Provider 2' });
		
		// Verify tasks are in different files
		const tasks1 = JSON.parse(fs.readFileSync(tempTasksPath, 'utf8'));
		const tasks2 = JSON.parse(fs.readFileSync(tempTasksPath2, 'utf8'));
		
		expect(tasks1.tasks).toHaveLength(1);
		expect(tasks1.tasks[0].title).toBe('Task in Provider 1');
		
		expect(tasks2.tasks).toHaveLength(1);
		expect(tasks2.tasks[0].title).toBe('Task in Provider 2');
	});

	test('should emit events for operations', async () => {
		await persistenceManager.initialize();
		
		const taskCreatedSpy = jest.fn();
		const taskUpdatedSpy = jest.fn();
		const taskDeletedSpy = jest.fn();
		
		persistenceManager.on('taskCreated', taskCreatedSpy);
		persistenceManager.on('taskUpdated', taskUpdatedSpy);
		persistenceManager.on('taskDeleted', taskDeletedSpy);
		
		// Create task
		const task = await persistenceManager.createTask({ title: 'Event Test Task' });
		expect(taskCreatedSpy).toHaveBeenCalledWith({ task });
		
		// Update task
		const updatedTask = await persistenceManager.updateTask(task.id, { title: 'Updated Event Task' });
		expect(taskUpdatedSpy).toHaveBeenCalledWith({ task: updatedTask });
		
		// Delete task
		await persistenceManager.deleteTask(task.id);
		expect(taskDeletedSpy).toHaveBeenCalledWith({ taskId: task.id });
	});

	test('should validate provider configuration', async () => {
		await persistenceManager.initialize();
		
		const provider = persistenceManager.getCurrentProvider();
		const isValid = await provider.validate();
		expect(isValid).toBe(true);
		
		// Test invalid provider
		const invalidProvider = new LocalStorageProvider({
			tasksPath: '/invalid/path/tasks.json'
		});
		const isInvalid = await invalidProvider.validate();
		expect(isInvalid).toBe(false);
	});

	test('should provide provider information', () => {
		const providerInfo = persistenceManager.getProviderInfo();
		
		expect(providerInfo).toEqual({
			mode: 'local',
			name: 'local',
			version: '1.0.0',
			capabilities: ['read', 'write', 'delete', 'batch'],
			tasksPath: tempTasksPath,
			tasksCount: 0,
			lastModified: null,
			isInitialized: false
		});
	});

	test('should handle batch operations', async () => {
		await persistenceManager.initialize();
		
		const tasks = [
			{ id: 1, title: 'Batch Task 1', status: 'pending' },
			{ id: 2, title: 'Batch Task 2', status: 'done' },
			{ id: 3, title: 'Batch Task 3', status: 'in-progress' }
		];
		
		await persistenceManager.saveTasks(tasks);
		
		// Verify tasks were saved
		const retrievedTasks = await persistenceManager.getTasks();
		expect(retrievedTasks).toHaveLength(3);
		expect(retrievedTasks.map(t => t.title)).toEqual([
			'Batch Task 1',
			'Batch Task 2', 
			'Batch Task 3'
		]);
	});

	test('should handle hooks for operations', async () => {
		await persistenceManager.initialize();
		
		const beforeGetTasksHook = jest.fn((context) => ({ 
			...context, 
			options: { ...context.options, beforeHookCalled: true } 
		}));
		
		const afterGetTasksHook = jest.fn((context) => ({ 
			...context, 
			afterHookCalled: true 
		}));
		
		persistenceManager.registerHook('beforeGetTasks', beforeGetTasksHook);
		persistenceManager.registerHook('afterGetTasks', afterGetTasksHook);
		
		// Create a task first
		await persistenceManager.createTask({ title: 'Hook Test Task' });
		
		// Get tasks (should trigger hooks)
		const tasks = await persistenceManager.getTasks();
		
		expect(beforeGetTasksHook).toHaveBeenCalled();
		expect(afterGetTasksHook).toHaveBeenCalled();
		expect(tasks).toHaveLength(1);
	});
}); 