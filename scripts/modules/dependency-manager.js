/**
 * dependency-manager.js
 * Manages task dependencies and relationships
 */

import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';

import {
	log,
	readJSON,
	writeJSON,
	taskExists,
	formatTaskId,
	findCycles,
	isSilentMode
} from './utils.js';

import { displayBanner } from './ui.js';

import { generateTaskFiles } from './task-manager.js';

// Import persistence manager for unified data access
import { persistenceManager } from './persistence-manager.js';

// Import Monday.com specific modules for dependency handling
import { getMondayEnabled, getMondayConfig, getMondayColumnMapping } from './monday-config-manager.js';
import { MondayApiClient } from './monday-api-client.js';
import { transformTaskToMondayColumns } from './monday-data-transformer.js';

/**
 * Add a dependency to a task
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {number|string} taskId - ID of the task to add dependency to
 * @param {number|string} dependencyId - ID of the task to add as dependency
 * @param {Object} context - Context object with session, projectRoot, etc.
 */
async function addDependency(tasksPath, taskId, dependencyId, context = {}) {
	const { session, projectRoot } = context;
	
	log('info', `Adding dependency ${dependencyId} to task ${taskId}...`);

	// Initialize persistence manager with project context
	await persistenceManager.initialize(projectRoot, session);

	// Check if Monday.com is enabled for enhanced dependency management
	const mondayEnabled = getMondayEnabled();
	const mondayConfig = mondayEnabled ? getMondayConfig() : null;
	const mondayColumnMapping = mondayEnabled ? getMondayColumnMapping() : null;

	// Use persistence manager to read tasks
	const data = await persistenceManager.readTasks(tasksPath, { projectRoot, session });
	if (!data || !data.tasks) {
		log('error', 'No valid tasks found');
		process.exit(1);
	}

	// Format the task and dependency IDs correctly
	const formattedTaskId =
		typeof taskId === 'string' && taskId.includes('.')
			? taskId
			: parseInt(taskId, 10);

	const formattedDependencyId = formatTaskId(dependencyId);

	// Check if the dependency task or subtask actually exists
	if (!taskExists(data.tasks, formattedDependencyId)) {
		log(
			'error',
			`Dependency target ${formattedDependencyId} does not exist`
		);
		process.exit(1);
	}

	// Find the task to update
	let targetTask = null;
	let isSubtask = false;

	if (typeof formattedTaskId === 'string' && formattedTaskId.includes('.')) {
		// Handle dot notation for subtasks (e.g., "1.2")
		const [parentId, subtaskId] = formattedTaskId
			.split('.')
			.map((id) => parseInt(id, 10));
		const parentTask = data.tasks.find((t) => t.id === parentId);

		if (!parentTask) {
			log('error', `Parent task ${parentId} not found.`);
			process.exit(1);
		}

		if (!parentTask.subtasks) {
			log('error', `Parent task ${parentId} has no subtasks.`);
			process.exit(1);
		}

		targetTask = parentTask.subtasks.find((s) => s.id === subtaskId);
		isSubtask = true;

		if (!targetTask) {
			log('error', `Subtask ${formattedTaskId} not found.`);
			process.exit(1);
		}
	} else {
		// Regular task (not a subtask)
		targetTask = data.tasks.find((t) => t.id === formattedTaskId);

		if (!targetTask) {
			log('error', `Task ${formattedTaskId} not found.`);
			process.exit(1);
		}
	}

	// Initialize dependencies array if it doesn't exist
	if (!targetTask.dependencies) {
		targetTask.dependencies = [];
	}

	// Check if dependency already exists
	if (
		targetTask.dependencies.some((d) => {
			// Convert both to strings for comparison to handle both numeric and string IDs
			return String(d) === String(formattedDependencyId);
		})
	) {
		log(
			'warn',
			`Dependency ${formattedDependencyId} already exists in task ${formattedTaskId}.`
		);
		return;
	}

	// Enhanced validation using new Monday.com-aware utilities
	let mondayContext = null;
	if (mondayEnabled && mondayConfig && mondayColumnMapping) {
		try {
			// Get the Monday.com API client
			const MondayApiClient = await import('./monday-api-client.js');
			const mondayClient = MondayApiClient.getMondayApiClient();
			
			if (!mondayClient.initialized) {
				const apiKey = session?.env?.MONDAY_API_KEY || process.env.MONDAY_API_KEY;
				if (apiKey) {
					await mondayClient.initializeClient(apiKey);
				}
			}

			if (mondayClient.initialized) {
				mondayContext = {
					enabled: true,
					mondayClient,
					boardId: mondayConfig.boardId,
					relationColumnId: mondayColumnMapping.dependencies?.mondayColumn || 'dependencies'
				};
			}
		} catch (error) {
			log('warn', `Failed to initialize Monday.com context for validation: ${error.message}`);
		}
	}

	// Comprehensive dependency validation
	const validationResult = await DependencyValidationUtils.validateDependencyRelationship({
		tasks: data.tasks,
		taskId: formattedTaskId,
		dependencyId: formattedDependencyId,
		mondayContext,
		validateExistence: true,
		validateCircular: true,
		validateSelfDependency: true
	});

	if (!validationResult.valid) {
		const errorMessages = validationResult.issues.map(issue => issue.message).join('\n');
		log('error', `Cannot add dependency:\n${errorMessages}`);
		
		// Display detailed error information
		if (!isSilentMode()) {
			console.log(
				boxen(
					chalk.red(`Dependency Validation Failed:\n\n`) +
						validationResult.issues.map(issue => 
							`${chalk.yellow(`[${issue.type.toUpperCase()}]`)} ${issue.message}`
						).join('\n'),
					{
						padding: 1,
						borderColor: 'red',
						borderStyle: 'round',
						margin: { top: 1 }
					}
				)
			);
		}
		process.exit(1);
	}

	// Validation passed - proceed with adding the dependency
	targetTask.dependencies.push(formattedDependencyId);

	// Sort dependencies numerically or by parent task ID first, then subtask ID
	targetTask.dependencies.sort((a, b) => {
		if (typeof a === 'number' && typeof b === 'number') {
			return a - b;
		} else if (typeof a === 'string' && typeof b === 'string') {
			const [aParent, aChild] = a.split('.').map(Number);
			const [bParent, bChild] = b.split('.').map(Number);
			return aParent !== bParent ? aParent - bParent : aChild - bChild;
		} else if (typeof a === 'number') {
			return -1; // Numbers come before strings
		} else {
			return 1; // Strings come after numbers
		}
	});

	// If Monday.com is enabled, also update the board relation column
	let mondayRelationSuccess = true;
	if (mondayContext && mondayContext.enabled) {
		try {
			log('info', 'Updating Monday.com board relation for dependency...');
			
			// Convert task IDs to Monday.com item IDs for board relations
			const mondayTaskId = typeof formattedTaskId === 'string' && formattedTaskId.includes('.') 
				? parseInt(formattedTaskId.split('.')[0], 10) 
				: parseInt(formattedTaskId, 10);
			const mondayDependencyItemId = typeof formattedDependencyId === 'string' && formattedDependencyId.includes('.') 
				? parseInt(formattedDependencyId.split('.')[0], 10) 
				: parseInt(formattedDependencyId, 10);
			
			// Add the board relation in Monday.com
			await mondayContext.mondayClient.addBoardRelation(
				mondayTaskId, 
				mondayContext.relationColumnId, 
				mondayDependencyItemId
			);
			
			log('success', `Updated Monday.com board relation: Item ${mondayTaskId} now depends on ${mondayDependencyItemId}`);
		} catch (mondayError) {
			log('warn', `Failed to update Monday.com board relation: ${mondayError.message}`);
			log('info', 'Continuing with local dependency storage...');
			mondayRelationSuccess = false;
		}
	}

	// Use persistence manager to save changes
	await persistenceManager.writeTasks(tasksPath, data, { projectRoot, session });
	
	log(
		'success',
		`Added dependency ${formattedDependencyId} to task ${formattedTaskId}`
	);

	// Display a more visually appealing success message
	if (!isSilentMode()) {
		const mondayStatus = mondayContext && mondayContext.enabled && mondayRelationSuccess ? 
			chalk.green(' (✓ Monday.com synced)') : 
			mondayContext && mondayContext.enabled ? chalk.yellow(' (⚠ Monday.com sync failed)') : '';
			
		console.log(
			boxen(
				chalk.green(`Successfully added dependency:\n\n`) +
					`Task ${chalk.bold(formattedTaskId)} now depends on ${chalk.bold(formattedDependencyId)}` +
					mondayStatus,
				{
					padding: 1,
					borderColor: 'green',
					borderStyle: 'round',
					margin: { top: 1 }
				}
			)
		);
	}

	// Generate updated task files
	await generateTaskFiles(tasksPath, path.dirname(tasksPath), {}, { session, projectRoot });

	log('info', 'Task files regenerated with updated dependencies.');
}

