/**
 * monday-persistence.js
 * Monday.com Persistence Layer for Task Master
 * 
 * This module serves as a direct replacement for the current file-based persistence layer,
 * implementing all core persistence functions using Monday.com API calls and data transformation.
 */

import { log } from './utils.js';
import { MondayApiClient } from './monday-api-client.js';
import { MondayBoardManager } from './monday-board-manager.js';
import { 
	transformTaskToMondayColumns, 
	transformMondayItemToTask, 
	transformMondayItemsToTasks,
	validateTransformedData 
} from './monday-data-transformer.js';
import { 
	getMondayConfig, 
	getMondayColumnMapping, 
	getMondayGroupMapping,
	getMondayEnabled
} from './monday-config-manager.js';

/**
 * In-memory cache for performance optimization
 */
class PersistenceCache {
	constructor() {
		this.cache = new Map();
		this.lastFetch = new Map();
		this.cacheTimeout = 5 * 60 * 1000; // 5 minutes default
	}

	set(key, data, customTimeout = null) {
		const timeout = customTimeout || this.cacheTimeout;
		this.cache.set(key, {
			data,
			timestamp: Date.now(),
			timeout
		});
		this.lastFetch.set(key, Date.now());
	}

	get(key) {
		const cached = this.cache.get(key);
		if (!cached) return null;

		const age = Date.now() - cached.timestamp;
		if (age > cached.timeout) {
			this.cache.delete(key);
			this.lastFetch.delete(key);
			return null;
		}

		return cached.data;
	}

	clear(key = null) {
		if (key) {
			this.cache.delete(key);
			this.lastFetch.delete(key);
		} else {
			this.cache.clear();
			this.lastFetch.clear();
		}
	}

	has(key) {
		return this.get(key) !== null;
	}

	getStats() {
		return {
			size: this.cache.size,
			keys: Array.from(this.cache.keys())
		};
	}
}

// Global cache instance
const persistenceCache = new PersistenceCache();

/**
 * Monday.com Persistence Core Module
 */
export class MondayPersistence {
	constructor() {
		this.apiClient = null;
		this.boardManager = null;
		this.config = null;
		this.columnMapping = null;
		this.groupMapping = null;
		this.telemetry = {
			apiCalls: 0,
			cacheHits: 0,
			cacheMisses: 0,
			errors: 0,
			lastOperation: null
		};
		this.initialized = false;
	}

	/**
	 * Initializes the Monday.com persistence layer
	 */
	async initialize() {
		try {
			// Check if Monday.com integration is enabled
			if (!getMondayEnabled()) {
				throw new Error('Monday.com integration is not enabled. Run configuration setup first.');
			}

			// Load configuration
			this.config = getMondayConfig();
			this.columnMapping = getMondayColumnMapping();
			this.groupMapping = getMondayGroupMapping();

			// Initialize API client
			this.apiClient = new MondayApiClient();
			await this.apiClient.initialize();

			// Initialize board manager
			this.boardManager = new MondayBoardManager(this.apiClient);

			// Validate board access and schema
			await this.validateBoardAccess();

			this.initialized = true;
			log(`[Monday Persistence] Initialized successfully for board ${this.config.boardId}`, 'info');

			return {
				success: true,
				boardId: this.config.boardId,
				workspaceId: this.config.workspaceId
			};

		} catch (error) {
			log(`[Monday Persistence] Initialization failed: ${error.message}`, 'error');
			throw new Error(`Monday.com persistence initialization failed: ${error.message}`);
		}
	}

