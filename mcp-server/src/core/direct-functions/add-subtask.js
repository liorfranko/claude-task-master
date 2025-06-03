/**
 * Direct function wrapper for addSubtask
 */

import { addSubtask } from '../../../../scripts/modules/task-manager.js';
import { onSubtaskCreated } from '../../../../scripts/modules/task-manager/auto-sync-hooks.js';
import { readJSON } from '../../../../scripts/modules/utils.js';
import {
	enableSilentMode,
	disableSilentMode
} from '../../../../scripts/modules/utils.js';

/**
 * Add a subtask to an existing task
 * @param {Object} args - Function arguments
 * @param {string} args.tasksJsonPath - Explicit path to the tasks.json file.
 * @param {string} args.id - Parent task ID
 * @param {string} [args.taskId] - Existing task ID to convert to subtask (optional)
 * @param {string} [args.title] - Title for new subtask (when creating a new subtask)
 * @param {string} [args.description] - Description for new subtask
 * @param {string} [args.details] - Implementation details for new subtask
 * @param {string} [args.status] - Status for new subtask (default: 'pending')
 * @param {string} [args.dependencies] - Comma-separated list of dependency IDs
 * @param {boolean} [args.skipGenerate] - Skip regenerating task files
 * @param {string} [args.projectRoot] - Project root path for sync context
 * @param {Object} log - Logger object
 * @param {Object} context - Context object containing session data
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
export async function addSubtaskDirect(args, log, context = {}) {
	const { session } = context;
	// Destructure expected args
	const {
		tasksJsonPath,
		id,
		taskId,
		title,
		description,
		details,
		status,
		dependencies: dependenciesStr,
		skipGenerate,
		projectRoot
	} = args;
	
	try {
		log.info(`Adding subtask with args: ${JSON.stringify(args)}`);

		// Check if tasksJsonPath was provided
		if (!tasksJsonPath) {
			log.error('addSubtaskDirect called without tasksJsonPath');
			return {
				success: false,
				error: {
					code: 'MISSING_ARGUMENT',
					message: 'tasksJsonPath is required'
				}
			};
		}

		if (!id) {
			return {
				success: false,
				error: {
					code: 'INPUT_VALIDATION_ERROR',
					message: 'Parent task ID is required'
				}
			};
		}

		// Either taskId or title must be provided
		if (!taskId && !title) {
			return {
				success: false,
				error: {
					code: 'INPUT_VALIDATION_ERROR',
					message: 'Either taskId or title must be provided'
				}
			};
		}

		// Use provided path
		const tasksPath = tasksJsonPath;

		// Parse dependencies if provided
		let dependencies = [];
		if (dependenciesStr) {
			dependencies = dependenciesStr.split(',').map((depId) => {
				// Handle both regular IDs and dot notation
				return depId.includes('.') ? depId.trim() : parseInt(depId.trim(), 10);
			});
		}

		// Convert existingTaskId to a number if provided
		const existingTaskId = taskId ? parseInt(taskId, 10) : null;

		// Convert parent ID to a number
		const parentId = parseInt(id, 10);

		// Determine if we should generate files
		const generateFiles = !skipGenerate;

		// Enable silent mode to prevent console logs from interfering with JSON response
		enableSilentMode();

		let result;
		let parentTask;

		// Case 1: Convert existing task to subtask
		if (existingTaskId) {
			log.info(`Converting task ${existingTaskId} to a subtask of ${parentId}`);
			result = await addSubtask(
				tasksPath,
				parentId,
				existingTaskId,
				null,
				generateFiles
			);

			// Restore normal logging
			disableSilentMode();

			// Get the parent task for sync hook
			if (projectRoot && result) {
				try {
					const data = readJSON(tasksPath);
					parentTask = data.tasks.find(t => t.id === parentId);
					
					if (parentTask) {
						// Call auto-sync hook for subtask creation
						await onSubtaskCreated(projectRoot, parentTask, result, {
							session,
							mcpLog: log
						});
					}
				} catch (syncError) {
					log.warn(`Auto-sync failed for converted subtask: ${syncError.message}`);
				}
			}

			return {
				success: true,
				data: {
					message: `Task ${existingTaskId} successfully converted to a subtask of task ${parentId}`,
					subtask: result
				}
			};
		}
		// Case 2: Create new subtask
		else {
			log.info(`Creating new subtask for parent task ${parentId}`);

			const newSubtaskData = {
				title: title,
				description: description || '',
				details: details || '',
				status: status || 'pending',
				dependencies: dependencies
			};

			result = await addSubtask(
				tasksPath,
				parentId,
				null,
				newSubtaskData,
				generateFiles
			);

			// Restore normal logging
			disableSilentMode();

			// Get the parent task for sync hook
			if (projectRoot && result) {
				try {
					const data = readJSON(tasksPath);
					parentTask = data.tasks.find(t => t.id === parentId);
					
					if (parentTask) {
						// Call auto-sync hook for subtask creation
						await onSubtaskCreated(projectRoot, parentTask, result, {
							session,
							mcpLog: log
						});
					}
				} catch (syncError) {
					log.warn(`Auto-sync failed for new subtask: ${syncError.message}`);
				}
			}

			return {
				success: true,
				data: {
					message: `New subtask ${parentId}.${result.id} successfully created`,
					subtask: result
				}
			};
		}
	} catch (error) {
		// Make sure to restore normal logging even if there's an error
		disableSilentMode();

		log.error(`Error in addSubtaskDirect: ${error.message}`);
		return {
			success: false,
			error: {
				code: 'CORE_FUNCTION_ERROR',
				message: error.message
			}
		};
	}
}