/**
 * Remove a dependency from a task
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {number|string} taskId - ID of the task to remove dependency from
 * @param {number|string} dependencyId - ID of the task to remove as dependency
 * @param {Object} context - Context object with session, projectRoot, etc.
 */
async function removeDependency(tasksPath, taskId, dependencyId, context = {}) {
	const { session, projectRoot } = context;
	
	log('info', `Removing dependency ${dependencyId} from task ${taskId}...`);

	// Initialize persistence manager with project context
	await persistenceManager.initialize(projectRoot, session);

	// Check if Monday.com is enabled for enhanced dependency management
	const mondayEnabled = getMondayEnabled();
	const mondayConfig = mondayEnabled ? getMondayConfig() : null;
	const mondayColumnMapping = mondayEnabled ? getMondayColumnMapping() : null;

	// Use persistence manager to read tasks
	const data = await persistenceManager.readTasks(tasksPath, { projectRoot, session });
	if (!data || !data.tasks) {
		log('error', 'No valid tasks found.');
		process.exit(1);
	}

	// Format the task and dependency IDs correctly
	const formattedTaskId =
		typeof taskId === 'string' && taskId.includes('.')
			? taskId
			: parseInt(taskId, 10);

	const formattedDependencyId = formatTaskId(dependencyId);

	// Initialize Monday.com context for validation
	let mondayContext = null;
	if (mondayEnabled && mondayConfig && mondayColumnMapping) {
		try {
			// Get the Monday.com API client
			const MondayApiClient = await import('./monday-api-client.js');
			const mondayClient = MondayApiClient.getMondayApiClient();
			
			if (!mondayClient.initialized) {
				const apiKey = session?.env?.MONDAY_API_KEY || process.env.MONDAY_API_KEY;
				if (apiKey) {
					await mondayClient.initializeClient(apiKey);
				}
			}

			if (mondayClient.initialized) {
				mondayContext = {
					enabled: true,
					mondayClient,
					boardId: mondayConfig.boardId,
					relationColumnId: mondayColumnMapping.dependencies?.mondayColumn || 'dependencies'
				};
			}
		} catch (error) {
			log('warn', `Failed to initialize Monday.com context for validation: ${error.message}`);
		}
	}

	// Validate task existence before proceeding
	const taskExistenceResult = await DependencyValidationUtils.validateTaskExistence(
		data.tasks, 
		formattedTaskId, 
		mondayContext
	);

	if (!taskExistenceResult.valid) {
		log('error', `Task ${formattedTaskId} does not exist`);
		
		if (!isSilentMode()) {
			console.log(
				boxen(
					chalk.red(`Task Not Found:\n\n`) +
						`Task ${chalk.bold(formattedTaskId)} does not exist in the system`,
					{
						padding: 1,
						borderColor: 'red',
						borderStyle: 'round',
						margin: { top: 1 }
					}
				)
			);
		}
		process.exit(1);
	}

	// Find the task to update
	let targetTask = null;
	let isSubtask = false;

	if (typeof formattedTaskId === 'string' && formattedTaskId.includes('.')) {
		// Handle dot notation for subtasks (e.g., "1.2")
		const [parentId, subtaskId] = formattedTaskId
			.split('.')
			.map((id) => parseInt(id, 10));
		const parentTask = data.tasks.find((t) => t.id === parentId);

		if (!parentTask) {
			log('error', `Parent task ${parentId} not found.`);
			process.exit(1);
		}

		if (!parentTask.subtasks) {
			log('error', `Parent task ${parentId} has no subtasks.`);
			process.exit(1);
		}

		targetTask = parentTask.subtasks.find((s) => s.id === subtaskId);
		isSubtask = true;

		if (!targetTask) {
			log('error', `Subtask ${formattedTaskId} not found.`);
			process.exit(1);
		}
	} else {
		// Regular task (not a subtask)
		targetTask = data.tasks.find((t) => t.id === formattedTaskId);

		if (!targetTask) {
			log('error', `Task ${formattedTaskId} not found.`);
			process.exit(1);
		}
	}

	// Check if the task has any dependencies
	if (!targetTask.dependencies || targetTask.dependencies.length === 0) {
		log(
			'info',
			`Task ${formattedTaskId} has no dependencies, nothing to remove.`
		);
		return;
	}

	// Normalize the dependency ID for comparison to handle different formats
	const normalizedDependencyId = String(formattedDependencyId);

	// Check if the dependency exists by comparing string representations
	const dependencyIndex = targetTask.dependencies.findIndex((dep) => {
		// Convert both to strings for comparison
		let depStr = String(dep);

		// Special handling for numeric IDs that might be subtask references
		if (typeof dep === 'number' && dep < 100 && isSubtask) {
			// It's likely a reference to another subtask in the same parent task
			// Convert to full format for comparison (e.g., 2 -> "1.2" for a subtask in task 1)
			const [parentId] = formattedTaskId.split('.');
			depStr = `${parentId}.${dep}`;
		}

		return depStr === normalizedDependencyId;
	});

	if (dependencyIndex === -1) {
		// Enhanced validation to provide better error messaging
		const dependencyExistenceResult = await DependencyValidationUtils.validateTaskExistence(
			data.tasks, 
			formattedDependencyId, 
			mondayContext
		);

		let errorMessage = `Task ${formattedTaskId} does not depend on ${formattedDependencyId}`;
		if (!dependencyExistenceResult.valid) {
			errorMessage += ` (dependency target does not exist)`;
		}

		log('info', `${errorMessage}, no changes made.`);
		
		if (!isSilentMode()) {
			console.log(
				boxen(
					chalk.yellow(`Dependency Not Found:\n\n`) +
						errorMessage,
					{
						padding: 1,
						borderColor: 'yellow',
						borderStyle: 'round',
						margin: { top: 1 }
					}
				)
			);
		}
		return;
	}

	// Remove the dependency from local data structure
	targetTask.dependencies.splice(dependencyIndex, 1);

	// If Monday.com is enabled, also update the board relation column
	let mondayRelationSuccess = true;
	if (mondayEnabled && mondayConfig && mondayColumnMapping && mondayContext && mondayContext.enabled) {
		try {
			log('info', 'Removing Monday.com board relation for dependency...');
			
			const { mondayClient, boardId, relationColumnId } = mondayContext;
			
			// Convert task ID to Monday.com item ID (assuming 1:1 mapping for now)
			// In a full implementation, you might need a mapping table
			const mondayItemId = parseInt(formattedTaskId, 10);
			const mondayDependencyItemId = parseInt(formattedDependencyId, 10);
			
			// Remove the board relation in Monday.com
			await mondayClient.removeBoardRelation(
				mondayItemId, 
				relationColumnId, 
				mondayDependencyItemId
			);
			
			log('success', `Removed Monday.com board relation: Item ${mondayItemId} no longer depends on ${mondayDependencyItemId}`);
		} catch (mondayError) {
			log('warn', `Failed to update Monday.com board relation: ${mondayError.message}`);
			log('info', 'Continuing with local dependency removal...');
			mondayRelationSuccess = false;
		}
	}

	// Use persistence manager to save the updated tasks
	await persistenceManager.writeTasks(tasksPath, data, { projectRoot, session });

	// Success message
	log(
		'success',
		`Removed dependency: Task ${formattedTaskId} no longer depends on ${formattedDependencyId}`
	);

	if (!isSilentMode()) {
		// Display a more visually appealing success message with Monday.com status
		const mondayStatus = mondayEnabled && mondayRelationSuccess ? 
			chalk.green(' (✓ Monday.com synced)') : 
			mondayEnabled ? chalk.yellow(' (⚠ Monday.com sync failed)') : '';
			
		console.log(
			boxen(
				chalk.green(`Successfully removed dependency:\n\n`) +
					`Task ${chalk.bold(formattedTaskId)} no longer depends on ${chalk.bold(formattedDependencyId)}` +
					mondayStatus,
				{
					padding: 1,
					borderColor: 'green',
					borderStyle: 'round',
					margin: { top: 1 }
				}
			)
		);
	}

	// Regenerate task files
	await generateTaskFiles(tasksPath, path.dirname(tasksPath), {}, { session, projectRoot });

	log('info', 'Task files regenerated with updated dependencies.');
}