	/**
	 * Validates board access and schema compatibility
	 */
	async validateBoardAccess() {
		try {
			// Check if board exists and is accessible
			const boardData = await this.apiClient.getBoard(this.config.boardId);
			if (!boardData) {
				throw new Error(`Board ${this.config.boardId} not found or not accessible`);
			}

			// Validate board schema
			const isValidBoard = await this.boardManager.validateTaskMasterBoard(this.config.boardId);
			if (!isValidBoard.isValid) {
				log(`[Monday Persistence] Board schema validation warnings: ${isValidBoard.issues.join(', ')}`, 'warn');
				
				// Auto-fix schema if possible
				if (this.config.autoFixSchema) {
					log(`[Monday Persistence] Attempting to auto-fix board schema...`, 'info');
					await this.boardManager.migrateBoardSchema(this.config.boardId);
				}
			}

			return true;

		} catch (error) {
			throw new Error(`Board validation failed: ${error.message}`);
		}
	}

	/**
	 * Loads all tasks from Monday.com board
	 * Equivalent to readJSON(tasksPath) for file-based persistence
	 * @param {Object} options - Load options
	 * @returns {Object} Tasks data in the same format as file-based persistence
	 */
	async loadTasks(options = {}) {
		const cacheKey = `tasks_${this.config.boardId}`;
		const { forceRefresh = false, pagination = {} } = options;

		try {
			this.telemetry.lastOperation = 'loadTasks';

			// Check cache first unless force refresh is requested
			if (!forceRefresh && persistenceCache.has(cacheKey)) {
				this.telemetry.cacheHits++;
				log(`[Monday Persistence] Loading tasks from cache`, 'debug');
				return persistenceCache.get(cacheKey);
			}

			this.telemetry.cacheMisses++;
			this.telemetry.apiCalls++;

			await this.ensureInitialized();

			log(`[Monday Persistence] Loading tasks from Monday.com board ${this.config.boardId}`, 'info');

			// Load items from Monday.com with pagination support
			const items = await this.loadAllItems(pagination);
			
			// Transform Monday.com items to Task Master format
			const transformResult = transformMondayItemsToTasks(
				items, 
				null, // schema - using default from data transformer
				this.columnMapping
			);

			if (!transformResult.success) {
				throw new Error(`Task transformation failed: ${transformResult.errors?.join(', ')}`);
			}

			// Build the same data structure as file-based persistence
			const tasksData = {
				tasks: transformResult.tasks,
				metadata: {
					source: 'monday',
					boardId: this.config.boardId,
					lastSync: new Date().toISOString(),
					totalItems: items.length,
					transformedItems: transformResult.successfulTransformations
				}
			};

			// Cache the result
			persistenceCache.set(cacheKey, tasksData);

			log(`[Monday Persistence] Successfully loaded ${tasksData.tasks.length} tasks`, 'info');
			return tasksData;

		} catch (error) {
			this.telemetry.errors++;
			log(`[Monday Persistence] Failed to load tasks: ${error.message}`, 'error');
			throw new Error(`Failed to load tasks from Monday.com: ${error.message}`);
		}
	}

	/**
	 * Saves all tasks to Monday.com board
	 * Equivalent to writeJSON(tasksPath, data) for file-based persistence
	 * @param {Object} tasksData - Tasks data in the same format as file-based persistence
	 * @param {Object} options - Save options
	 */
	async saveTasks(tasksData, options = {}) {
		const { batchSize = 50, validateFirst = true } = options;

		try {
			this.telemetry.lastOperation = 'saveTasks';
			this.telemetry.apiCalls++;

			await this.ensureInitialized();

			if (!tasksData || !tasksData.tasks || !Array.isArray(tasksData.tasks)) {
				throw new Error('Invalid tasks data structure provided');
			}

			log(`[Monday Persistence] Saving ${tasksData.tasks.length} tasks to Monday.com`, 'info');

			// Validate tasks before saving if requested
			if (validateFirst) {
				const validationErrors = this.validateTasksData(tasksData.tasks);
				if (validationErrors.length > 0) {
					throw new Error(`Task validation failed: ${validationErrors.join(', ')}`);
				}
			}

			// Clear existing items on the board first (full sync approach)
			await this.clearBoardItems();

			// Save tasks in batches to respect API limits
			const results = [];
			for (let i = 0; i < tasksData.tasks.length; i += batchSize) {
				const batch = tasksData.tasks.slice(i, i + batchSize);
				const batchResult = await this.saveBatchTasks(batch);
				results.push(...batchResult);
			}

			// Clear cache after successful save
			const cacheKey = `tasks_${this.config.boardId}`;
			persistenceCache.clear(cacheKey);

			log(`[Monday Persistence] Successfully saved ${results.length} tasks`, 'info');
			return {
				success: true,
				savedTasks: results.length,
				metadata: {
					boardId: this.config.boardId,
					timestamp: new Date().toISOString()
				}
			};

		} catch (error) {
			this.telemetry.errors++;
			log(`[Monday Persistence] Failed to save tasks: ${error.message}`, 'error');
			throw new Error(`Failed to save tasks to Monday.com: ${error.message}`);
		}
	}

