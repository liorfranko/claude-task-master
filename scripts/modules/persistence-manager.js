/**
 * persistence-manager.js
 * Core persistence manager abstraction layer for Task Master
 * Provides a unified interface for storage operations across different providers
 */

import { EventEmitter } from 'events';
import { log } from './utils.js';
import { getConfig } from './config-manager.js';

/**
 * Base Storage Provider interface
 * All storage providers must implement these methods
 */
class BaseStorageProvider extends EventEmitter {
	constructor(config) {
		super();
		this.config = config;
		this.isInitialized = false;
	}

	/**
	 * Initialize the storage provider
	 * @returns {Promise<void>}
	 */
	async initialize() {
		throw new Error('initialize() must be implemented by storage provider');
	}

	/**
	 * Get all tasks
	 * @returns {Promise<Array>} Array of tasks
	 */
	async getTasks() {
		throw new Error('getTasks() must be implemented by storage provider');
	}

	/**
	 * Get a specific task by ID
	 * @param {string|number} id - Task ID
	 * @returns {Promise<Object|null>} Task object or null if not found
	 */
	async getTask(id) {
		throw new Error('getTask() must be implemented by storage provider');
	}

	/**
	 * Create a new task
	 * @param {Object} taskData - Task data to create
	 * @returns {Promise<Object>} Created task object
	 */
	async createTask(taskData) {
		throw new Error('createTask() must be implemented by storage provider');
	}

	/**
	 * Update an existing task
	 * @param {string|number} id - Task ID to update
	 * @param {Object} updateData - Data to update
	 * @returns {Promise<Object>} Updated task object
	 */
	async updateTask(id, updateData) {
		throw new Error('updateTask() must be implemented by storage provider');
	}

	/**
	 * Delete a task
	 * @param {string|number} id - Task ID to delete
	 * @returns {Promise<boolean>} True if deleted successfully
	 */
	async deleteTask(id) {
		throw new Error('deleteTask() must be implemented by storage provider');
	}

	/**
	 * Get all subtasks for a parent task
	 * @param {string|number} parentId - Parent task ID
	 * @returns {Promise<Array>} Array of subtasks
	 */
	async getSubtasks(parentId) {
		throw new Error('getSubtasks() must be implemented by storage provider');
	}

	/**
	 * Create a new subtask
	 * @param {string|number} parentId - Parent task ID
	 * @param {Object} subtaskData - Subtask data to create
	 * @returns {Promise<Object>} Created subtask object
	 */
	async createSubtask(parentId, subtaskData) {
		throw new Error('createSubtask() must be implemented by storage provider');
	}

	/**
	 * Update a subtask
	 * @param {string|number} parentId - Parent task ID
	 * @param {string|number} subtaskId - Subtask ID
	 * @param {Object} updateData - Data to update
	 * @returns {Promise<Object>} Updated subtask object
	 */
	async updateSubtask(parentId, subtaskId, updateData) {
		throw new Error('updateSubtask() must be implemented by storage provider');
	}

	/**
	 * Delete a subtask
	 * @param {string|number} parentId - Parent task ID
	 * @param {string|number} subtaskId - Subtask ID
	 * @returns {Promise<boolean>} True if deleted successfully
	 */
	async deleteSubtask(parentId, subtaskId) {
		throw new Error('deleteSubtask() must be implemented by storage provider');
	}

	/**
	 * Save all tasks (batch operation)
	 * @param {Array} tasks - Array of tasks to save
	 * @returns {Promise<void>}
	 */
	async saveTasks(tasks) {
		throw new Error('saveTasks() must be implemented by storage provider');
	}

	/**
	 * Validate the storage connection/configuration
	 * @returns {Promise<boolean>} True if valid
	 */
	async validate() {
		throw new Error('validate() must be implemented by storage provider');
	}

	/**
	 * Get provider-specific metadata
	 * @returns {Object} Provider metadata
	 */
	getProviderInfo() {
		return {
			name: 'base',
			version: '1.0.0',
			capabilities: ['read', 'write']
		};
	}
}

/**
 * Main Persistence Manager class
 * Manages storage providers and provides unified interface
 */
class PersistenceManager extends EventEmitter {
	constructor(config = null) {
		super();
		this.providers = new Map();
		this.currentMode = null;
		this.config = config || getConfig();
		this.isInitialized = false;
		this.hooks = new Map();
		
		// Initialize persistence mode from config
		this.currentMode = this.config?.persistence?.mode || 'local';
		
		log('debug', `PersistenceManager initialized with mode: ${this.currentMode}`);
	}