/**
 * Check if adding a dependency would create a circular dependency
 * @param {Array} tasks - Array of all tasks
 * @param {number|string} taskId - ID of task to check
 * @param {Array} chain - Chain of dependencies to check
 * @returns {boolean} True if circular dependency would be created
 */
function isCircularDependency(tasks, taskId, chain = []) {
	// Convert taskId to string for comparison
	const taskIdStr = String(taskId);

	// If we've seen this task before in the chain, we have a circular dependency
	if (chain.some((id) => String(id) === taskIdStr)) {
		return true;
	}

	// Find the task or subtask
	let task = null;
	let parentIdForSubtask = null;

	// Check if this is a subtask reference (e.g., "1.2")
	if (taskIdStr.includes('.')) {
		const [parentId, subtaskId] = taskIdStr.split('.').map(Number);
		const parentTask = tasks.find((t) => t.id === parentId);
		parentIdForSubtask = parentId; // Store parent ID if it's a subtask

		if (parentTask && parentTask.subtasks) {
			task = parentTask.subtasks.find((st) => st.id === subtaskId);
		}
	} else {
		// Regular task
		task = tasks.find((t) => String(t.id) === taskIdStr);
	}

	if (!task) {
		return false; // Task doesn't exist, can't create circular dependency
	}

	// No dependencies, can't create circular dependency
	if (!task.dependencies || task.dependencies.length === 0) {
		return false;
	}

	// Check each dependency recursively
	const newChain = [...chain, taskIdStr]; // Use taskIdStr for consistency
	return task.dependencies.some((depId) => {
		let normalizedDepId = String(depId);
		// Normalize relative subtask dependencies
		if (typeof depId === 'number' && parentIdForSubtask !== null) {
			// If the current task is a subtask AND the dependency is a number,
			// assume it refers to a sibling subtask.
			normalizedDepId = `${parentIdForSubtask}.${depId}`;
		}
		// Pass the normalized ID to the recursive call
		return isCircularDependency(tasks, normalizedDepId, newChain);
	});
}

/**
 * Enhanced validation utilities for Monday.com compatibility
 */
class DependencyValidationUtils {
	/**
	 * Helper function to check if a Monday.com item exists
	 * @param {Object} mondayClient - Monday.com API client
	 * @param {number} itemId - Item ID to check
	 * @returns {boolean} True if item exists
	 */
	static async checkMondayItemExists(mondayClient, itemId) {
		try {
			await mondayClient.getItemDetails(itemId, ['id']);
			return true;
		} catch (error) {
			// If item doesn't exist, getItemDetails will throw an error
			return false;
		}
	}

	/**
	 * Validate task existence with Monday.com support
	 * @param {Array} tasks - Local tasks array
	 * @param {string|number} taskId - Task ID to validate
	 * @param {Object} mondayContext - Optional Monday.com context
	 * @returns {Object} Validation result with existence status and Monday.com info
	 */
	static async validateTaskExistence(tasks, taskId, mondayContext = null) {
		// First check local existence using existing utility
		const localExists = taskExists(tasks, taskId);
		
		// If Monday.com context is provided, also validate against Monday.com
		if (mondayContext && mondayContext.enabled) {
			try {
				const { mondayClient, boardId } = mondayContext;
				
				// Convert task ID to Monday.com item ID
				let mondayItemId;
				if (typeof taskId === 'string' && taskId.includes('.')) {
					// For subtasks, use parent task ID for Monday.com validation
					const [parentId] = taskId.split('.');
					mondayItemId = parseInt(parentId, 10);
				} else {
					mondayItemId = parseInt(taskId, 10);
				}
				
				// Check if item exists in Monday.com board
				const mondayExists = await this.checkMondayItemExists(mondayClient, mondayItemId);
				
				return {
					localExists,
					mondayExists,
					taskId,
					mondayItemId,
					valid: localExists && mondayExists,
					source: 'hybrid'
				};
			} catch (error) {
				log('warn', `Failed to validate task existence in Monday.com: ${error.message}`);
				// Fallback to local validation only
				return {
					localExists,
					mondayExists: null,
					taskId,
					valid: localExists,
					source: 'local',
					error: error.message
				};
			}
		}
		
		// Local validation only
		return {
			localExists,
			mondayExists: null,
			taskId,
			valid: localExists,
			source: 'local'
		};
	}