	/**
	 * Saves a single task to Monday.com
	 * @param {Object} task - Task object to save
	 * @param {Object} options - Save options
	 */
	async saveTask(task, options = {}) {
		const { updateIfExists = true } = options;

		try {
			this.telemetry.lastOperation = 'saveTask';
			this.telemetry.apiCalls++;

			await this.ensureInitialized();

			if (!task || typeof task !== 'object') {
				throw new Error('Invalid task object provided');
			}

			log(`[Monday Persistence] Saving task ${task.id}: ${task.title}`, 'info');

			// Transform task to Monday.com format
			const transformResult = transformTaskToMondayColumns(task, this.columnMapping);
			if (!transformResult.success) {
				throw new Error(`Task transformation failed: ${transformResult.error}`);
			}

			// Check if task already exists
			const existingItem = await this.findTaskItem(task.id);
			
			let savedItem;
			if (existingItem && updateIfExists) {
				// Update existing item
				savedItem = await this.apiClient.updateItem(
					this.config.boardId,
					existingItem.id,
					transformResult.columns
				);
			} else if (!existingItem) {
				// Create new item
				savedItem = await this.apiClient.createItem(
					this.config.boardId,
					transformResult.metadata.itemName,
					transformResult.columns,
					transformResult.metadata.group
				);
			} else {
				throw new Error(`Task ${task.id} already exists and updateIfExists is false`);
			}

			// Clear relevant cache
			const cacheKey = `tasks_${this.config.boardId}`;
			persistenceCache.clear(cacheKey);

			log(`[Monday Persistence] Successfully saved task ${task.id}`, 'info');
			return {
				success: true,
				taskId: task.id,
				mondayItemId: savedItem.id,
				operation: existingItem ? 'updated' : 'created'
			};

		} catch (error) {
			this.telemetry.errors++;
			log(`[Monday Persistence] Failed to save task ${task?.id}: ${error.message}`, 'error');
			throw new Error(`Failed to save task: ${error.message}`);
		}
	}

	/**
	 * Deletes a task from Monday.com
	 * @param {string|number} taskId - Task ID to delete
	 */
	async deleteTask(taskId) {
		try {
			this.telemetry.lastOperation = 'deleteTask';
			this.telemetry.apiCalls++;

			await this.ensureInitialized();

			log(`[Monday Persistence] Deleting task ${taskId}`, 'info');

			// Find the Monday.com item for this task
			const item = await this.findTaskItem(taskId);
			if (!item) {
				throw new Error(`Task ${taskId} not found on Monday.com board`);
			}

			// Delete the item
			await this.apiClient.deleteItem(item.id);

			// Clear relevant cache
			const cacheKey = `tasks_${this.config.boardId}`;
			persistenceCache.clear(cacheKey);

			log(`[Monday Persistence] Successfully deleted task ${taskId}`, 'info');
			return {
				success: true,
				taskId,
				mondayItemId: item.id
			};

		} catch (error) {
			this.telemetry.errors++;
			log(`[Monday Persistence] Failed to delete task ${taskId}: ${error.message}`, 'error');
			throw new Error(`Failed to delete task: ${error.message}`);
		}
	}