	/**
	 * Register a storage provider for a specific mode
	 * @param {string} mode - Storage mode (local, monday, hybrid)
	 * @param {BaseStorageProvider} provider - Provider instance
	 */
	registerProvider(mode, provider) {
		if (!(provider instanceof BaseStorageProvider)) {
			throw new Error('Provider must extend BaseStorageProvider');
		}

		this.providers.set(mode, provider);
		
		// Forward provider events
		provider.on('error', (error) => {
			log('error', `Provider ${mode} error:`, error);
			this.emit('providerError', { mode, error });
		});

		provider.on('taskCreated', (task) => {
			this.emit('taskCreated', { mode, task });
		});

		provider.on('taskUpdated', (task) => {
			this.emit('taskUpdated', { mode, task });
		});

		provider.on('taskDeleted', (taskId) => {
			this.emit('taskDeleted', { mode, taskId });
		});

		log('debug', `Registered ${mode} provider:`, provider.getProviderInfo());
	}

	/**
	 * Get the current active storage provider
	 * @returns {BaseStorageProvider} Current provider instance
	 */
	getCurrentProvider() {
		const provider = this.providers.get(this.currentMode);
		
		if (!provider) {
			throw new Error(`No provider registered for mode: ${this.currentMode}`);
		}

		return provider;
	}

	/**
	 * Switch to a different storage mode
	 * @param {string} mode - Target storage mode
	 * @returns {Promise<void>}
	 */
	async switchMode(mode) {
		if (!this.providers.has(mode)) {
			throw new Error(`No provider registered for mode: ${mode}`);
		}

		const oldMode = this.currentMode;
		this.currentMode = mode;
		
		// Initialize the new provider if needed
		const newProvider = this.getCurrentProvider();
		if (!newProvider.isInitialized) {
			await newProvider.initialize();
		}

		log('info', `Switched storage mode from ${oldMode} to ${mode}`);
		this.emit('modeChanged', { oldMode, newMode: mode });
	}

	/**
	 * Initialize the persistence manager and current provider
	 * @returns {Promise<void>}
	 */
	async initialize() {
		if (this.isInitialized) {
			return;
		}

		const provider = this.getCurrentProvider();
		await provider.initialize();
		
		this.isInitialized = true;
		log('info', `PersistenceManager initialized with ${this.currentMode} provider`);
	}

	/**
	 * Register a hook for storage operations
	 * @param {string} operation - Operation name (beforeGet, afterCreate, etc.)
	 * @param {Function} hookFn - Hook function to execute
	 */
	registerHook(operation, hookFn) {
		if (!this.hooks.has(operation)) {
			this.hooks.set(operation, []);
		}
		this.hooks.get(operation).push(hookFn);
		log('debug', `Registered hook for operation: ${operation}`);
	}

	/**
	 * Execute hooks for a specific operation
	 * @param {string} operation - Operation name
	 * @param {Object} context - Operation context
	 * @returns {Promise<Object>} Modified context
	 */
	async executeHooks(operation, context) {
		const hooks = this.hooks.get(operation) || [];
		let modifiedContext = { ...context };

		for (const hook of hooks) {
			try {
				const result = await hook(modifiedContext);
				if (result && typeof result === 'object') {
					modifiedContext = { ...modifiedContext, ...result };
				}
			} catch (error) {
				log('error', `Hook error for operation ${operation}:`, error);
				this.emit('hookError', { operation, error, context });
			}
		}

		return modifiedContext;
	}

	// Unified CRUD operations with hooks and error handling

	/**
	 * Get all tasks
	 * @param {Object} options - Query options
	 * @returns {Promise<Array>} Array of tasks
	 */
	async getTasks(options = {}) {
		await this.initialize();
		
		const context = await this.executeHooks('beforeGetTasks', { options });
		
		try {
			const tasks = await this.getCurrentProvider().getTasks(context.options);
			
			const result = await this.executeHooks('afterGetTasks', { 
				tasks, 
				options: context.options 
			});
			
			return result.tasks;
		} catch (error) {
			log('error', 'Failed to get tasks:', error);
			this.emit('operationError', { operation: 'getTasks', error, options });
			throw error;
		}
	}

	/**
	 * Get a specific task by ID
	 * @param {string|number} id - Task ID
	 * @param {Object} options - Query options
	 * @returns {Promise<Object|null>} Task object or null
	 */
	async getTask(id, options = {}) {
		await this.initialize();
		
		const context = await this.executeHooks('beforeGetTask', { id, options });
		
		try {
			const task = await this.getCurrentProvider().getTask(context.id, context.options);
			
			const result = await this.executeHooks('afterGetTask', { 
				task, 
				id: context.id, 
				options: context.options 
			});
			
			return result.task;
		} catch (error) {
			log('error', `Failed to get task ${id}:`, error);
			this.emit('operationError', { operation: 'getTask', error, id, options });
			throw error;
		}
	}