	/**
	 * Enhanced circular dependency detection with Monday.com board relation support
	 * @param {Array} tasks - Local tasks array
	 * @param {string|number} taskId - Task ID to check
	 * @param {Array} chain - Current dependency chain
	 * @param {Object} mondayContext - Optional Monday.com context
	 * @returns {Object} Circular dependency validation result
	 */
	static async validateCircularDependency(tasks, taskId, chain = [], mondayContext = null) {
		// Use existing circular dependency logic as baseline
		const localCircular = isCircularDependency(tasks, taskId, chain);
		
		// If Monday.com context is provided, validate against board relations
		if (mondayContext && mondayContext.enabled && !localCircular) {
			try {
				const { mondayClient, boardId, relationColumnId } = mondayContext;
				
				// Convert task ID to Monday.com item ID
				let mondayItemId;
				if (typeof taskId === 'string' && taskId.includes('.')) {
					const [parentId] = taskId.split('.');
					mondayItemId = parseInt(parentId, 10);
				} else {
					mondayItemId = parseInt(taskId, 10);
				}
				
				// Check for circular dependencies using Monday.com board relations
				const mondayCircular = await this.checkMondayCircularDependency(
					mondayClient, 
					boardId, 
					relationColumnId, 
					mondayItemId, 
					chain.map(id => typeof id === 'string' && id.includes('.') ? parseInt(id.split('.')[0], 10) : parseInt(id, 10))
				);
				
				return {
					localCircular,
					mondayCircular,
					taskId,
					chain: [...chain],
					hasCircularDependency: localCircular || mondayCircular,
					source: 'hybrid'
				};
			} catch (error) {
				log('warn', `Failed to validate circular dependency in Monday.com: ${error.message}`);
				// Fallback to local validation
				return {
					localCircular,
					mondayCircular: null,
					taskId,
					chain: [...chain],
					hasCircularDependency: localCircular,
					source: 'local',
					error: error.message
				};
			}
		}
		
		// Local validation only
		return {
			localCircular,
			mondayCircular: null,
			taskId,
			chain: [...chain],
			hasCircularDependency: localCircular,
			source: 'local'
		};
	}

	/**
	 * Check circular dependencies using Monday.com board relations
	 * @param {Object} mondayClient - Monday.com API client
	 * @param {string} boardId - Monday.com board ID
	 * @param {string} relationColumnId - Board relation column ID
	 * @param {number} itemId - Monday.com item ID to check
	 * @param {Array} visitedIds - Array of already visited item IDs
	 * @returns {boolean} True if circular dependency detected
	 */
	static async checkMondayCircularDependency(mondayClient, boardId, relationColumnId, itemId, visitedIds = []) {
		// If we've seen this item before, we have a circular dependency
		if (visitedIds.includes(itemId)) {
			return true;
		}
		
		// Get the item's dependencies from Monday.com board relation column
		try {
			const itemDetails = await mondayClient.getItemDetails(itemId, [relationColumnId]);
			const relationValue = itemDetails.column_values.find(cv => cv.id === relationColumnId);
			
			if (!relationValue || !relationValue.value) {
				return false; // No dependencies
			}
			
			// Parse the board relation value to get linked item IDs
			const relationData = JSON.parse(relationValue.value);
			const linkedItemIds = relationData.linkedPulseIds || [];
			
			if (linkedItemIds.length === 0) {
				return false; // No dependencies
			}
			
			// Check each dependency recursively
			const newVisitedIds = [...visitedIds, itemId];
			for (const linkedItemId of linkedItemIds) {
				const hasCircular = await this.checkMondayCircularDependency(
					mondayClient, 
					boardId, 
					relationColumnId, 
					linkedItemId, 
					newVisitedIds
				);
				if (hasCircular) {
					return true;
				}
			}
			
			return false;
		} catch (error) {
			log('warn', `Failed to check Monday.com circular dependency for item ${itemId}: ${error.message}`);
			return false; // Assume no circular dependency on error
		}
	}

	/**
	 * Validate dependency relationship with Monday.com constraints
	 * @param {Object} params - Validation parameters
	 * @returns {Object} Comprehensive validation result
	 */
	static async validateDependencyRelationship(params) {
		const {
			tasks,
			taskId,
			dependencyId,
			mondayContext = null,
			validateExistence = true,
			validateCircular = true,
			validateSelfDependency = true
		} = params;

		const issues = [];
		let valid = true;

		// Self-dependency validation
		if (validateSelfDependency && String(taskId) === String(dependencyId)) {
			issues.push({
				type: 'self',
				taskId,
				dependencyId,
				message: `Task ${taskId} cannot depend on itself`,
				source: 'validation'
			});
			valid = false;
		}

		// Task existence validation
		if (validateExistence) {
			const taskExistenceResult = await this.validateTaskExistence(tasks, taskId, mondayContext);
			const depExistenceResult = await this.validateTaskExistence(tasks, dependencyId, mondayContext);

			if (!taskExistenceResult.valid) {
				issues.push({
					type: 'missing',
					taskId,
					dependencyId: null,
					message: `Task ${taskId} does not exist`,
					source: taskExistenceResult.source,
					mondayDetails: taskExistenceResult
				});
				valid = false;
			}

			if (!depExistenceResult.valid) {
				issues.push({
					type: 'missing',
					taskId,
					dependencyId,
					message: `Dependency ${dependencyId} does not exist`,
					source: depExistenceResult.source,
					mondayDetails: depExistenceResult
				});
				valid = false;
			}
		}

		// Circular dependency validation
		if (validateCircular && valid) {
			const circularResult = await this.validateCircularDependency(
				tasks, 
				dependencyId, 
				[taskId], 
				mondayContext
			);

			if (circularResult.hasCircularDependency) {
				issues.push({
					type: 'circular',
					taskId,
					dependencyId,
					message: `Adding dependency ${dependencyId} to task ${taskId} would create a circular dependency`,
					chain: circularResult.chain,
					source: circularResult.source
				});
				valid = false;
			}
		}

		// Monday.com specific validations
		if (mondayContext && mondayContext.enabled && valid) {
			try {
				const mondayValidationResult = await this.validateMondayConstraints(
					taskId, 
					dependencyId, 
					mondayContext
				);
				
				if (!mondayValidationResult.valid) {
					issues.push(...mondayValidationResult.issues);
					valid = false;
				}
			} catch (error) {
				log('warn', `Monday.com constraint validation failed: ${error.message}`);
				// Don't mark as invalid due to Monday.com validation failure
			}
		}

		return {
			valid,
			issues,
			taskId,
			dependencyId,
			mondayContext: mondayContext ? mondayContext.enabled : false
		};
	}