	/**
	 * Updates task status in Monday.com
	 * @param {string|number} taskId - Task ID to update
	 * @param {string} newStatus - New status value
	 */
	async updateTaskStatus(taskId, newStatus) {
		try {
			this.telemetry.lastOperation = 'updateTaskStatus';
			this.telemetry.apiCalls++;

			await this.ensureInitialized();

			log(`[Monday Persistence] Updating task ${taskId} status to ${newStatus}`, 'info');

			// Find the Monday.com item for this task
			const item = await this.findTaskItem(taskId);
			if (!item) {
				throw new Error(`Task ${taskId} not found on Monday.com board`);
			}

			// Get status column ID
			const statusColumnId = this.columnMapping.status;
			if (!statusColumnId) {
				throw new Error('Status column mapping not found');
			}

			// Transform status to Monday.com format
			const mockTask = { status: newStatus };
			const transformResult = transformTaskToMondayColumns(mockTask, this.columnMapping);
			const mondayStatus = transformResult.columns[statusColumnId];

			// Update the item status
			await this.apiClient.updateItem(
				this.config.boardId,
				item.id,
				{ [statusColumnId]: mondayStatus }
			);

			// Move item to appropriate group based on status
			const targetGroup = this.getGroupForStatus(newStatus);
			if (targetGroup) {
				await this.apiClient.moveItemToGroup(
					this.config.boardId,
					item.id,
					targetGroup
				);
			}

			// Clear relevant cache
			const cacheKey = `tasks_${this.config.boardId}`;
			persistenceCache.clear(cacheKey);

			log(`[Monday Persistence] Successfully updated task ${taskId} status`, 'info');
			return {
				success: true,
				taskId,
				newStatus,
				mondayItemId: item.id
			};

		} catch (error) {
			this.telemetry.errors++;
			log(`[Monday Persistence] Failed to update task ${taskId} status: ${error.message}`, 'error');
			throw new Error(`Failed to update task status: ${error.message}`);
		}
	}

	/**
	 * Creates a subtask in Monday.com
	 * @param {Object} subtask - Subtask object to create
	 * @param {string|number} parentTaskId - Parent task ID
	 */
	async createSubtask(subtask, parentTaskId) {
		try {
			this.telemetry.lastOperation = 'createSubtask';
			this.telemetry.apiCalls++;

			await this.ensureInitialized();

			log(`[Monday Persistence] Creating subtask ${subtask.id} for parent ${parentTaskId}`, 'info');

			// Set parent reference in subtask
			const subtaskWithParent = {
				...subtask,
				parentTask: parentTaskId,
				taskType: 'subtask'
			};

			// Transform subtask to Monday.com format
			const transformResult = transformTaskToMondayColumns(subtaskWithParent, this.columnMapping);
			if (!transformResult.success) {
				throw new Error(`Subtask transformation failed: ${transformResult.error}`);
			}

			// Create the subtask item (it will go to the subtasks group)
			const savedItem = await this.apiClient.createItem(
				this.config.boardId,
				transformResult.metadata.itemName,
				transformResult.columns,
				'subtasks' // Always put subtasks in the subtasks group
			);

			// Clear relevant cache
			const cacheKey = `tasks_${this.config.boardId}`;
			persistenceCache.clear(cacheKey);

			log(`[Monday Persistence] Successfully created subtask ${subtask.id}`, 'info');
			return {
				success: true,
				subtaskId: subtask.id,
				parentTaskId,
				mondayItemId: savedItem.id
			};

		} catch (error) {
			this.telemetry.errors++;
			log(`[Monday Persistence] Failed to create subtask ${subtask?.id}: ${error.message}`, 'error');
			throw new Error(`Failed to create subtask: ${error.message}`);
		}
	}

	/**
	 * Helper Methods
	 */

	async ensureInitialized() {
		if (!this.initialized) {
			await this.initialize();
		}
	}

