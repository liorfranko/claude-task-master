/**
 * monday-data-transformer.js
 * Data Transformation Layer for Monday.com Integration
 * 
 * This module handles bidirectional conversion between Task Master task objects
 * and Monday.com item representations, ensuring data integrity and proper
 * type conversions throughout the transformation process.
 */

import { log } from './utils.js';
import { TASK_MASTER_SCHEMA } from './monday-board-manager.js';
import { getMondayColumnMapping, getMondayGroupMapping } from './monday-config-manager.js';

/**
 * Task Master to Monday.com field mapping schema
 * Defines how Task Master properties map to Monday.com columns
 */
export const DATA_MAPPING_SCHEMA = {
	// Core task fields
	id: {
		mondayColumn: 'task_id',
		mondayType: 'text',
		transform: (value) => value?.toString() || '',
		reverse: (value) => {
			// Handle dotted IDs like "1.2" for subtasks
			const str = value?.toString() || '';
			return str.includes('.') ? str : parseInt(str, 10) || 0;
		},
		required: true
	},
	title: {
		mondayColumn: 'name', // Built-in Monday.com name column
		mondayType: 'name',
		transform: (value) => value || 'Untitled Task',
		reverse: (value) => value || 'Untitled Task',
		required: true
	},
	description: {
		mondayColumn: 'description',
		mondayType: 'long_text',
		transform: (value) => value || '',
		reverse: (value) => value || '',
		required: false
	},
	status: {
		mondayColumn: 'status',
		mondayType: 'status',
		transform: (value) => mapTaskStatusToMonday(value),
		reverse: (value) => mapMondayStatusToTask(value),
		required: true
	},
	priority: {
		mondayColumn: 'priority',
		mondayType: 'dropdown',
		transform: (value) => mapTaskPriorityToMonday(value),
		reverse: (value) => mapMondayPriorityToTask(value),
		required: false
	},
	dependencies: {
		mondayColumn: 'dependencies',
		mondayType: 'text',
		transform: (value) => {
			if (!Array.isArray(value) || value.length === 0) return '';
			return value.map(dep => dep.toString()).join(',');
		},
		reverse: (value) => {
			if (!value || typeof value !== 'string') return [];
			return value.split(',')
				.map(dep => dep.trim())
				.filter(dep => dep.length > 0)
				.map(dep => dep.includes('.') ? dep : parseInt(dep, 10) || 0);
		},
		required: false
	},
	details: {
		mondayColumn: 'details',
		mondayType: 'long_text',
		transform: (value) => value || '',
		reverse: (value) => value || '',
		required: false
	},
	testStrategy: {
		mondayColumn: 'test_strategy',
		mondayType: 'long_text',
		transform: (value) => value || '',
		reverse: (value) => value || '',
		required: false
	},
	
	// Subtask and hierarchy fields
	parentTask: {
		mondayColumn: 'parent_task',
		mondayType: 'text',
		transform: (value) => value?.toString() || '',
		reverse: (value) => {
			if (!value) return null;
			const str = value.toString();
			return str.includes('.') ? str : parseInt(str, 10) || null;
		},
		required: false
	},
	
	// Metadata fields
	taskType: {
		mondayColumn: 'task_type',
		mondayType: 'dropdown',
		transform: (value, task) => {
			// Determine if this is a subtask based on the task structure
			if (task?.parentTask || (task?.subtasks && task.subtasks.length === 0)) {
				return mapTaskTypeToMonday('subtask');
			}
			return mapTaskTypeToMonday(value || 'task');
		},
		reverse: (value) => mapMondayTaskTypeToTask(value),
		required: false
	},
	complexityScore: {
		mondayColumn: 'complexity_score',
		mondayType: 'numbers',
		transform: (value) => {
			const num = parseInt(value, 10);
			return isNaN(num) ? null : Math.max(1, Math.min(10, num));
		},
		reverse: (value) => {
			const num = parseInt(value, 10);
			return isNaN(num) ? null : num;
		},
		required: false
	},
	createdBy: {
		mondayColumn: 'created_by',
		mondayType: 'people',
		transform: (value) => value || null,
		reverse: (value) => value || null,
		required: false
	},
	assignedTo: {
		mondayColumn: 'assigned_to',
		mondayType: 'people',
		transform: (value) => value || null,
		reverse: (value) => value || null,
		required: false
	}
};

