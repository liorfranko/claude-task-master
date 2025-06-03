/**
 * monday-storage-provider.js
 * Monday.com storage provider implementation for Task Master
 * Handles Monday.com board-based storage operations with local caching
 */

import { BaseStorageProvider } from '../persistence-manager.js';
import { MondayClient } from '../monday-client.js';
import { getMondayApiToken, getMondayIntegrationConfig } from '../config-manager.js';
import { log } from '../utils.js';

/**
 * Monday Storage Provider
 * Implements Monday.com board-based storage with local caching for performance
 */
class MondayStorageProvider extends BaseStorageProvider {
	constructor(config = {}) {
		super(config);
		this.mondayClient = null;
		this.boardId = null;
		this.columnMapping = null;
		
		// Local cache for performance
		this.cache = null;
		this.lastFetched = null;
		this.cacheTimeout = 30000; // 30 seconds cache timeout
		
		// Field mapping cache
		this.boardColumns = null;
		this.lastColumnsFetch = null;
	}

	/**
	 * Initialize the Monday storage provider
	 * @returns {Promise<void>}
	 */
	async initialize() {
		if (this.isInitialized) {
			return;
		}

		// Get Monday.com configuration
		const mondayConfig = getMondayIntegrationConfig();
		if (!mondayConfig || !mondayConfig.boardId) {
			throw new Error('Monday.com integration not configured. Board ID is required.');
		}

		// Get API token
		const apiToken = getMondayApiToken();
		if (!apiToken) {
			throw new Error('Monday.com API token not found. Please configure MONDAY_API_TOKEN environment variable.');
		}

		this.boardId = mondayConfig.boardId;
		this.columnMapping = mondayConfig.columnMapping || {
			status: 'status',
			title: 'name',
			description: 'description',
			details: 'task_details',
			taskId: 'task_id_field',
			priority: 'task_priority',
			testStrategy: 'test_strategy',
			dependencies: 'task_dependencies'
		};

		// Initialize Monday.com client
		this.mondayClient = new MondayClient(apiToken);

		// Test connection
		const connectionTest = await this.mondayClient.testConnection();
		if (!connectionTest.success) {
			throw new Error(`Failed to connect to Monday.com: ${connectionTest.error}`);
		}

		// Test board access
		const boardTest = await this.mondayClient.testBoardAccess(this.boardId);
		if (!boardTest.success) {
			throw new Error(`Failed to access Monday.com board ${this.boardId}: ${boardTest.error}`);
		}

		// Cache board columns for efficient mapping
		await this._fetchBoardColumns();

		this.isInitialized = true;
		log('info', `MondayStorageProvider initialized for board ${this.boardId}`);
	}