	async loadAllItems(pagination = {}) {
		const { limit = 100, offset = 0 } = pagination;
		let allItems = [];
		let hasMore = true;
		let currentOffset = offset;

		while (hasMore) {
			const items = await this.apiClient.getBoardItems(
				this.config.boardId,
				limit,
				currentOffset
			);

			if (!items || items.length === 0) {
				hasMore = false;
			} else {
				allItems.push(...items);
				currentOffset += items.length;
				
				// Check if we got fewer items than requested (indicates end)
				if (items.length < limit) {
					hasMore = false;
				}
			}
		}

		return allItems;
	}

	async findTaskItem(taskId) {
		// Convert taskId to string for comparison
		const searchId = taskId.toString();
		
		// Get all items and find the one with matching task_id column
		const items = await this.apiClient.getBoardItems(this.config.boardId);
		const taskIdColumnId = this.columnMapping.task_id;
		
		return items.find(item => {
			const taskIdColumn = item.column_values?.find(col => col.id === taskIdColumnId);
			return taskIdColumn?.value === searchId || taskIdColumn?.text === searchId;
		});
	}

	async saveBatchTasks(tasks) {
		const results = [];
		
		for (const task of tasks) {
			try {
				const result = await this.saveTask(task, { updateIfExists: false });
				results.push(result);
			} catch (error) {
				log(`[Monday Persistence] Failed to save task ${task.id} in batch: ${error.message}`, 'warn');
				// Continue with other tasks instead of failing the entire batch
			}
		}
		
		return results;
	}

	async clearBoardItems() {
		log(`[Monday Persistence] Clearing existing items from board ${this.config.boardId}`, 'info');
		
		const items = await this.apiClient.getBoardItems(this.config.boardId);
		
		for (const item of items) {
			try {
				await this.apiClient.deleteItem(item.id);
			} catch (error) {
				log(`[Monday Persistence] Failed to delete item ${item.id}: ${error.message}`, 'warn');
			}
		}
	}

	validateTasksData(tasks) {
		const errors = [];
		
		for (const task of tasks) {
			if (!task.id) {
				errors.push(`Task missing ID: ${task.title || 'Unknown'}`);
			}
			if (!task.title) {
				errors.push(`Task ${task.id} missing title`);
			}
			if (!task.status) {
				errors.push(`Task ${task.id} missing status`);
			}
		}
		
		return errors;
	}

	getGroupForStatus(status) {
		const mapping = {
			'pending': 'pending',
			'in-progress': 'in_progress', 
			'done': 'completed',
			'review': 'in_progress',
			'blocked': 'blocked',
			'deferred': 'blocked',
			'cancelled': 'blocked'
		};
		
		return mapping[status] || 'pending';
	}

	/**
	 * Get telemetry data for monitoring
	 */
	getTelemetry() {
		return {
			...this.telemetry,
			cacheStats: persistenceCache.getStats(),
			isInitialized: this.initialized
		};
	}

	/**
	 * Clear all caches
	 */
	clearCache() {
		persistenceCache.clear();
		log(`[Monday Persistence] Cache cleared`, 'info');
	}
}

// Export a singleton instance
export const mondayPersistence = new MondayPersistence();

// Export individual functions that match the file-based persistence interface
export const saveTasks = async (tasksData, options = {}) => {
	return await mondayPersistence.saveTasks(tasksData, options);
};

export const loadTasks = async (options = {}) => {
	return await mondayPersistence.loadTasks(options);
};

export const saveTask = async (task, options = {}) => {
	return await mondayPersistence.saveTask(task, options);
};

export const deleteTask = async (taskId) => {
	return await mondayPersistence.deleteTask(taskId);
};

export const updateTaskStatus = async (taskId, newStatus) => {
	return await mondayPersistence.updateTaskStatus(taskId, newStatus);
};

export const createSubtask = async (subtask, parentTaskId) => {
	return await mondayPersistence.createSubtask(subtask, parentTaskId);
};

// Cache management functions
export const clearPersistenceCache = () => {
	mondayPersistence.clearCache();
};

export const getPersistenceTelemetry = () => {
	return mondayPersistence.getTelemetry();
}; 