/**
 * Status mapping between Task Master and Monday.com
 */
const STATUS_MAPPING = {
	// Task Master -> Monday.com
	toMonday: {
		'pending': '1',
		'in-progress': '2',
		'done': '3',
		'deferred': '4',
		'cancelled': '5',
		'review': '6',
		'blocked': '7'
	},
	// Monday.com -> Task Master
	fromMonday: {
		'1': 'pending',
		'2': 'in-progress',
		'3': 'done',
		'4': 'deferred',
		'5': 'cancelled',
		'6': 'review',
		'7': 'blocked'
	}
};

/**
 * Priority mapping between Task Master and Monday.com
 */
const PRIORITY_MAPPING = {
	// Task Master -> Monday.com
	toMonday: {
		'low': '1',
		'medium': '2',
		'high': '3',
		'critical': '4'
	},
	// Monday.com -> Task Master
	fromMonday: {
		'1': 'low',
		'2': 'medium',
		'3': 'high',
		'4': 'critical'
	}
};

/**
 * Task type mapping between Task Master and Monday.com
 */
const TASK_TYPE_MAPPING = {
	// Task Master -> Monday.com
	toMonday: {
		'task': '1',
		'subtask': '1', // Both map to 'Feature' by default
		'feature': '1',
		'bug': '2',
		'refactor': '3',
		'documentation': '4',
		'test': '5',
		'research': '6',
		'setup': '7'
	},
	// Monday.com -> Task Master
	fromMonday: {
		'1': 'feature',
		'2': 'bug',
		'3': 'refactor',
		'4': 'documentation',
		'5': 'test',
		'6': 'research',
		'7': 'setup'
	}
};

/**
 * Group mapping based on status
 */
const GROUP_STATUS_MAPPING = {
	'pending': 'pending',
	'in-progress': 'in_progress',
	'done': 'completed',
	'deferred': 'blocked',
	'cancelled': 'blocked',
	'review': 'in_progress',
	'blocked': 'blocked'
};

/**
 * Maps Task Master status to Monday.com status ID
 * @param {string} taskStatus - Task Master status
 * @returns {string} Monday.com status ID
 */
function mapTaskStatusToMonday(taskStatus) {
	const status = (taskStatus || 'pending').toLowerCase();
	return STATUS_MAPPING.toMonday[status] || STATUS_MAPPING.toMonday['pending'];
}

/**
 * Maps Monday.com status ID to Task Master status
 * @param {string|Object} mondayStatus - Monday.com status ID or status object
 * @returns {string} Task Master status
 */
function mapMondayStatusToTask(mondayStatus) {
	// Handle both string IDs and status objects
	const statusId = typeof mondayStatus === 'object' ? mondayStatus?.id : mondayStatus;
	return STATUS_MAPPING.fromMonday[statusId?.toString()] || 'pending';
}

/**
 * Maps Task Master priority to Monday.com priority ID
 * @param {string} taskPriority - Task Master priority
 * @returns {string} Monday.com priority ID
 */
function mapTaskPriorityToMonday(taskPriority) {
	const priority = (taskPriority || 'medium').toLowerCase();
	return PRIORITY_MAPPING.toMonday[priority] || PRIORITY_MAPPING.toMonday['medium'];
}

/**
 * Maps Monday.com priority ID to Task Master priority
 * @param {string|Object} mondayPriority - Monday.com priority ID or priority object
 * @returns {string} Task Master priority
 */
function mapMondayPriorityToTask(mondayPriority) {
	// Handle both string IDs and priority objects
	const priorityId = typeof mondayPriority === 'object' ? mondayPriority?.id : mondayPriority;
	return PRIORITY_MAPPING.fromMonday[priorityId?.toString()] || 'medium';
}

/**
 * Maps Task Master task type to Monday.com task type ID
 * @param {string} taskType - Task Master task type
 * @returns {string} Monday.com task type ID
 */
function mapTaskTypeToMonday(taskType) {
	const type = (taskType || 'task').toLowerCase();
	return TASK_TYPE_MAPPING.toMonday[type] || TASK_TYPE_MAPPING.toMonday['task'];
}

