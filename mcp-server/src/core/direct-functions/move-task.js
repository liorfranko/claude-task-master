/**
 * Direct function wrapper for moveTask
 */

import { moveTask } from '../../../../scripts/modules/task-manager.js';
import { onTaskUpdated } from '../../../../scripts/modules/task-manager/auto-sync-hooks.js';
import { readJSON } from '../../../../scripts/modules/utils.js';
import { findTasksPath } from '../utils/path-utils.js';
import {
	enableSilentMode,
	disableSilentMode
} from '../../../../scripts/modules/utils.js';

/**
 * Move a task or subtask to a new position
 * @param {Object} args - Function arguments
 * @param {string} args.tasksJsonPath - Explicit path to the tasks.json file
 * @param {string} args.sourceId - ID of the task/subtask to move (e.g., '5' or '5.2')
 * @param {string} args.destinationId - ID of the destination (e.g., '7' or '7.3')
 * @param {string} args.file - Alternative path to the tasks.json file
 * @param {string} args.projectRoot - Project root directory
 * @param {Object} log - Logger object
 * @param {Object} context - Context object containing session data
 * @returns {Promise<{success: boolean, data?: Object, error?: Object}>}
 */
export async function moveTaskDirect(args, log, context = {}) {
	const { session } = context;

	// Validate required parameters
	if (!args.sourceId) {
		return {
			success: false,
			error: {
				message: 'Source ID is required',
				code: 'MISSING_SOURCE_ID'
			}
		};
	}

	if (!args.destinationId) {
		return {
			success: false,
			error: {
				message: 'Destination ID is required',
				code: 'MISSING_DESTINATION_ID'
			}
		};
	}

	try {
		// Find tasks.json path if not provided
		let tasksPath = args.tasksJsonPath || args.file;
		if (!tasksPath) {
			if (!args.projectRoot) {
				return {
					success: false,
					error: {
						message:
							'Project root is required if tasksJsonPath is not provided',
						code: 'MISSING_PROJECT_ROOT'
					}
				};
			}
			tasksPath = findTasksPath(args, log);
		}

		// Enable silent mode to prevent console output during MCP operation
		enableSilentMode();

		// Call the core moveTask function, always generate files
		const result = await moveTask(
			tasksPath,
			args.sourceId,
			args.destinationId,
			true
		);

		// Restore console output
		disableSilentMode();

		// Call auto-sync hook for task move (which is treated as an update)
		if (args.projectRoot && result.movedTask) {
			try {
				// Read the updated tasks data to get the current state of the task
				const data = readJSON(tasksPath);
				
				// Find the moved task in its new location
				let updatedTask = null;
				
				// Check if the moved item is a subtask (contains dot)
				if (args.destinationId.includes('.')) {
					// It's a subtask now, find the parent task
					const [parentIdStr] = args.destinationId.split('.');
					const parentId = parseInt(parentIdStr, 10);
					const parentTask = data.tasks.find(t => t.id === parentId);
					
					if (parentTask && parentTask.subtasks) {
						// Find the subtask
						const subtaskId = parseInt(args.destinationId.split('.')[1], 10);
						const subtask = parentTask.subtasks.find(s => s.id === subtaskId);
						// For subtasks moved to different parents, sync the parent task
						updatedTask = parentTask;
					}
				} else {
					// It's a top-level task, find it directly
					const taskId = parseInt(args.destinationId, 10);
					updatedTask = data.tasks.find(t => t.id === taskId);
				}
				
				// If we couldn't find the task at destination, try to find it by original ID
				if (!updatedTask) {
					// The task might have been moved but retained its original ID
					updatedTask = result.movedTask;
				}
				
				if (updatedTask) {
					await onTaskUpdated(args.projectRoot, updatedTask, {
						session,
						mcpLog: log,
						throwOnError: false
					});
					log.info(`Task move synced to Monday.com successfully`);
				}
			} catch (syncError) {
				log.warn(`Auto-sync failed for moved task: ${syncError.message}`);
			}
		}

		return {
			success: true,
			data: {
				movedTask: result.movedTask,
				message: `Successfully moved task/subtask ${args.sourceId} to ${args.destinationId}`
			}
		};
	} catch (error) {
		// Restore console output in case of error
		disableSilentMode();

		log.error(`Failed to move task: ${error.message}`);

		return {
			success: false,
			error: {
				message: error.message,
				code: 'MOVE_TASK_ERROR'
			}
		};
	}
}
