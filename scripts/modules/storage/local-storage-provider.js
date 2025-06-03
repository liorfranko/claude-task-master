/**
 * local-storage-provider.js
 * Local storage provider implementation for Task Master
 * Handles tasks.json file-based storage operations
 */

import fs from 'fs';
import path from 'path';
import { BaseStorageProvider } from '../persistence-manager.js';
import { readJSON, writeJSON, log, findTaskById, taskExists } from '../utils.js';

/**
 * Local Storage Provider
 * Implements file-based storage using tasks.json
 */
class LocalStorageProvider extends BaseStorageProvider {
	constructor(config = {}) {
		super(config);
		this.tasksPath = config.tasksPath || path.join(process.cwd(), 'tasks', 'tasks.json');
		this.tasksData = null;
		this.lastModified = null;
	}

	/**
	 * Initialize the local storage provider
	 * @returns {Promise<void>}
	 */
	async initialize() {
		if (this.isInitialized) {
			return;
		}

		// Ensure the tasks directory exists
		const tasksDir = path.dirname(this.tasksPath);
		if (!fs.existsSync(tasksDir)) {
			fs.mkdirSync(tasksDir, { recursive: true });
			log('debug', `Created tasks directory: ${tasksDir}`);
		}

		// Initialize tasks.json if it doesn't exist
		if (!fs.existsSync(this.tasksPath)) {
			const initialData = { tasks: [] };
			writeJSON(this.tasksPath, initialData);
			log('info', `Created new tasks.json file at: ${this.tasksPath}`);
		}

		// Load initial data
		await this._loadTasksData();
		
		this.isInitialized = true;
		log('debug', `LocalStorageProvider initialized with ${this.tasksData?.tasks?.length || 0} tasks`);
	}

	/**
	 * Load tasks data from file with caching
	 * @private
	 * @returns {Promise<void>}
	 */
	async _loadTasksData() {
		try {
			// Check if file has been modified since last load
			const stats = fs.statSync(this.tasksPath);
			if (this.lastModified && stats.mtime <= this.lastModified) {
				return; // Use cached data
			}

			this.tasksData = readJSON(this.tasksPath);
			this.lastModified = stats.mtime;

			if (!this.tasksData || !this.tasksData.tasks) {
				throw new Error('Invalid tasks.json structure');
			}

			log('debug', `Loaded ${this.tasksData.tasks.length} tasks from ${this.tasksPath}`);
		} catch (error) {
			log('error', `Failed to load tasks data: ${error.message}`);
			// Initialize with empty structure on error
			this.tasksData = { tasks: [] };
			throw error;
		}
	}