/**
 * Maps Monday.com task type ID to Task Master task type
 * @param {string|Object} mondayTaskType - Monday.com task type ID or task type object
 * @returns {string} Task Master task type
 */
function mapMondayTaskTypeToTask(mondayTaskType) {
	// Handle both string IDs and task type objects
	const typeId = typeof mondayTaskType === 'object' ? mondayTaskType?.id : mondayTaskType;
	return TASK_TYPE_MAPPING.fromMonday[typeId?.toString()] || 'feature';
}

/**
 * Determines the appropriate Monday.com group based on task status
 * @param {string} status - Task Master status
 * @returns {string} Monday.com group key
 */
function getGroupForStatus(status) {
	return GROUP_STATUS_MAPPING[status] || 'pending';
}

/**
 * Transforms a Task Master task object to Monday.com column values
 * @param {Object} task - Task Master task object
 * @param {Object} columnMapping - Current column mapping from configuration
 * @returns {Object} Monday.com column values and metadata
 */
export function transformTaskToMondayColumns(task, columnMapping = null) {
	if (!task || typeof task !== 'object') {
		throw new Error('Invalid task object provided');
	}

	// Get column mapping from config if not provided
	const mapping = columnMapping || getMondayColumnMapping();
	const transformedColumns = {};
	const metadata = {
		group: getGroupForStatus(task.status),
		itemName: task.title || 'Untitled Task'
	};

	try {
		// Transform each field according to the mapping schema
		for (const [taskField, mappingInfo] of Object.entries(DATA_MAPPING_SCHEMA)) {
			const columnId = mapping[mappingInfo.mondayColumn];
			
			if (columnId && task.hasOwnProperty(taskField)) {
				const transformedValue = mappingInfo.transform(task[taskField], task);
				
				// Only include non-null/empty values for optional fields
				if (mappingInfo.required || (transformedValue !== null && transformedValue !== '')) {
					transformedColumns[columnId] = transformedValue;
				}
			}
		}

		// Handle special case for task name (built-in Monday.com field)
		if (task.title) {
			metadata.itemName = task.title;
		}

		return {
			success: true,
			columns: transformedColumns,
			metadata,
			originalTask: task
		};

	} catch (error) {
		log(`[ERROR] Task transformation failed: ${error.message}`, 'error');
		return {
			success: false,
			error: error.message,
			originalTask: task
		};
	}
}

/**
 * Transforms a Monday.com item to a Task Master task object
 * @param {Object} item - Monday.com item object
 * @param {Object} schema - Board schema information
 * @param {Object} columnMapping - Current column mapping from configuration
 * @returns {Object} Task Master task object
 */
export function transformMondayItemToTask(item, schema = null, columnMapping = null) {
	if (!item || typeof item !== 'object') {
		throw new Error('Invalid Monday.com item provided');
	}

	// Get column mapping from config if not provided
	const mapping = columnMapping || getMondayColumnMapping();
	
	// Create reverse mapping (columnId -> taskField)
	const reverseMapping = {};
	for (const [taskField, mappingInfo] of Object.entries(DATA_MAPPING_SCHEMA)) {
		const columnId = mapping[mappingInfo.mondayColumn];
		if (columnId) {
			reverseMapping[columnId] = { taskField, mappingInfo };
		}
	}

	try {
		const task = {
			// Start with default Task Master structure
			id: null,
			title: item.name || 'Untitled Task',
			description: '',
			status: 'pending',
			dependencies: [],
			priority: 'medium',
			details: '',
			testStrategy: '',
			subtasks: []
		};

		// Transform column values back to task properties
		if (item.column_values && Array.isArray(item.column_values)) {
			for (const column of item.column_values) {
				const mappingEntry = reverseMapping[column.id];
				
				if (mappingEntry) {
					const { taskField, mappingInfo } = mappingEntry;
					const transformedValue = mappingInfo.reverse(column.value || column.text);
					
					// Set the task property
					task[taskField] = transformedValue;
				}
			}
		}

		// Handle built-in name field
		if (item.name) {
			task.title = item.name;
		}

		// Ensure required fields have valid values
		if (!task.id) {
			log('[WARN] Task missing ID during transformation', 'warn');
			task.id = parseInt(item.id) || 0;
		}

		return {
			success: true,
			task,
			originalItem: item
		};

	} catch (error) {
		log(`[ERROR] Monday.com item transformation failed: ${error.message}`, 'error');
		return {
			success: false,
			error: error.message,
			originalItem: item
		};
	}
}