	/**
	 * Validate Monday.com specific constraints for dependencies
	 * @param {string|number} taskId - Task ID
	 * @param {string|number} dependencyId - Dependency ID
	 * @param {Object} mondayContext - Monday.com context
	 * @returns {Object} Monday.com constraint validation result
	 */
	static async validateMondayConstraints(taskId, dependencyId, mondayContext) {
		const issues = [];
		let valid = true;

		try {
			const { mondayClient, boardId, relationColumnId } = mondayContext;

			// Convert to Monday.com item IDs
			const mondayTaskId = typeof taskId === 'string' && taskId.includes('.') 
				? parseInt(taskId.split('.')[0], 10) 
				: parseInt(taskId, 10);
			const mondayDepId = typeof dependencyId === 'string' && dependencyId.includes('.') 
				? parseInt(dependencyId.split('.')[0], 10) 
				: parseInt(dependencyId, 10);

			// Check if items are in the same board
			const taskInBoard = await this.checkMondayItemExists(mondayClient, mondayTaskId);
			const depInBoard = await this.checkMondayItemExists(mondayClient, mondayDepId);

			if (!taskInBoard) {
				issues.push({
					type: 'monday_constraint',
					taskId,
					dependencyId: null,
					message: `Task ${taskId} (item ${mondayTaskId}) is not in Monday.com board ${boardId}`,
					source: 'monday'
				});
				valid = false;
			}

			if (!depInBoard) {
				issues.push({
					type: 'monday_constraint',
					taskId,
					dependencyId,
					message: `Dependency ${dependencyId} (item ${mondayDepId}) is not in Monday.com board ${boardId}`,
					source: 'monday'
				});
				valid = false;
			}

			// Validate against Monday.com API limits
			if (valid) {
				const currentDependencies = await this.getMondayItemDependencies(
					mondayClient, 
					mondayTaskId, 
					relationColumnId
				);

				// Check if we're approaching Monday.com item relation limits
				if (currentDependencies.length >= 50) { // Conservative limit
					issues.push({
						type: 'monday_limit',
						taskId,
						dependencyId,
						message: `Task ${taskId} has too many dependencies (${currentDependencies.length}). Monday.com may have limits on board relations.`,
						source: 'monday'
					});
					// Don't mark as invalid, just warn
				}
			}

		} catch (error) {
			issues.push({
				type: 'monday_error',
				taskId,
				dependencyId,
				message: `Failed to validate Monday.com constraints: ${error.message}`,
				source: 'monday'
			});
			valid = false;
		}

		return { valid, issues };
	}

	/**
	 * Get Monday.com item dependencies from board relation column
	 * @param {Object} mondayClient - Monday.com API client
	 * @param {number} itemId - Monday.com item ID
	 * @param {string} relationColumnId - Board relation column ID
	 * @returns {Array} Array of dependency item IDs
	 */
	static async getMondayItemDependencies(mondayClient, itemId, relationColumnId) {
		try {
			const itemDetails = await mondayClient.getItemDetails(itemId, [relationColumnId]);
			const relationValue = itemDetails.column_values.find(cv => cv.id === relationColumnId);
			
			if (!relationValue || !relationValue.value) {
				return [];
			}
			
			const relationData = JSON.parse(relationValue.value);
			return relationData.linkedPulseIds || [];
		} catch (error) {
			log('warn', `Failed to get Monday.com dependencies for item ${itemId}: ${error.message}`);
			return [];
		}
	}
}

/**
 * Validate task dependencies
 * @param {Array} tasks - Array of all tasks
 * @returns {Object} Validation result with valid flag and issues array
 */
function validateTaskDependencies(tasks) {
	const issues = [];

	// Check each task's dependencies
	tasks.forEach((task) => {
		if (!task.dependencies) {
			return; // No dependencies to validate
		}

		task.dependencies.forEach((depId) => {
			// Check for self-dependencies
			if (String(depId) === String(task.id)) {
				issues.push({
					type: 'self',
					taskId: task.id,
					message: `Task ${task.id} depends on itself`
				});
				return;
			}

			// Check if dependency exists
			if (!taskExists(tasks, depId)) {
				issues.push({
					type: 'missing',
					taskId: task.id,
					dependencyId: depId,
					message: `Task ${task.id} depends on non-existent task ${depId}`
				});
			}
		});

		// Check for circular dependencies
		if (isCircularDependency(tasks, task.id)) {
			issues.push({
				type: 'circular',
				taskId: task.id,
				message: `Task ${task.id} is part of a circular dependency chain`
			});
		}

		// Check subtask dependencies if they exist
		if (task.subtasks && task.subtasks.length > 0) {
			task.subtasks.forEach((subtask) => {
				if (!subtask.dependencies) {
					return; // No dependencies to validate
				}

				// Create a full subtask ID for reference
				const fullSubtaskId = `${task.id}.${subtask.id}`;

				subtask.dependencies.forEach((depId) => {
					// Check for self-dependencies in subtasks
					if (
						String(depId) === String(fullSubtaskId) ||
						(typeof depId === 'number' && depId === subtask.id)
					) {
						issues.push({
							type: 'self',
							taskId: fullSubtaskId,
							message: `Subtask ${fullSubtaskId} depends on itself`
						});
						return;
					}

					// Check if dependency exists
					if (!taskExists(tasks, depId)) {
						issues.push({
							type: 'missing',
							taskId: fullSubtaskId,
							dependencyId: depId,
							message: `Subtask ${fullSubtaskId} depends on non-existent task/subtask ${depId}`
						});
					}
				});

				// Check for circular dependencies in subtasks
				if (isCircularDependency(tasks, fullSubtaskId)) {
					issues.push({
						type: 'circular',
						taskId: fullSubtaskId,
						message: `Subtask ${fullSubtaskId} is part of a circular dependency chain`
					});
				}
			});
		}
	});

	return {
		valid: issues.length === 0,
		issues
	};
}

/**
 * Remove duplicate dependencies from tasks
 * @param {Object} tasksData - Tasks data object with tasks array
 * @returns {Object} Updated tasks data with duplicates removed
 */
function removeDuplicateDependencies(tasksData) {
	const tasks = tasksData.tasks.map((task) => {
		if (!task.dependencies) {
			return task;
		}

		// Convert to Set and back to array to remove duplicates
		const uniqueDeps = [...new Set(task.dependencies)];
		return {
			...task,
			dependencies: uniqueDeps
		};
	});

	return {
		...tasksData,
		tasks
	};
}

/**
 * Clean up invalid subtask dependencies
 * @param {Object} tasksData - Tasks data object with tasks array
 * @returns {Object} Updated tasks data with invalid subtask dependencies removed
 */
function cleanupSubtaskDependencies(tasksData) {
	const tasks = tasksData.tasks.map((task) => {
		// Handle task's own dependencies
		if (task.dependencies) {
			task.dependencies = task.dependencies.filter((depId) => {
				// Keep only dependencies that exist
				return taskExists(tasksData.tasks, depId);
			});
		}

		// Handle subtask dependencies
		if (task.subtasks) {
			task.subtasks = task.subtasks.map((subtask) => {
				if (!subtask.dependencies) {
					return subtask;
				}

				// Filter out dependencies to non-existent subtasks
				subtask.dependencies = subtask.dependencies.filter((depId) => {
					return taskExists(tasksData.tasks, depId);
				});

				return subtask;
			});
		}

		return task;
	});

	return {
		...tasksData,
		tasks
	};
}