	/**
	 * Create a new task
	 * @param {Object} taskData - Task data to create
	 * @param {Object} options - Creation options
	 * @returns {Promise<Object>} Created task object
	 */
	async createTask(taskData, options = {}) {
		await this.initialize();
		
		const context = await this.executeHooks('beforeCreateTask', { taskData, options });
		
		try {
			const task = await this.getCurrentProvider().createTask(context.taskData, context.options);
			
			const result = await this.executeHooks('afterCreateTask', { 
				task, 
				originalData: taskData, 
				options: context.options 
			});
			
			this.emit('taskCreated', { task: result.task });
			return result.task;
		} catch (error) {
			log('error', 'Failed to create task:', error);
			this.emit('operationError', { operation: 'createTask', error, taskData, options });
			throw error;
		}
	}

	/**
	 * Update an existing task
	 * @param {string|number} id - Task ID to update
	 * @param {Object} updateData - Data to update
	 * @param {Object} options - Update options
	 * @returns {Promise<Object>} Updated task object
	 */
	async updateTask(id, updateData, options = {}) {
		await this.initialize();
		
		const context = await this.executeHooks('beforeUpdateTask', { id, updateData, options });
		
		try {
			const task = await this.getCurrentProvider().updateTask(
				context.id, 
				context.updateData, 
				context.options
			);
			
			const result = await this.executeHooks('afterUpdateTask', { 
				task, 
				id: context.id, 
				updateData: context.updateData, 
				options: context.options 
			});
			
			this.emit('taskUpdated', { task: result.task });
			return result.task;
		} catch (error) {
			log('error', `Failed to update task ${id}:`, error);
			this.emit('operationError', { operation: 'updateTask', error, id, updateData, options });
			throw error;
		}
	}

	/**
	 * Delete a task
	 * @param {string|number} id - Task ID to delete
	 * @param {Object} options - Deletion options
	 * @returns {Promise<boolean>} True if deleted successfully
	 */
	async deleteTask(id, options = {}) {
		await this.initialize();
		
		const context = await this.executeHooks('beforeDeleteTask', { id, options });
		
		try {
			const success = await this.getCurrentProvider().deleteTask(context.id, context.options);
			
			await this.executeHooks('afterDeleteTask', { 
				success, 
				id: context.id, 
				options: context.options 
			});
			
			if (success) {
				this.emit('taskDeleted', { taskId: context.id });
			}
			
			return success;
		} catch (error) {
			log('error', `Failed to delete task ${id}:`, error);
			this.emit('operationError', { operation: 'deleteTask', error, id, options });
			throw error;
		}
	}

	/**
	 * Save all tasks (batch operation)
	 * @param {Array} tasks - Array of tasks to save
	 * @param {Object} options - Save options
	 * @returns {Promise<void>}
	 */
	async saveTasks(tasks, options = {}) {
		await this.initialize();
		
		const context = await this.executeHooks('beforeSaveTasks', { tasks, options });
		
		try {
			await this.getCurrentProvider().saveTasks(context.tasks, context.options);
			
			await this.executeHooks('afterSaveTasks', { 
				tasks: context.tasks, 
				options: context.options 
			});
			
			this.emit('tasksSaved', { tasks: context.tasks });
		} catch (error) {
			log('error', 'Failed to save tasks:', error);
			this.emit('operationError', { operation: 'saveTasks', error, tasks, options });
			throw error;
		}
	}

	/**
	 * Get provider information for current mode
	 * @returns {Object} Provider information
	 */
	getProviderInfo() {
		try {
			const provider = this.getCurrentProvider();
			return {
				mode: this.currentMode,
				...provider.getProviderInfo(),
				isInitialized: provider.isInitialized
			};
		} catch (error) {
			return {
				mode: this.currentMode,
				error: error.message,
				isInitialized: false
			};
		}
	}

	/**
	 * Validate current provider configuration
	 * @returns {Promise<boolean>} True if valid
	 */
	async validate() {
		try {
			const provider = this.getCurrentProvider();
			return await provider.validate();
		} catch (error) {
			log('error', 'Provider validation failed:', error);
			return false;
		}
	}

	/**
	 * Get all registered providers
	 * @returns {Array} Array of provider information
	 */
	getAllProviders() {
		return Array.from(this.providers.entries()).map(([mode, provider]) => ({
			mode,
			...provider.getProviderInfo(),
			isInitialized: provider.isInitialized,
			isActive: mode === this.currentMode
		}));
	}
}

// Create and export a singleton instance
const persistenceManager = new PersistenceManager();

// Export both the singleton instance and the classes for testing/extension
export default persistenceManager;
export { PersistenceManager, BaseStorageProvider }; 