/**
 * Transforms multiple Monday.com items to Task Master task objects
 * @param {Array} items - Array of Monday.com item objects
 * @param {Object} schema - Board schema information
 * @param {Object} columnMapping - Current column mapping from configuration
 * @returns {Object} Batch transformation result
 */
export function transformMondayItemsToTasks(items, schema = null, columnMapping = null) {
	if (!Array.isArray(items)) {
		throw new Error('Items must be an array');
	}

	const results = {
		success: true,
		tasks: [],
		errors: [],
		totalItems: items.length,
		successfulTransformations: 0
	};

	try {
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const transformResult = transformMondayItemToTask(item, schema, columnMapping);
			
			if (transformResult.success) {
				results.tasks.push(transformResult.task);
				results.successfulTransformations++;
			} else {
				results.errors.push({
					index: i,
					itemId: item.id,
					error: transformResult.error
				});
				results.success = false;
			}
		}

		// Sort tasks by ID to maintain order
		results.tasks.sort((a, b) => {
			const aId = typeof a.id === 'string' ? parseFloat(a.id) : a.id;
			const bId = typeof b.id === 'string' ? parseFloat(b.id) : b.id;
			return aId - bId;
		});

		return results;

	} catch (error) {
		log(`[ERROR] Batch transformation failed: ${error.message}`, 'error');
		return {
			success: false,
			error: error.message,
			tasks: [],
			errors: [{ error: error.message }],
			totalItems: items.length,
			successfulTransformations: 0
		};
	}
}

/**
 * Validates transformed data to ensure integrity
 * @param {Object} original - Original data object
 * @param {Object} transformed - Transformed data object
 * @param {string} direction - Transformation direction ('toMonday' or 'toTask')
 * @returns {Object} Validation result
 */
export function validateTransformedData(original, transformed, direction = 'toMonday') {
	const validation = {
		valid: true,
		errors: [],
		warnings: [],
		details: {
			originalType: direction === 'toMonday' ? 'task' : 'mondayItem',
			transformedType: direction === 'toMonday' ? 'mondayColumns' : 'task',
			fieldsChecked: 0,
			fieldsValid: 0
		}
	};

	try {
		if (direction === 'toMonday') {
			// Validate task -> Monday.com transformation
			return validateTaskToMondayTransformation(original, transformed, validation);
		} else {
			// Validate Monday.com -> task transformation  
			return validateMondayToTaskTransformation(original, transformed, validation);
		}

	} catch (error) {
		validation.valid = false;
		validation.errors.push(`Validation failed: ${error.message}`);
		return validation;
	}
}

/**
 * Validates task to Monday.com transformation
 * @param {Object} task - Original task object
 * @param {Object} result - Transformation result
 * @param {Object} validation - Validation object to populate
 * @returns {Object} Updated validation result
 */
function validateTaskToMondayTransformation(task, result, validation) {
	if (!result.success) {
		validation.valid = false;
		validation.errors.push('Transformation was not successful');
		return validation;
	}

	const { columns, metadata } = result;

	// Check required fields
	const requiredFields = ['id', 'title', 'status'];
	for (const field of requiredFields) {
		validation.details.fieldsChecked++;
		
		if (!task[field]) {
			validation.errors.push(`Required field '${field}' is missing from original task`);
			validation.valid = false;
		} else {
			validation.details.fieldsValid++;
		}
	}

	// Check metadata
	if (!metadata.itemName) {
		validation.warnings.push('Item name is missing from metadata');
	}

	// Check group assignment
	if (!metadata.group) {
		validation.warnings.push('Group assignment is missing from metadata');
	}

	// Verify no data loss for important fields
	const importantFields = ['id', 'title', 'description', 'status', 'priority'];
	for (const field of importantFields) {
		if (task[field] && !Object.values(columns).some(val => val && val.toString().includes(task[field].toString()))) {
			validation.warnings.push(`Field '${field}' value may not be properly preserved in transformation`);
		}
	}

	return validation;
}