	/**
	 * Save tasks data to file
	 * @private
	 * @returns {Promise<void>}
	 */
	async _saveTasksData() {
		try {
			writeJSON(this.tasksPath, this.tasksData);
			
			// Update last modified time
			const stats = fs.statSync(this.tasksPath);
			this.lastModified = stats.mtime;
			
			log('debug', `Saved ${this.tasksData.tasks.length} tasks to ${this.tasksPath}`);
		} catch (error) {
			log('error', `Failed to save tasks data: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get all tasks
	 * @param {Object} options - Query options
	 * @returns {Promise<Array>} Array of tasks
	 */
	async getTasks(options = {}) {
		await this._loadTasksData();
		
		let tasks = [...this.tasksData.tasks];

		// Apply status filter if provided
		if (options.status) {
			tasks = tasks.filter(task => 
				task.status && task.status.toLowerCase() === options.status.toLowerCase()
			);
		}

		// Apply ID filter if provided
		if (options.ids && Array.isArray(options.ids)) {
			tasks = tasks.filter(task => options.ids.includes(task.id));
		}

		// Apply search filter if provided
		if (options.search) {
			const searchTerm = options.search.toLowerCase();
			tasks = tasks.filter(task =>
				(task.title && task.title.toLowerCase().includes(searchTerm)) ||
				(task.description && task.description.toLowerCase().includes(searchTerm))
			);
		}

		return tasks;
	}

	/**
	 * Get a specific task by ID
	 * @param {string|number} id - Task ID
	 * @param {Object} options - Query options
	 * @returns {Promise<Object|null>} Task object or null if not found
	 */
	async getTask(id, options = {}) {
		await this._loadTasksData();
		
		const result = findTaskById(this.tasksData.tasks, id, null, options.statusFilter);
		return result.task;
	}

	/**
	 * Create a new task
	 * @param {Object} taskData - Task data to create
	 * @param {Object} options - Creation options
	 * @returns {Promise<Object>} Created task object
	 */
	async createTask(taskData, options = {}) {
		await this._loadTasksData();

		// Generate new task ID
		const highestId = this.tasksData.tasks.length > 0 
			? Math.max(...this.tasksData.tasks.map(t => t.id))
			: 0;
		
		const newTask = {
			id: highestId + 1,
			title: taskData.title || 'Untitled Task',
			description: taskData.description || '',
			status: taskData.status || 'pending',
			priority: taskData.priority || 'medium',
			dependencies: taskData.dependencies || [],
			details: taskData.details || '',
			testStrategy: taskData.testStrategy || '',
			subtasks: taskData.subtasks || [],
			...taskData // Allow additional fields to be passed through
		};

		// Validate dependencies exist
		if (newTask.dependencies.length > 0) {
			const invalidDeps = newTask.dependencies.filter(depId => 
				!taskExists(this.tasksData.tasks, depId)
			);
			
			if (invalidDeps.length > 0) {
				throw new Error(`Invalid dependencies: ${invalidDeps.join(', ')}`);
			}
		}

		this.tasksData.tasks.push(newTask);
		await this._saveTasksData();

		this.emit('taskCreated', newTask);
		return newTask;
	}

	/**
	 * Update an existing task
	 * @param {string|number} id - Task ID to update
	 * @param {Object} updateData - Data to update
	 * @param {Object} options - Update options
	 * @returns {Promise<Object>} Updated task object
	 */
	async updateTask(id, updateData, options = {}) {
		await this._loadTasksData();

		// Handle subtask updates
		if (typeof id === 'string' && id.includes('.')) {
			return await this._updateSubtask(id, updateData, options);
		}

		const taskIndex = this.tasksData.tasks.findIndex(t => t.id === parseInt(id, 10));
		
		if (taskIndex === -1) {
			throw new Error(`Task ${id} not found`);
		}

		const originalTask = this.tasksData.tasks[taskIndex];
		const updatedTask = { ...originalTask, ...updateData };

		// Validate dependencies if they were updated
		if (updateData.dependencies) {
			const invalidDeps = updateData.dependencies.filter(depId => 
				depId !== updatedTask.id && !taskExists(this.tasksData.tasks, depId)
			);
			
			if (invalidDeps.length > 0) {
				throw new Error(`Invalid dependencies: ${invalidDeps.join(', ')}`);
			}
		}

		this.tasksData.tasks[taskIndex] = updatedTask;
		await this._saveTasksData();

		this.emit('taskUpdated', updatedTask);
		return updatedTask;
	}

	/**
	 * Update a subtask
	 * @private
	 * @param {string} subtaskId - Subtask ID (format: "parentId.subtaskId")
	 * @param {Object} updateData - Data to update
	 * @param {Object} options - Update options
	 * @returns {Promise<Object>} Updated subtask object
	 */
	async _updateSubtask(subtaskId, updateData, options = {}) {
		const [parentId, subId] = subtaskId.split('.').map(id => parseInt(id, 10));
		
		const parentTask = this.tasksData.tasks.find(t => t.id === parentId);
		if (!parentTask) {
			throw new Error(`Parent task ${parentId} not found`);
		}

		if (!parentTask.subtasks) {
			parentTask.subtasks = [];
		}

		const subtaskIndex = parentTask.subtasks.findIndex(st => st.id === subId);
		if (subtaskIndex === -1) {
			throw new Error(`Subtask ${subtaskId} not found`);
		}

		const originalSubtask = parentTask.subtasks[subtaskIndex];
		const updatedSubtask = { ...originalSubtask, ...updateData };

		parentTask.subtasks[subtaskIndex] = updatedSubtask;
		await this._saveTasksData();

		this.emit('subtaskUpdated', { parentId, subtask: updatedSubtask });
		return updatedSubtask;
	}

	/**
	 * Delete a task
	 * @param {string|number} id - Task ID to delete
	 * @param {Object} options - Deletion options
	 * @returns {Promise<boolean>} True if deleted successfully
	 */
	async deleteTask(id, options = {}) {
		await this._loadTasksData();

		// Handle subtask deletion
		if (typeof id === 'string' && id.includes('.')) {
			return await this._deleteSubtask(id, options);
		}

		const taskIndex = this.tasksData.tasks.findIndex(t => t.id === parseInt(id, 10));
		
		if (taskIndex === -1) {
			return false; // Task not found
		}

		// Remove the task
		const deletedTask = this.tasksData.tasks.splice(taskIndex, 1)[0];

		// Clean up dependencies in other tasks
		if (!options.skipDependencyCleanup) {
			this.tasksData.tasks.forEach(task => {
				if (task.dependencies) {
					task.dependencies = task.dependencies.filter(depId => depId !== deletedTask.id);
				}
			});
		}

		await this._saveTasksData();

		this.emit('taskDeleted', deletedTask.id);
		return true;
	}

	/**
	 * Delete a subtask
	 * @private
	 * @param {string} subtaskId - Subtask ID (format: "parentId.subtaskId")
	 * @param {Object} options - Deletion options
	 * @returns {Promise<boolean>} True if deleted successfully
	 */
	async _deleteSubtask(subtaskId, options = {}) {
		const [parentId, subId] = subtaskId.split('.').map(id => parseInt(id, 10));
		
		const parentTask = this.tasksData.tasks.find(t => t.id === parentId);
		if (!parentTask || !parentTask.subtasks) {
			return false;
		}

		const subtaskIndex = parentTask.subtasks.findIndex(st => st.id === subId);
		if (subtaskIndex === -1) {
			return false;
		}

		const deletedSubtask = parentTask.subtasks.splice(subtaskIndex, 1)[0];
		await this._saveTasksData();

		this.emit('subtaskDeleted', { parentId, subtaskId: deletedSubtask.id });
		return true;
	}

	/**
	 * Get all subtasks for a parent task
	 * @param {string|number} parentId - Parent task ID
	 * @returns {Promise<Array>} Array of subtasks
	 */
	async getSubtasks(parentId) {
		await this._loadTasksData();
		
		const parentTask = this.tasksData.tasks.find(t => t.id === parseInt(parentId, 10));
		return parentTask?.subtasks || [];
	}

	/**
	 * Create a new subtask
	 * @param {string|number} parentId - Parent task ID
	 * @param {Object} subtaskData - Subtask data to create
	 * @returns {Promise<Object>} Created subtask object
	 */
	async createSubtask(parentId, subtaskData) {
		await this._loadTasksData();
		
		const parentTask = this.tasksData.tasks.find(t => t.id === parseInt(parentId, 10));
		if (!parentTask) {
			throw new Error(`Parent task ${parentId} not found`);
		}

		if (!parentTask.subtasks) {
			parentTask.subtasks = [];
		}

		// Generate new subtask ID
		const highestSubId = parentTask.subtasks.length > 0 
			? Math.max(...parentTask.subtasks.map(st => st.id))
			: 0;

		const newSubtask = {
			id: highestSubId + 1,
			title: subtaskData.title || 'Untitled Subtask',
			description: subtaskData.description || '',
			status: subtaskData.status || 'pending',
			dependencies: subtaskData.dependencies || [],
			details: subtaskData.details || '',
			...subtaskData
		};

		parentTask.subtasks.push(newSubtask);
		await this._saveTasksData();

		this.emit('subtaskCreated', { parentId, subtask: newSubtask });
		return newSubtask;
	}

	/**
	 * Update a subtask
	 * @param {string|number} parentId - Parent task ID
	 * @param {string|number} subtaskId - Subtask ID
	 * @param {Object} updateData - Data to update
	 * @returns {Promise<Object>} Updated subtask object
	 */
	async updateSubtask(parentId, subtaskId, updateData) {
		const fullSubtaskId = `${parentId}.${subtaskId}`;
		return await this._updateSubtask(fullSubtaskId, updateData);
	}

	/**
	 * Delete a subtask
	 * @param {string|number} parentId - Parent task ID
	 * @param {string|number} subtaskId - Subtask ID
	 * @returns {Promise<boolean>} True if deleted successfully
	 */
	async deleteSubtask(parentId, subtaskId) {
		const fullSubtaskId = `${parentId}.${subtaskId}`;
		return await this._deleteSubtask(fullSubtaskId);
	}

	/**
	 * Save all tasks (batch operation)
	 * @param {Array} tasks - Array of tasks to save
	 * @param {Object} options - Save options
	 * @returns {Promise<void>}
	 */
	async saveTasks(tasks, options = {}) {
		if (!Array.isArray(tasks)) {
			throw new Error('Tasks must be an array');
		}

		// Validate task structure
		for (const task of tasks) {
			if (!task.id || !task.title) {
				throw new Error('Each task must have an id and title');
			}
		}

		this.tasksData = { tasks: [...tasks] };
		await this._saveTasksData();

		this.emit('tasksSaved', tasks);
	}

	/**
	 * Validate the storage connection/configuration
	 * @returns {Promise<boolean>} True if valid
	 */
	async validate() {
		try {
			// Check if tasks file exists or can be created
			const tasksDir = path.dirname(this.tasksPath);
			
			// Check directory permissions
			await fs.promises.access(tasksDir, fs.constants.R_OK | fs.constants.W_OK);
			
			// Try to load tasks data
			await this._loadTasksData();
			
			return true;
		} catch (error) {
			log('error', `LocalStorageProvider validation failed: ${error.message}`);
			return false;
		}
	}

	/**
	 * Get provider-specific metadata
	 * @returns {Object} Provider metadata
	 */
	getProviderInfo() {
		return {
			name: 'local',
			version: '1.0.0',
			capabilities: ['read', 'write', 'delete', 'batch'],
			tasksPath: this.tasksPath,
			tasksCount: this.tasksData?.tasks?.length || 0,
			lastModified: this.lastModified
		};
	}

	/**
	 * Get tasks file path
	 * @returns {string} Tasks file path
	 */
	getTasksPath() {
		return this.tasksPath;
	}

	/**
	 * Set tasks file path
	 * @param {string} newPath - New tasks file path
	 * @returns {Promise<void>}
	 */
	async setTasksPath(newPath) {
		this.tasksPath = newPath;
		this.tasksData = null;
		this.lastModified = null;
		this.isInitialized = false;
		
		await this.initialize();
	}

	/**
	 * Force reload tasks data from file
	 * @returns {Promise<void>}
	 */
	async reload() {
		this.lastModified = null;
		await this._loadTasksData();
	}

	/**
	 * Get tasks data statistics
	 * @returns {Object} Statistics object
	 */
	getStats() {
		if (!this.tasksData || !this.tasksData.tasks) {
			return { total: 0, byStatus: {}, byPriority: {} };
		}

		const tasks = this.tasksData.tasks;
		const byStatus = {};
		const byPriority = {};

		tasks.forEach(task => {
			// Count by status
			const status = task.status || 'unknown';
			byStatus[status] = (byStatus[status] || 0) + 1;

			// Count by priority
			const priority = task.priority || 'unknown';
			byPriority[priority] = (byPriority[priority] || 0) + 1;
		});

		return {
			total: tasks.length,
			byStatus,
			byPriority
		};
	}
}

export default LocalStorageProvider; 