	/**
	 * Fetch and cache board columns information
	 * @private
	 */
	async _fetchBoardColumns() {
		const query = `
			query GetBoardColumns($boardId: [ID!]!) {
				boards(ids: $boardId) {
					id
					name
					columns {
						id
						title
						type
						settings_str
					}
				}
			}
		`;

		try {
			const result = await this.mondayClient._executeWithRateLimit(query, { 
				boardId: [this.boardId] 
			});

			if (!result.boards || result.boards.length === 0) {
				throw new Error(`Board ${this.boardId} not found`);
			}

			this.boardColumns = result.boards[0].columns;
			this.lastColumnsFetch = Date.now();

			log('debug', `Cached ${this.boardColumns.length} columns for board ${this.boardId}`);
		} catch (error) {
			log('error', `Failed to fetch board columns: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Check if cache is valid (not expired)
	 * @private
	 * @returns {boolean}
	 */
	_isCacheValid() {
		if (!this.cache || !this.lastFetched) {
			return false;
		}
		return (Date.now() - this.lastFetched) < this.cacheTimeout;
	}

	/**
	 * Invalidate cache
	 * @private
	 */
	_invalidateCache() {
		this.cache = null;
		this.lastFetched = null;
	}

	/**
	 * Get all tasks from Monday.com board
	 * @param {Object} options - Query options
	 * @returns {Promise<Array>} Array of tasks
	 */
	async getTasks(options = {}) {
		// Return cached data if valid and no specific filters
		if (this._isCacheValid() && !options.status && !options.ids && !options.search) {
			log('debug', 'Returning cached tasks data');
			return [...this.cache];
		}

		// Fetch fresh data from Monday.com
		const query = `
			query GetBoardItems($boardId: [ID!]!) {
				boards(ids: $boardId) {
					items {
						id
						name
						column_values {
							id
							text
							value
						}
						subitems {
							id
							name
							column_values {
								id
								text
								value
							}
						}
					}
				}
			}
		`;

		try {
			const result = await this.mondayClient._executeWithRateLimit(query, { 
				boardId: [this.boardId] 
			});

			if (!result.boards || result.boards.length === 0) {
				throw new Error(`Board ${this.boardId} not found`);
			}

			const items = result.boards[0].items;
			
			// Map Monday items to Task Master format
			const tasks = items.map(item => this._mapMondayItemToTask(item));

			// Update cache
			this.cache = tasks;
			this.lastFetched = Date.now();

			log('debug', `Fetched ${tasks.length} tasks from Monday.com board ${this.boardId}`);

			// Apply filters if provided
			return this._applyFilters(tasks, options);
		} catch (error) {
			log('error', `Failed to fetch tasks from Monday.com: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Apply filters to tasks array
	 * @private
	 * @param {Array} tasks - Array of tasks
	 * @param {Object} options - Filter options
	 * @returns {Array} Filtered tasks
	 */
	_applyFilters(tasks, options) {
		let filteredTasks = [...tasks];

		// Apply status filter
		if (options.status) {
			filteredTasks = filteredTasks.filter(task => 
				task.status && task.status.toLowerCase() === options.status.toLowerCase()
			);
		}

		// Apply ID filter
		if (options.ids && Array.isArray(options.ids)) {
			filteredTasks = filteredTasks.filter(task => 
				options.ids.includes(task.id) || options.ids.includes(String(task.id))
			);
		}

		// Apply search filter
		if (options.search) {
			const searchTerm = options.search.toLowerCase();
			filteredTasks = filteredTasks.filter(task =>
				(task.title && task.title.toLowerCase().includes(searchTerm)) ||
				(task.description && task.description.toLowerCase().includes(searchTerm))
			);
		}

		return filteredTasks;
	}

	/**
	 * Get a specific task by ID
	 * @param {string|number} id - Task ID
	 * @param {Object} options - Query options
	 * @returns {Promise<Object|null>} Task object or null if not found
	 */
	async getTask(id, options = {}) {
		// Try to find in cache first
		if (this._isCacheValid()) {
			const cachedTask = this.cache.find(task => 
				task.id === id || task.id === String(id) || String(task.id) === String(id)
			);
			if (cachedTask) {
				return cachedTask;
			}
		}

		// Fetch all tasks and find the one we need
		const tasks = await this.getTasks();
		return tasks.find(task => 
			task.id === id || task.id === String(id) || String(task.id) === String(id)
		) || null;
	}

	/**
	 * Create a new task on Monday.com board
	 * @param {Object} taskData - Task data to create
	 * @param {Object} options - Creation options
	 * @returns {Promise<Object>} Created task object
	 */
	async createTask(taskData, options = {}) {
		const escapedTitle = this._escapeForGraphQL(taskData.title || 'Untitled Task');

		// Create item on Monday board
		const mutation = `
			mutation CreateItem($boardId: ID!, $itemName: String!) {
				create_item(board_id: $boardId, item_name: $itemName) {
					id
					name
				}
			}
		`;

		try {
			const result = await this.mondayClient._executeWithRateLimit(mutation, {
				boardId: this.boardId,
				itemName: taskData.title || 'Untitled Task'
			});

			const mondayItemId = result.create_item.id;

			// Update additional fields
			await this._updateMondayItemFields(mondayItemId, taskData);

			// Create the task object with Monday.com data
			const newTask = {
				id: parseInt(mondayItemId), // Use Monday item ID as task ID
				mondayItemId: mondayItemId,
				title: taskData.title || 'Untitled Task',
				description: taskData.description || '',
				details: taskData.details || '',
				status: taskData.status || 'pending',
				priority: taskData.priority || 'medium',
				dependencies: taskData.dependencies || [],
				testStrategy: taskData.testStrategy || '',
				subtasks: [],
				lastSyncedAt: new Date().toISOString(),
				syncStatus: 'synced'
			};

			// Handle subtasks if provided
			if (taskData.subtasks && taskData.subtasks.length > 0) {
				for (const subtaskData of taskData.subtasks) {
					const subtask = await this.createSubtask(newTask.id, subtaskData);
					newTask.subtasks.push(subtask);
				}
			}

			// Invalidate cache
			this._invalidateCache();

			this.emit('taskCreated', newTask);
			log('info', `Created task "${newTask.title}" on Monday.com board ${this.boardId}`);

			return newTask;
		} catch (error) {
			log('error', `Failed to create task on Monday.com: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Update an existing task on Monday.com board
	 * @param {string|number} id - Task ID to update
	 * @param {Object} updateData - Data to update
	 * @param {Object} options - Update options
	 * @returns {Promise<Object>} Updated task object
	 */
	async updateTask(id, updateData, options = {}) {
		// Get the current task to find Monday item ID
		const currentTask = await this.getTask(id);
		if (!currentTask) {
			throw new Error(`Task ${id} not found`);
		}

		const mondayItemId = currentTask.mondayItemId || currentTask.id;

		// Update fields on Monday.com
		await this._updateMondayItemFields(mondayItemId, updateData);

		// Update the title if provided
		if (updateData.title && updateData.title !== currentTask.title) {
			await this._updateItemName(mondayItemId, updateData.title);
		}

		// Create updated task object
		const updatedTask = {
			...currentTask,
			...updateData,
			lastSyncedAt: new Date().toISOString(),
			syncStatus: 'synced'
		};

		// Invalidate cache
		this._invalidateCache();

		this.emit('taskUpdated', updatedTask);
		log('info', `Updated task ${id} on Monday.com board ${this.boardId}`);

		return updatedTask;
	}

	/**
	 * Delete a task from Monday.com board
	 * @param {string|number} id - Task ID to delete
	 * @param {Object} options - Delete options
	 * @returns {Promise<boolean>} True if deleted successfully
	 */
	async deleteTask(id, options = {}) {
		// Get the current task to find Monday item ID
		const currentTask = await this.getTask(id);
		if (!currentTask) {
			log('warn', `Task ${id} not found for deletion`);
			return false;
		}

		const mondayItemId = currentTask.mondayItemId || currentTask.id;

		// Delete item from Monday.com
		const mutation = `
			mutation DeleteItem($itemId: ID!) {
				delete_item(item_id: $itemId) {
					id
				}
			}
		`;

		try {
			await this.mondayClient._executeWithRateLimit(mutation, {
				itemId: mondayItemId
			});

			// Invalidate cache
			this._invalidateCache();

			this.emit('taskDeleted', id);
			log('info', `Deleted task ${id} from Monday.com board ${this.boardId}`);

			return true;
		} catch (error) {
			log('error', `Failed to delete task ${id} from Monday.com: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get all subtasks for a parent task
	 * @param {string|number} parentId - Parent task ID
	 * @returns {Promise<Array>} Array of subtasks
	 */
	async getSubtasks(parentId) {
		const parentTask = await this.getTask(parentId);
		return parentTask ? parentTask.subtasks || [] : [];
	}

	/**
	 * Create a new subtask
	 * @param {string|number} parentId - Parent task ID
	 * @param {Object} subtaskData - Subtask data to create
	 * @returns {Promise<Object>} Created subtask object
	 */
	async createSubtask(parentId, subtaskData) {
		const parentTask = await this.getTask(parentId);
		if (!parentTask) {
			throw new Error(`Parent task ${parentId} not found`);
		}

		const parentMondayItemId = parentTask.mondayItemId || parentTask.id;
		const escapedTitle = this._escapeForGraphQL(subtaskData.title || 'Untitled Subtask');

		// Create subitem on Monday.com
		const mutation = `
			mutation CreateSubitem($parentItemId: ID!, $itemName: String!) {
				create_subitem(parent_item_id: $parentItemId, item_name: $itemName) {
					id
					name
					board {
						id
					}
				}
			}
		`;

		try {
			const result = await this.mondayClient._executeWithRateLimit(mutation, {
				parentItemId: parentMondayItemId,
				itemName: subtaskData.title || 'Untitled Subtask'
			});

			const mondaySubitemId = result.create_subitem.id;

			// Update additional fields
			await this._updateMondayItemFields(mondaySubitemId, subtaskData);

			// Create subtask object
			const newSubtask = {
				id: subtaskData.id || `${parentId}.${Date.now()}`, // Generate unique subtask ID
				mondayItemId: mondaySubitemId,
				title: subtaskData.title || 'Untitled Subtask',
				description: subtaskData.description || '',
				details: subtaskData.details || '',
				status: subtaskData.status || 'pending',
				priority: subtaskData.priority || 'medium',
				dependencies: subtaskData.dependencies || [],
				testStrategy: subtaskData.testStrategy || '',
				lastSyncedAt: new Date().toISOString(),
				syncStatus: 'synced'
			};

			// Invalidate cache
			this._invalidateCache();

			log('info', `Created subtask "${newSubtask.title}" under task ${parentId}`);

			return newSubtask;
		} catch (error) {
			log('error', `Failed to create subtask: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Update a subtask
	 * @param {string|number} parentId - Parent task ID
	 * @param {string|number} subtaskId - Subtask ID
	 * @param {Object} updateData - Data to update
	 * @returns {Promise<Object>} Updated subtask object
	 */
	async updateSubtask(parentId, subtaskId, updateData) {
		const parentTask = await this.getTask(parentId);
		if (!parentTask) {
			throw new Error(`Parent task ${parentId} not found`);
		}

		const subtask = parentTask.subtasks?.find(st => 
			st.id === subtaskId || String(st.id) === String(subtaskId)
		);
		if (!subtask) {
			throw new Error(`Subtask ${subtaskId} not found in task ${parentId}`);
		}

		const mondaySubitemId = subtask.mondayItemId || subtask.id;

		// Update fields on Monday.com
		await this._updateMondayItemFields(mondaySubitemId, updateData);

		// Update the title if provided
		if (updateData.title && updateData.title !== subtask.title) {
			await this._updateItemName(mondaySubitemId, updateData.title);
		}

		// Create updated subtask object
		const updatedSubtask = {
			...subtask,
			...updateData,
			lastSyncedAt: new Date().toISOString(),
			syncStatus: 'synced'
		};

		// Invalidate cache
		this._invalidateCache();

		log('info', `Updated subtask ${subtaskId} in task ${parentId}`);

		return updatedSubtask;
	}

	/**
	 * Delete a subtask
	 * @param {string|number} parentId - Parent task ID
	 * @param {string|number} subtaskId - Subtask ID
	 * @returns {Promise<boolean>} True if deleted successfully
	 */
	async deleteSubtask(parentId, subtaskId) {
		const parentTask = await this.getTask(parentId);
		if (!parentTask) {
			throw new Error(`Parent task ${parentId} not found`);
		}

		const subtask = parentTask.subtasks?.find(st => 
			st.id === subtaskId || String(st.id) === String(subtaskId)
		);
		if (!subtask) {
			log('warn', `Subtask ${subtaskId} not found in task ${parentId}`);
			return false;
		}

		const mondaySubitemId = subtask.mondayItemId || subtask.id;

		// Delete subitem from Monday.com
		const mutation = `
			mutation DeleteSubitem($itemId: ID!) {
				delete_item(item_id: $itemId) {
					id
				}
			}
		`;

		try {
			await this.mondayClient._executeWithRateLimit(mutation, {
				itemId: mondaySubitemId
			});

			// Invalidate cache
			this._invalidateCache();

			log('info', `Deleted subtask ${subtaskId} from task ${parentId}`);

			return true;
		} catch (error) {
			log('error', `Failed to delete subtask ${subtaskId}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Save all tasks (batch operation) - Not supported in Monday mode
	 * @param {Array} tasks - Array of tasks to save
	 * @param {Object} options - Save options
	 * @returns {Promise<void>}
	 */
	async saveTasks(tasks, options = {}) {
		throw new Error('Batch save operation not supported in Monday-only mode. Use individual create/update operations.');
	}

	/**
	 * Validate the Monday.com storage connection/configuration
	 * @returns {Promise<boolean>} True if valid
	 */
	async validate() {
		try {
			// Test Monday client connection
			const connectionTest = await this.mondayClient.testConnection();
			if (!connectionTest.success) {
				return false;
			}

			// Test board access
			const boardTest = await this.mondayClient.testBoardAccess(this.boardId);
			if (!boardTest.success) {
				return false;
			}

			return true;
		} catch (error) {
			log('error', `Monday storage validation failed: ${error.message}`);
			return false;
		}
	}

	/**
	 * Get provider-specific metadata
	 * @returns {Object} Provider metadata
	 */
	getProviderInfo() {
		return {
			name: 'monday',
			version: '1.0.0',
			capabilities: ['read', 'write', 'real-time', 'collaboration'],
			boardId: this.boardId,
			columnMapping: this.columnMapping,
			cacheStatus: {
				isValid: this._isCacheValid(),
				lastFetched: this.lastFetched,
				itemCount: this.cache ? this.cache.length : 0
			}
		};
	}

	/**
	 * Map Monday.com item to Task Master task format
	 * @private
	 * @param {Object} item - Monday.com item object
	 * @returns {Object} Task Master task object
	 */
	_mapMondayItemToTask(item) {
		const task = {
			id: parseInt(item.id),
			mondayItemId: item.id,
			title: item.name,
			description: '',
			details: '',
			status: 'pending',
			priority: 'medium',
			dependencies: [],
			testStrategy: '',
			subtasks: [],
			lastSyncedAt: new Date().toISOString(),
			syncStatus: 'synced'
		};

		// Map column values based on column mapping
		if (item.column_values) {
			item.column_values.forEach(column => {
				this._mapColumnValueToTask(column, task);
			});
		}

		// Map subitems to subtasks
		if (item.subitems && item.subitems.length > 0) {
			task.subtasks = item.subitems.map(subitem => {
				const subtask = {
					id: `${task.id}.${subitem.id}`,
					mondayItemId: subitem.id,
					title: subitem.name,
					description: '',
					details: '',
					status: 'pending',
					priority: 'medium',
					dependencies: [],
					testStrategy: '',
					lastSyncedAt: new Date().toISOString(),
					syncStatus: 'synced'
				};

				// Map subitem column values
				if (subitem.column_values) {
					subitem.column_values.forEach(column => {
						this._mapColumnValueToTask(column, subtask);
					});
				}

				return subtask;
			});
		}

		return task;
	}

	/**
	 * Map individual column value to task field
	 * @private
	 * @param {Object} column - Monday.com column value object
	 * @param {Object} task - Task object to update
	 */
	_mapColumnValueToTask(column, task) {
		const { id: columnId, text, value } = column;

		// Map based on column mapping configuration
		if (columnId === this.columnMapping.status) {
			task.status = this._mapMondayStatusToTaskStatus(text);
		} else if (columnId === this.columnMapping.description) {
			task.description = text || '';
		} else if (columnId === this.columnMapping.details) {
			task.details = text || '';
		} else if (columnId === this.columnMapping.priority) {
			task.priority = this._mapMondayPriorityToTaskPriority(text);
		} else if (columnId === this.columnMapping.testStrategy) {
			task.testStrategy = text || '';
		} else if (columnId === this.columnMapping.dependencies) {
			task.dependencies = this._parseDependencies(text);
		} else if (columnId === this.columnMapping.taskId) {
			// Handle custom task ID field if configured
			if (text && !isNaN(parseInt(text))) {
				task.id = parseInt(text);
			}
		}
	}

	/**
	 * Update Monday.com item fields based on task data
	 * @private
	 * @param {string} mondayItemId - Monday.com item ID
	 * @param {Object} taskData - Task data to update
	 */
	async _updateMondayItemFields(mondayItemId, taskData) {
		const updatePromises = [];

		// Update status
		if (taskData.status) {
			updatePromises.push(this._updateColumnValue(
				mondayItemId,
				this.columnMapping.status,
				this._mapTaskStatusToMondayStatus(taskData.status),
				'status'
			));
		}

		// Update description
		if (taskData.description) {
			updatePromises.push(this._updateColumnValue(
				mondayItemId,
				this.columnMapping.description,
				taskData.description,
				'text'
			));
		}

		// Update details
		if (taskData.details) {
			updatePromises.push(this._updateColumnValue(
				mondayItemId,
				this.columnMapping.details,
				taskData.details,
				'text'
			));
		}

		// Update priority
		if (taskData.priority) {
			updatePromises.push(this._updateColumnValue(
				mondayItemId,
				this.columnMapping.priority,
				this._mapTaskPriorityToMondayPriority(taskData.priority),
				'status'
			));
		}

		// Update test strategy
		if (taskData.testStrategy) {
			updatePromises.push(this._updateColumnValue(
				mondayItemId,
				this.columnMapping.testStrategy,
				taskData.testStrategy,
				'text'
			));
		}

		// Update dependencies
		if (taskData.dependencies && Array.isArray(taskData.dependencies)) {
			updatePromises.push(this._updateColumnValue(
				mondayItemId,
				this.columnMapping.dependencies,
				taskData.dependencies.join(', '),
				'text'
			));
		}

		// Update custom task ID if configured
		if (taskData.id && this.columnMapping.taskId) {
			updatePromises.push(this._updateColumnValue(
				mondayItemId,
				this.columnMapping.taskId,
				String(taskData.id),
				'text'
			));
		}

		await Promise.all(updatePromises);
	}

	/**
	 * Update a specific column value on Monday.com
	 * @private
	 * @param {string} itemId - Monday.com item ID
	 * @param {string} columnId - Column ID to update
	 * @param {string} value - Value to set
	 * @param {string} columnType - Type of column (text, status, etc.)
	 */
	async _updateColumnValue(itemId, columnId, value, columnType = 'text') {
		if (!columnId || value === undefined || value === null) {
			return; // Skip if column not configured or value is empty
		}

		let mutation;
		let variables;

		if (columnType === 'status') {
			// For status/dropdown columns
			mutation = `
				mutation UpdateStatusColumn($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
					change_column_value(
						board_id: $boardId,
						item_id: $itemId,
						column_id: $columnId,
						value: $value
					) {
						id
					}
				}
			`;
			variables = {
				boardId: this.boardId,
				itemId: itemId,
				columnId: columnId,
				value: JSON.stringify({ label: value })
			};
		} else {
			// For simple text columns
			mutation = `
				mutation UpdateTextColumn($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
					change_simple_column_value(
						board_id: $boardId,
						item_id: $itemId,
						column_id: $columnId,
						value: $value
					) {
						id
					}
				}
			`;
			variables = {
				boardId: this.boardId,
				itemId: itemId,
				columnId: columnId,
				value: String(value)
			};
		}

		try {
			await this.mondayClient._executeWithRateLimit(mutation, variables);
		} catch (error) {
			log('warn', `Failed to update column ${columnId} for item ${itemId}: ${error.message}`);
			// Don't throw - allow other updates to proceed
		}
	}

	/**
	 * Update item name/title on Monday.com
	 * @private
	 * @param {string} itemId - Monday.com item ID
	 * @param {string} newName - New name/title
	 */
	async _updateItemName(itemId, newName) {
		const mutation = `
			mutation UpdateItemName($itemId: ID!, $name: String!) {
				change_multiple_column_values(
					item_id: $itemId,
					board_id: ${this.boardId},
					column_values: "{\"name\": \"${this._escapeForGraphQL(newName)}\"}"
				) {
					id
				}
			}
		`;

		try {
			await this.mondayClient._executeWithRateLimit(mutation, {
				itemId: itemId,
				name: newName
			});
		} catch (error) {
			log('warn', `Failed to update item name for ${itemId}: ${error.message}`);
		}
	}

	/**
	 * Escape string for GraphQL usage
	 * @private
	 * @param {string} str - String to escape
	 * @returns {string} Escaped string
	 */
	_escapeForGraphQL(str) {
		if (!str) return '';
		return str
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/\n/g, '\\n')
			.replace(/\r/g, '\\r')
			.replace(/\t/g, '\\t');
	}

	/**
	 * Map Task Master status to Monday.com status
	 * @private
	 * @param {string} taskStatus - Task Master status
	 * @returns {string} Monday.com status
	 */
	_mapTaskStatusToMondayStatus(taskStatus) {
		const statusMap = {
			'pending': 'Not Started',
			'in-progress': 'Working on it',
			'review': 'Under Review',
			'done': 'Done',
			'blocked': 'Stuck',
			'cancelled': 'Cancelled',
			'deferred': 'Deferred'
		};
		return statusMap[taskStatus.toLowerCase()] || 'Not Started';
	}

	/**
	 * Map Monday.com status to Task Master status
	 * @private
	 * @param {string} mondayStatus - Monday.com status
	 * @returns {string} Task Master status
	 */
	_mapMondayStatusToTaskStatus(mondayStatus) {
		if (!mondayStatus) return 'pending';
		
		const statusMap = {
			'not started': 'pending',
			'working on it': 'in-progress',
			'under review': 'review',
			'done': 'done',
			'stuck': 'blocked',
			'cancelled': 'cancelled',
			'deferred': 'deferred'
		};
		return statusMap[mondayStatus.toLowerCase()] || 'pending';
	}

	/**
	 * Map Task Master priority to Monday.com priority
	 * @private
	 * @param {string} taskPriority - Task Master priority
	 * @returns {string} Monday.com priority
	 */
	_mapTaskPriorityToMondayPriority(taskPriority) {
		const priorityMap = {
			'low': 'Low',
			'medium': 'Medium',
			'high': 'High',
			'critical': 'Critical'
		};
		return priorityMap[taskPriority.toLowerCase()] || 'Medium';
	}

	/**
	 * Map Monday.com priority to Task Master priority
	 * @private
	 * @param {string} mondayPriority - Monday.com priority
	 * @returns {string} Task Master priority
	 */
	_mapMondayPriorityToTaskPriority(mondayPriority) {
		if (!mondayPriority) return 'medium';
		
		const priorityMap = {
			'low': 'low',
			'medium': 'medium',
			'high': 'high',
			'critical': 'critical'
		};
		return priorityMap[mondayPriority.toLowerCase()] || 'medium';
	}

	/**
	 * Parse dependencies string to array
	 * @private
	 * @param {string} dependenciesText - Dependencies as text
	 * @returns {Array} Array of dependency IDs
	 */
	_parseDependencies(dependenciesText) {
		if (!dependenciesText) return [];
		
		return dependenciesText
			.split(',')
			.map(dep => dep.trim())
			.filter(dep => dep && !isNaN(parseInt(dep)))
			.map(dep => parseInt(dep));
	}
}

export default MondayStorageProvider; 