/**
 * Validates Monday.com to task transformation
 * @param {Object} item - Original Monday.com item
 * @param {Object} result - Transformation result
 * @param {Object} validation - Validation object to populate
 * @returns {Object} Updated validation result
 */
function validateMondayToTaskTransformation(item, result, validation) {
	if (!result.success) {
		validation.valid = false;
		validation.errors.push('Transformation was not successful');
		return validation;
	}

	const { task } = result;

	// Check required task fields
	const requiredFields = ['id', 'title', 'status'];
	for (const field of requiredFields) {
		validation.details.fieldsChecked++;
		
		if (!task[field]) {
			validation.errors.push(`Required field '${field}' is missing from transformed task`);
			validation.valid = false;
		} else {
			validation.details.fieldsValid++;
		}
	}

	// Check data types
	if (task.id && typeof task.id !== 'number' && typeof task.id !== 'string') {
		validation.errors.push('Task ID must be a number or string');
		validation.valid = false;
	}

	if (task.dependencies && !Array.isArray(task.dependencies)) {
		validation.errors.push('Dependencies must be an array');
		validation.valid = false;
	}

	if (task.subtasks && !Array.isArray(task.subtasks)) {
		validation.errors.push('Subtasks must be an array');
		validation.valid = false;
	}

	// Check item name preservation
	if (item.name && task.title !== item.name) {
		validation.warnings.push('Item name may not be properly preserved');
	}

	return validation;
}

/**
 * Creates a round-trip transformation test
 * @param {Object} originalTask - Original Task Master task
 * @param {Object} columnMapping - Column mapping configuration
 * @returns {Object} Round-trip test result
 */
export function testRoundTripTransformation(originalTask, columnMapping = null) {
	try {
		// Transform to Monday.com format
		const toMondayResult = transformTaskToMondayColumns(originalTask, columnMapping);
		
		if (!toMondayResult.success) {
			return {
				success: false,
				stage: 'toMonday',
				error: toMondayResult.error
			};
		}

		// Create a mock Monday.com item for reverse transformation
		const mockItem = {
			id: '123',
			name: toMondayResult.metadata.itemName,
			column_values: Object.entries(toMondayResult.columns).map(([id, value]) => ({
				id,
				value,
				text: value
			}))
		};

		// Transform back to task format
		const toTaskResult = transformMondayItemToTask(mockItem, null, columnMapping);
		
		if (!toTaskResult.success) {
			return {
				success: false,
				stage: 'toTask',
				error: toTaskResult.error
			};
		}

		// Compare original and final task
		const comparison = compareTaskObjects(originalTask, toTaskResult.task);

		return {
			success: comparison.identical,
			originalTask,
			mondayColumns: toMondayResult.columns,
			transformedTask: toTaskResult.task,
			comparison,
			stages: {
				toMonday: toMondayResult,
				toTask: toTaskResult
			}
		};

	} catch (error) {
		return {
			success: false,
			error: error.message
		};
	}
}

/**
 * Compares two task objects for differences
 * @param {Object} task1 - First task object
 * @param {Object} task2 - Second task object
 * @returns {Object} Comparison result
 */
function compareTaskObjects(task1, task2) {
	const comparison = {
		identical: true,
		differences: [],
		fieldsCompared: 0
	};

	const fieldsToCompare = ['id', 'title', 'description', 'status', 'priority', 'dependencies', 'details', 'testStrategy'];

	for (const field of fieldsToCompare) {
		comparison.fieldsCompared++;
		
		const val1 = task1[field];
		const val2 = task2[field];

		if (Array.isArray(val1) && Array.isArray(val2)) {
			// Compare arrays
			if (val1.length !== val2.length || !val1.every((v, i) => v === val2[i])) {
				comparison.identical = false;
				comparison.differences.push({
					field,
					original: val1,
					transformed: val2,
					type: 'array_mismatch'
				});
			}
		} else if (val1 !== val2) {
			// Compare primitive values
			comparison.identical = false;
			comparison.differences.push({
				field,
				original: val1,
				transformed: val2,
				type: 'value_mismatch'
			});
		}
	}

	return comparison;
}

export {
	STATUS_MAPPING,
	PRIORITY_MAPPING,
	TASK_TYPE_MAPPING,
	GROUP_STATUS_MAPPING
}; 