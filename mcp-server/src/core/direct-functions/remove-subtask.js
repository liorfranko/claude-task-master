/**
 * Direct function wrapper for removeSubtask
 */

import { removeSubtask } from '../../../../scripts/modules/task-manager.js';
import { onSubtaskDeleted } from '../../../../scripts/modules/task-manager/auto-sync-hooks.js';
import { readJSON } from '../../../../scripts/modules/utils.js';
import {
	enableSilentMode,
	disableSilentMode
} from '../../../../scripts/modules/utils.js';

/**
 * Remove a subtask from its parent task
 * @param {Object} args - Function arguments
 * @param {string} args.tasksJsonPath - Explicit path to the tasks.json file.
 * @param {string} args.id - Subtask ID in format "parentId.subtaskId" (required)
 * @param {boolean} [args.convert] - Whether to convert the subtask to a standalone task
 * @param {boolean} [args.skipGenerate] - Skip regenerating task files
 * @param {string} [args.projectRoot] - Project root path for sync context
 * @param {Object} log - Logger object
 * @param {Object} context - Context object containing session data
 * @returns {Promise<{success: boolean, data?: Object, error?: {code: string, message: string}}>}
 */
export async function removeSubtaskDirect(args, log, context = {}) {
	const { session } = context;
	// Destructure expected args
	const { tasksJsonPath, id, convert, skipGenerate, projectRoot } = args;
	
	try {
		log.info(`Removing subtask with args: ${JSON.stringify(args)}`);

		// Check if tasksJsonPath was provided
		if (!tasksJsonPath) {
			log.error('removeSubtaskDirect called without tasksJsonPath');
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
					message:
						'Subtask ID is required and must be in format "parentId.subtaskId"'
				}
			};
		}

		// Validate subtask ID format
		if (!id.includes('.')) {
			return {
				success: false,
				error: {
					code: 'INPUT_VALIDATION_ERROR',
					message: `Invalid subtask ID format: ${id}. Expected format: "parentId.subtaskId"`
				}
			};
		}

		// Use provided path
		const tasksPath = tasksJsonPath;

		// Convert convertToTask to a boolean
		const convertToTask = convert === true;

		// Determine if we should generate files
		const generateFiles = !skipGenerate;

		// Capture subtask and parent task data before deletion for sync hook
		let subtaskToDelete = null;
		let parentTask = null;
		
		if (projectRoot) {
			try {
				const data = readJSON(tasksPath);
				const [parentIdStr, subtaskIdStr] = id.split('.');
				const parentId = parseInt(parentIdStr, 10);
				const subtaskId = parseInt(subtaskIdStr, 10);
				
				parentTask = data.tasks.find(t => t.id === parentId);
				if (parentTask && parentTask.subtasks) {
					subtaskToDelete = parentTask.subtasks.find(s => s.id === subtaskId);
				}
			} catch (error) {
				log.warn(`Could not capture subtask data for sync: ${error.message}`);
			}
		}

		log.info(
			`Removing subtask ${id} (convertToTask: ${convertToTask}, generateFiles: ${generateFiles})`
		);

		// Enable silent mode to prevent console logs from interfering with JSON response
		enableSilentMode();

		// Use the provided tasksPath
		const result = await removeSubtask(
			tasksPath,
			id,
			convertToTask,
			generateFiles
		);

		// Restore normal logging
		disableSilentMode();

		// Call auto-sync hook for subtask deletion (only if not converting to task)
		if (projectRoot && subtaskToDelete && parentTask && !convertToTask) {
			try {
				await onSubtaskDeleted(projectRoot, parentTask, subtaskToDelete, {
					session,
					mcpLog: log
				});
			} catch (syncError) {
				log.warn(`Auto-sync failed for deleted subtask: ${syncError.message}`);
			}
		}

		if (convertToTask && result) {
			// Return info about the converted task
			return {
				success: true,
				data: {
					message: `Subtask ${id} successfully converted to task #${result.id}`,
					task: result
				}
			};
		} else {
			// Return simple success message for deletion
			return {
				success: true,
				data: {
					message: `Subtask ${id} successfully removed`
				}
			};
		}
	} catch (error) {
		// Ensure silent mode is disabled even if an outer error occurs
		disableSilentMode();

		log.error(`Error in removeSubtaskDirect: ${error.message}`);
		return {
			success: false,
			error: {
				code: 'CORE_FUNCTION_ERROR',
				message: error.message
			}
		};
	}
}