/**
 * Validate dependencies in task files
 * @param {string} tasksPath - Path to tasks.json
 * @param {Object} options - Options object
 * @param {Object} context - Context object with session, projectRoot, etc.
 */
async function validateDependenciesCommand(tasksPath, options = {}, context = {}) {
	const { session, projectRoot } = context;
	
	// Only display banner if not in silent mode
	if (!isSilentMode()) {
		displayBanner();
	}

	log('info', 'Checking for invalid dependencies in task files...');

	// Initialize persistence manager with project context
	await persistenceManager.initialize(projectRoot, session);

	// Use persistence manager to read tasks data
	const data = await persistenceManager.readTasks(tasksPath, { projectRoot, session });
	if (!data || !data.tasks) {
		log('error', 'No valid tasks found');
		process.exit(1);
	}

	// Count of tasks and subtasks for reporting
	const taskCount = data.tasks.length;
	let subtaskCount = 0;
	data.tasks.forEach((task) => {
		if (task.subtasks && Array.isArray(task.subtasks)) {
			subtaskCount += task.subtasks.length;
		}
	});

	log(
		'info',
		`Analyzing dependencies for ${taskCount} tasks and ${subtaskCount} subtasks...`
	);

	try {
		// Directly call the validation function
		const validationResult = validateTaskDependencies(data.tasks);

		if (!validationResult.valid) {
			log(
				'error',
				`Dependency validation failed. Found ${validationResult.issues.length} issue(s):`
			);
			validationResult.issues.forEach((issue) => {
				let errorMsg = `  [${issue.type.toUpperCase()}] Task ${issue.taskId}: ${issue.message}`;
				if (issue.dependencyId) {
					errorMsg += ` (Dependency: ${issue.dependencyId})`;
				}
				log('error', errorMsg); // Log each issue as an error
			});

			// Optionally exit if validation fails, depending on desired behavior
			// process.exit(1); // Uncomment if validation failure should stop the process

			// Display summary box even on failure, showing issues found
			if (!isSilentMode()) {
				console.log(
					boxen(
						chalk.red(`Dependency Validation FAILED\n\n`) +
							`${chalk.cyan('Tasks checked:')} ${taskCount}\n` +
							`${chalk.cyan('Subtasks checked:')} ${subtaskCount}\n` +
							`${chalk.red('Issues found:')} ${validationResult.issues.length}`, // Display count from result
						{
							padding: 1,
							borderColor: 'red',
							borderStyle: 'round',
							margin: { top: 1, bottom: 1 }
						}
					)
				);
			}
		} else {
			log(
				'success',
				'No invalid dependencies found - all dependencies are valid'
			);

			// Show validation summary - only if not in silent mode
			if (!isSilentMode()) {
				console.log(
					boxen(
						chalk.green(`All Dependencies Are Valid\n\n`) +
							`${chalk.cyan('Tasks checked:')} ${taskCount}\n` +
							`${chalk.cyan('Subtasks checked:')} ${subtaskCount}\n` +
							`${chalk.cyan('Total dependencies verified:')} ${countAllDependencies(data.tasks)}`,
						{
							padding: 1,
							borderColor: 'green',
							borderStyle: 'round',
							margin: { top: 1, bottom: 1 }
						}
					)
				);
			}
		}
	} catch (error) {
		log('error', 'Error validating dependencies:', error);
		process.exit(1);
	}
}

/**
 * Helper function to count all dependencies across tasks and subtasks
 * @param {Array} tasks - All tasks
 * @returns {number} - Total number of dependencies
 */
function countAllDependencies(tasks) {
	let count = 0;

	tasks.forEach((task) => {
		// Count main task dependencies
		if (task.dependencies && Array.isArray(task.dependencies)) {
			count += task.dependencies.length;
		}

		// Count subtask dependencies
		if (task.subtasks && Array.isArray(task.subtasks)) {
			task.subtasks.forEach((subtask) => {
				if (subtask.dependencies && Array.isArray(subtask.dependencies)) {
					count += subtask.dependencies.length;
				}
			});
		}
	});

	return count;
}

/**
 * Fixes invalid dependencies in tasks.json
 * @param {string} tasksPath - Path to tasks.json
 * @param {Object} options - Options object
 * @param {Object} context - Context object with session, projectRoot, etc.
 */
