/**
 * set-task-status.js
 * Direct function implementation for setting task status
 */

import { setTaskStatus } from '../../../../scripts/modules/task-manager.js';
import { onSubtaskStatusChanged } from '../../../../scripts/modules/task-manager/auto-sync-hooks.js';
import { readJSON } from '../../../../scripts/modules/utils.js';
import {
	enableSilentMode,
	disableSilentMode,
	isSilentMode
} from '../../../../scripts/modules/utils.js';
import { nextTaskDirect } from './next-task.js';

/**
 * Direct function wrapper for setTaskStatus with error handling.
 *
 * @param {Object} args - Command arguments containing id, status and tasksJsonPath.
 * @param {Object} log - Logger object.
 * @param {Object} context - Context object containing session and projectRoot.
 * @returns {Promise<Object>} - Result object with success status and data/error information.
 */
export async function setTaskStatusDirect(args, log, context = {}) {
	// Destructure expected args, including the resolved tasksJsonPath
	const { tasksJsonPath, id, status, complexityReportPath, projectRoot } = args;
	const { session } = context;
	
	try {
		log.info(`Setting task status with args: ${JSON.stringify(args)}`);

		// Check if tasksJsonPath was provided
		if (!tasksJsonPath) {
			const errorMessage = 'tasksJsonPath is required but was not provided.';
			log.error(errorMessage);
			return {
				success: false,
				error: { code: 'MISSING_ARGUMENT', message: errorMessage }
			};
		}

		// Check required parameters (id and status)
		if (!id) {
			const errorMessage =
				'No task ID specified. Please provide a task ID to update.';
			log.error(errorMessage);
			return {
				success: false,
				error: { code: 'MISSING_TASK_ID', message: errorMessage }
			};
		}

		if (!status) {
			const errorMessage =
				'No status specified. Please provide a new status value.';
			log.error(errorMessage);
			return {
				success: false,
				error: { code: 'MISSING_STATUS', message: errorMessage }
			};
		}

		// Use the provided path
		const tasksPath = tasksJsonPath;

		// Execute core setTaskStatus function
		const taskId = id;
		const newStatus = status;

		log.info(`Setting task ${taskId} status to "${newStatus}"`);

		// Capture old status for subtask sync hooks if this is a subtask
		let oldSubtaskStatus = null;
		let parentTask = null;
		let subtask = null;
		
		if (projectRoot && taskId.includes('.')) {
			try {
				const data = readJSON(tasksPath);
				const [parentIdStr, subtaskIdStr] = taskId.split('.');
				const parentId = parseInt(parentIdStr, 10);
				const subtaskId = parseInt(subtaskIdStr, 10);
				
				parentTask = data.tasks.find(t => t.id === parentId);
				if (parentTask && parentTask.subtasks) {
					subtask = parentTask.subtasks.find(s => s.id === subtaskId);
					if (subtask) {
						oldSubtaskStatus = subtask.status;
					}
				}
			} catch (error) {
				log.warn(`Could not capture subtask status for sync: ${error.message}`);
			}
		}

		// Call the core function with proper silent mode handling
		enableSilentMode(); // Enable silent mode before calling core function
		try {
			// Call the core function with MCP context for sync hooks
			const result = await setTaskStatus(tasksPath, taskId, newStatus, { 
				mcpLog: log,
				session: session,
				projectRoot: projectRoot
			});

			log.info(`Successfully set task ${taskId} status to ${newStatus}`);

			// Handle subtask-specific sync hook if this was a subtask update
			if (projectRoot && taskId.includes('.') && parentTask && subtask && oldSubtaskStatus !== null) {
				try {
					// Refresh subtask data after status update
					const updatedData = readJSON(tasksPath);
					const updatedParentTask = updatedData.tasks.find(t => t.id === parentTask.id);
					const updatedSubtask = updatedParentTask?.subtasks?.find(s => s.id === subtask.id);
					
					if (updatedSubtask) {
						await onSubtaskStatusChanged(projectRoot, updatedParentTask, updatedSubtask, oldSubtaskStatus, {
							session,
							mcpLog: log
						});
					}
				} catch (syncError) {
					log.warn(`Auto-sync failed for subtask status change: ${syncError.message}`);
				}
			}

			// Check if sync was performed and include sync status in response
			const responseData = {
				message: `Successfully updated task ${taskId} status to "${newStatus}"`,
				taskId,
				status: newStatus,
				tasksPath: tasksPath, // Return the path used
				syncResults: result?.syncResults || [] // Include sync results if available
			};

			// If the task was completed, attempt to fetch the next task
			if (newStatus === 'done') {
				try {
					log.info(`Attempting to fetch next task for task ${taskId}`);
					const nextResult = await nextTaskDirect(
						{
							tasksJsonPath: tasksJsonPath,
							reportPath: complexityReportPath,
							projectRoot: projectRoot
						},
						log,
						context
					);

					if (nextResult.success) {
						log.info(
							`Successfully retrieved next task: ${nextResult.data.nextTask}`
						);
						responseData.nextTask = nextResult.data.nextTask;
						responseData.isNextSubtask = nextResult.data.isSubtask;
						responseData.nextSteps = nextResult.data.nextSteps;
					} else {
						log.warn(
							`Failed to retrieve next task: ${nextResult.error?.message || 'Unknown error'}`
						);
					}
				} catch (nextErr) {
					log.error(`Error retrieving next task: ${nextErr.message}`);
				}
			}

			return {
				success: true,
				data: responseData
			};
		} catch (error) {
			log.error(`Error setting task status: ${error.message}`);
			return {
				success: false,
				error: {
					code: 'SET_STATUS_ERROR',
					message: error.message || 'Unknown error setting task status'
				}
			};
		} finally {
			// ALWAYS restore normal logging in finally block
			disableSilentMode();
		}
	} catch (error) {
		// Ensure silent mode is disabled if there was an uncaught error in the outer try block
		if (isSilentMode()) {
			disableSilentMode();
		}

		log.error(`Error setting task status: ${error.message}`);
		return {
			success: false,
			error: {
				code: 'SET_STATUS_ERROR',
				message: error.message || 'Unknown error setting task status'
			}
		};
	}
}