async function fixDependenciesCommand(tasksPath, options = {}, context = {}) {
	const { session, projectRoot } = context;
	
	// Only display banner if not in silent mode
	if (!isSilentMode()) {
		displayBanner();
	}

	log('info', 'Checking for and fixing invalid dependencies...');

	// Initialize persistence manager with project context
	await persistenceManager.initialize(projectRoot, session);

	try {
		// Use persistence manager to read tasks data
		const data = await persistenceManager.readTasks(tasksPath, { projectRoot, session });
		if (!data || !data.tasks) {
			log('error', 'No valid tasks found');
			process.exit(1);
		}

		// Create a deep copy of the original data for comparison
		const originalData = JSON.parse(JSON.stringify(data));

		// Track fixes for reporting
		const stats = {
			nonExistentDependenciesRemoved: 0,
			selfDependenciesRemoved: 0,
			duplicateDependenciesRemoved: 0,
			circularDependenciesFixed: 0,
			tasksFixed: 0,
			subtasksFixed: 0
		};

		// First phase: Remove duplicate dependencies in tasks
		data.tasks.forEach((task) => {
			if (task.dependencies && Array.isArray(task.dependencies)) {
				const uniqueDeps = new Set();
				const originalLength = task.dependencies.length;
				task.dependencies = task.dependencies.filter((depId) => {
					const depIdStr = String(depId);
					if (uniqueDeps.has(depIdStr)) {
						log(
							'info',
							`Removing duplicate dependency from task ${task.id}: ${depId}`
						);
						stats.duplicateDependenciesRemoved++;
						return false;
					}
					uniqueDeps.add(depIdStr);
					return true;
				});
				if (task.dependencies.length < originalLength) {
					stats.tasksFixed++;
				}
			}

			// Check for duplicates in subtasks
			if (task.subtasks && Array.isArray(task.subtasks)) {
				task.subtasks.forEach((subtask) => {
					if (subtask.dependencies && Array.isArray(subtask.dependencies)) {
						const uniqueDeps = new Set();
						const originalLength = subtask.dependencies.length;
						subtask.dependencies = subtask.dependencies.filter((depId) => {
							let depIdStr = String(depId);
							if (typeof depId === 'number' && depId < 100) {
								depIdStr = `${task.id}.${depId}`;
							}
							if (uniqueDeps.has(depIdStr)) {
								log(
									'info',
									`Removing duplicate dependency from subtask ${task.id}.${subtask.id}: ${depId}`
								);
								stats.duplicateDependenciesRemoved++;
								return false;
							}
							uniqueDeps.add(depIdStr);
							return true;
						});
						if (subtask.dependencies.length < originalLength) {
							stats.subtasksFixed++;
						}
					}
				});
			}
		});

		// Create validity maps for tasks and subtasks
		const validTaskIds = new Set(data.tasks.map((t) => t.id));
		const validSubtaskIds = new Set();
		data.tasks.forEach((task) => {
			if (task.subtasks && Array.isArray(task.subtasks)) {
				task.subtasks.forEach((subtask) => {
					validSubtaskIds.add(`${task.id}.${subtask.id}`);
				});
			}
		});

		// Second phase: Remove invalid task dependencies (non-existent tasks)
		data.tasks.forEach((task) => {
			if (task.dependencies && Array.isArray(task.dependencies)) {
				const originalLength = task.dependencies.length;
				task.dependencies = task.dependencies.filter((depId) => {
					const isSubtask = typeof depId === 'string' && depId.includes('.');

					if (isSubtask) {
						// Check if the subtask exists
						if (!validSubtaskIds.has(depId)) {
							log(
								'info',
								`Removing invalid subtask dependency from task ${task.id}: ${depId} (subtask does not exist)`
							);
							stats.nonExistentDependenciesRemoved++;
							return false;
						}
						return true;
					} else {
						// Check if the task exists
						const numericId =
							typeof depId === 'string' ? parseInt(depId, 10) : depId;
						if (!validTaskIds.has(numericId)) {
							log(
								'info',
								`Removing invalid task dependency from task ${task.id}: ${depId} (task does not exist)`
							);
							stats.nonExistentDependenciesRemoved++;
							return false;
						}
						return true;
					}
				});

				if (task.dependencies.length < originalLength) {
					stats.tasksFixed++;
				}
			}

			// Check subtask dependencies for invalid references
			if (task.subtasks && Array.isArray(task.subtasks)) {
				task.subtasks.forEach((subtask) => {
					if (subtask.dependencies && Array.isArray(subtask.dependencies)) {
						const originalLength = subtask.dependencies.length;
						const subtaskId = `${task.id}.${subtask.id}`;

						// First check for self-dependencies
						const hasSelfDependency = subtask.dependencies.some((depId) => {
							if (typeof depId === 'string' && depId.includes('.')) {
								return depId === subtaskId;
							} else if (typeof depId === 'number' && depId < 100) {
								return depId === subtask.id;
							}
							return false;
						});

						if (hasSelfDependency) {
							subtask.dependencies = subtask.dependencies.filter((depId) => {
								const normalizedDepId =
									typeof depId === 'number' && depId < 100
										? `${task.id}.${depId}`
										: String(depId);

								if (normalizedDepId === subtaskId) {
									log(
										'info',
										`Removing self-dependency from subtask ${subtaskId}`
									);
									stats.selfDependenciesRemoved++;
									return false;
								}
								return true;
							});
						}

						// Then check for non-existent dependencies
						subtask.dependencies = subtask.dependencies.filter((depId) => {
							if (typeof depId === 'string' && depId.includes('.')) {
								if (!validSubtaskIds.has(depId)) {
									log(
										'info',
										`Removing invalid subtask dependency from subtask ${subtaskId}: ${depId} (subtask does not exist)`
									);
									stats.nonExistentDependenciesRemoved++;
									return false;
								}
								return true;
							}

							// Handle numeric dependencies
							const numericId =
								typeof depId === 'number' ? depId : parseInt(depId, 10);

							// Small numbers likely refer to subtasks in the same task
							if (numericId < 100) {
								const fullSubtaskId = `${task.id}.${numericId}`;

								if (!validSubtaskIds.has(fullSubtaskId)) {
									log(
										'info',
										`Removing invalid subtask dependency from subtask ${subtaskId}: ${numericId}`
									);
									stats.nonExistentDependenciesRemoved++;
									return false;
								}

								return true;
							}

							// Otherwise it's a task reference
							if (!validTaskIds.has(numericId)) {
								log(
									'info',
									`Removing invalid task dependency from subtask ${subtaskId}: ${numericId}`
								);
								stats.nonExistentDependenciesRemoved++;
								return false;
							}

							return true;
						});

						if (subtask.dependencies.length < originalLength) {
							stats.subtasksFixed++;
						}
					}
				});
			}
		});

		// Third phase: Check for circular dependencies
		log('info', 'Checking for circular dependencies...');

		// Build the dependency map for subtasks
		const subtaskDependencyMap = new Map();
		data.tasks.forEach((task) => {
			if (task.subtasks && Array.isArray(task.subtasks)) {
				task.subtasks.forEach((subtask) => {
					const subtaskId = `${task.id}.${subtask.id}`;

					if (subtask.dependencies && Array.isArray(subtask.dependencies)) {
						const normalizedDeps = subtask.dependencies.map((depId) => {
							if (typeof depId === 'string' && depId.includes('.')) {
								return depId;
							} else if (typeof depId === 'number' && depId < 100) {
								return `${task.id}.${depId}`;
							}
							return String(depId);
						});
						subtaskDependencyMap.set(subtaskId, normalizedDeps);
					} else {
						subtaskDependencyMap.set(subtaskId, []);
					}
				});
			}
		});

		// Check for and fix circular dependencies
		for (const [subtaskId, dependencies] of subtaskDependencyMap.entries()) {
			const visited = new Set();
			const recursionStack = new Set();

			// Detect cycles
			const cycleEdges = findCycles(
				subtaskId,
				subtaskDependencyMap,
				visited,
				recursionStack
			);

			if (cycleEdges.length > 0) {
				const [taskId, subtaskNum] = subtaskId
					.split('.')
					.map((part) => Number(part));
				const task = data.tasks.find((t) => t.id === taskId);

				if (task && task.subtasks) {
					const subtask = task.subtasks.find((st) => st.id === subtaskNum);

					if (subtask && subtask.dependencies) {
						const originalLength = subtask.dependencies.length;

						const edgesToRemove = cycleEdges.map((edge) => {
							if (edge.includes('.')) {
								const [depTaskId, depSubtaskId] = edge
									.split('.')
									.map((part) => Number(part));

								if (depTaskId === taskId) {
									return depSubtaskId;
								}

								return edge;
							}

							return Number(edge);
						});

						subtask.dependencies = subtask.dependencies.filter((depId) => {
							const normalizedDepId =
								typeof depId === 'number' && depId < 100
									? `${taskId}.${depId}`
									: String(depId);

							if (
								edgesToRemove.includes(depId) ||
								edgesToRemove.includes(normalizedDepId)
							) {
								log(
									'info',
									`Breaking circular dependency: Removing ${normalizedDepId} from subtask ${subtaskId}`
								);
								stats.circularDependenciesFixed++;
								return false;
							}
							return true;
						});

						if (subtask.dependencies.length < originalLength) {
							stats.subtasksFixed++;
						}
					}
				}
			}
		}

		// Check if any changes were made by comparing with original data
		const dataChanged = JSON.stringify(data) !== JSON.stringify(originalData);

		if (dataChanged) {
			// Save the changes
			await persistenceManager.writeTasks(tasksPath, data, { projectRoot, session });
			log('success', 'Fixed dependency issues in tasks.json');

			// Regenerate task files
			log('info', 'Regenerating task files to reflect dependency changes...');
			await generateTaskFiles(tasksPath, path.dirname(tasksPath), {}, { session, projectRoot });
		} else {
			log('info', 'No changes needed to fix dependencies');
		}

		// Show detailed statistics report
		const totalFixedAll =
			stats.nonExistentDependenciesRemoved +
			stats.selfDependenciesRemoved +
			stats.duplicateDependenciesRemoved +
			stats.circularDependenciesFixed;

		if (!isSilentMode()) {
			if (totalFixedAll > 0) {
				log('success', `Fixed ${totalFixedAll} dependency issues in total!`);

				console.log(
					boxen(
						chalk.green(`Dependency Fixes Summary:\n\n`) +
							`${chalk.cyan('Invalid dependencies removed:')} ${stats.nonExistentDependenciesRemoved}\n` +
							`${chalk.cyan('Self-dependencies removed:')} ${stats.selfDependenciesRemoved}\n` +
							`${chalk.cyan('Duplicate dependencies removed:')} ${stats.duplicateDependenciesRemoved}\n` +
							`${chalk.cyan('Circular dependencies fixed:')} ${stats.circularDependenciesFixed}\n\n` +
							`${chalk.cyan('Tasks fixed:')} ${stats.tasksFixed}\n` +
							`${chalk.cyan('Subtasks fixed:')} ${stats.subtasksFixed}\n`,
						{
							padding: 1,
							borderColor: 'green',
							borderStyle: 'round',
							margin: { top: 1, bottom: 1 }
						}
					)
				);
			} else {
				log(
					'success',
					'No dependency issues found - all dependencies are valid'
				);

				console.log(
					boxen(
						chalk.green(`All Dependencies Are Valid\n\n`) +
							`${chalk.cyan('Tasks checked:')} ${data.tasks.length}\n` +
							`${chalk.cyan('Total dependencies verified:')} ${countAllDependencies(data.tasks)}`,
						{
							padding: 1,
							borderColor: 'green',
							borderStyle: 'round',
							margin: { top: 1, bottom: 1 }
						}
					)
				);
			}
		}
	} catch (error) {
		log('error', 'Error in fix-dependencies command:', error);
		process.exit(1);
	}
}

/**
 * Ensure at least one subtask in each task has no dependencies
 * @param {Object} tasksData - The tasks data object with tasks array
 * @returns {boolean} - True if any changes were made
 */
function ensureAtLeastOneIndependentSubtask(tasksData) {
	if (!tasksData || !tasksData.tasks || !Array.isArray(tasksData.tasks)) {
		return false;
	}

	let changesDetected = false;

	tasksData.tasks.forEach((task) => {
		if (
			!task.subtasks ||
			!Array.isArray(task.subtasks) ||
			task.subtasks.length === 0
		) {
			return;
		}

		// Check if any subtask has no dependencies
		const hasIndependentSubtask = task.subtasks.some(
			(st) =>
				!st.dependencies ||
				!Array.isArray(st.dependencies) ||
				st.dependencies.length === 0
		);

		if (!hasIndependentSubtask) {
			// Find the first subtask and clear its dependencies
			if (task.subtasks.length > 0) {
				const firstSubtask = task.subtasks[0];
				log(
					'debug',
					`Ensuring at least one independent subtask: Clearing dependencies for subtask ${task.id}.${firstSubtask.id}`
				);
				firstSubtask.dependencies = [];
				changesDetected = true;
			}
		}
	});

	return changesDetected;
}

/**
 * Validate and fix dependencies across all tasks and subtasks
 * This function is designed to be called after any task modification
 * @param {Object} tasksData - The tasks data object with tasks array
 * @param {string} tasksPath - Optional path to save the changes
 * @param {Object} context - Optional context object with session, projectRoot, etc.
 * @returns {boolean} - True if any changes were made
 */
async function validateAndFixDependencies(tasksData, tasksPath = null, context = {}) {
	if (!tasksData || !tasksData.tasks || !Array.isArray(tasksData.tasks)) {
		log('error', 'Invalid tasks data');
		return false;
	}

	log('debug', 'Validating and fixing dependencies...');

	// Create a deep copy for comparison
	const originalData = JSON.parse(JSON.stringify(tasksData));

	// 1. Remove duplicate dependencies from tasks and subtasks
	tasksData.tasks = tasksData.tasks.map((task) => {
		// Handle task dependencies
		if (task.dependencies) {
			const uniqueDeps = [...new Set(task.dependencies)];
			task.dependencies = uniqueDeps;
		}

		// Handle subtask dependencies
		if (task.subtasks) {
			task.subtasks = task.subtasks.map((subtask) => {
				if (subtask.dependencies) {
					const uniqueDeps = [...new Set(subtask.dependencies)];
					subtask.dependencies = uniqueDeps;
				}
				return subtask;
			});
		}
		return task;
	});

	// 2. Remove invalid task dependencies (non-existent tasks)
	tasksData.tasks.forEach((task) => {
		// Clean up task dependencies
		if (task.dependencies) {
			task.dependencies = task.dependencies.filter((depId) => {
				// Remove self-dependencies
				if (String(depId) === String(task.id)) {
					return false;
				}
				// Remove non-existent dependencies
				return taskExists(tasksData.tasks, depId);
			});
		}

		// Clean up subtask dependencies
		if (task.subtasks) {
			task.subtasks.forEach((subtask) => {
				if (subtask.dependencies) {
					subtask.dependencies = subtask.dependencies.filter((depId) => {
						// Handle numeric subtask references
						if (typeof depId === 'number' && depId < 100) {
							const fullSubtaskId = `${task.id}.${depId}`;
							return taskExists(tasksData.tasks, fullSubtaskId);
						}
						// Handle full task/subtask references
						return taskExists(tasksData.tasks, depId);
					});
				}
			});
		}
	});

	// 3. Ensure at least one subtask has no dependencies in each task
	tasksData.tasks.forEach((task) => {
		if (task.subtasks && task.subtasks.length > 0) {
			const hasIndependentSubtask = task.subtasks.some(
				(st) =>
					!st.dependencies ||
					!Array.isArray(st.dependencies) ||
					st.dependencies.length === 0
			);

			if (!hasIndependentSubtask) {
				task.subtasks[0].dependencies = [];
			}
		}
	});

	// Check if any changes were made by comparing with original data
	const changesDetected =
		JSON.stringify(tasksData) !== JSON.stringify(originalData);

	// Save changes if needed
	if (tasksPath && changesDetected) {
		try {
			const { session, projectRoot } = context;
			
			// If context is provided, use persistence manager, otherwise use direct writeJSON
			if (session || projectRoot) {
				await persistenceManager.initialize(projectRoot, session);
				await persistenceManager.writeTasks(tasksPath, tasksData, { projectRoot, session });
				log('debug', 'Saved dependency fixes using persistence manager');
			} else {
				writeJSON(tasksPath, tasksData);
				log('debug', 'Saved dependency fixes to tasks.json');
			}
		} catch (error) {
			log('error', 'Failed to save dependency fixes', error);
		}
	}

	return changesDetected;
}

export {
	addDependency,
	removeDependency,
	isCircularDependency,
	validateTaskDependencies,
	validateDependenciesCommand,
	fixDependenciesCommand,
	removeDuplicateDependencies,
	cleanupSubtaskDependencies,
	ensureAtLeastOneIndependentSubtask,
	validateAndFixDependencies,
	DependencyValidationUtils
};
