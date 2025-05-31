import chalk from 'chalk';

import { log } from '../utils.js';
import { isValidTaskStatus } from '../../../src/constants/task-status.js';
import { mondayStatusManager } from '../monday-status-manager.js';
import { persistenceManager } from '../persistence-manager.js';

/**
 * Update the status of a single task using the unified status management system
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {string} taskIdInput - Task ID to update
 * @param {string} newStatus - New status
 * @param {Object} data - Tasks data
 * @param {boolean} showUi - Whether to show UI elements
 * @param {Object} context - Context object with session and projectRoot for Monday.com integration
 */
async function updateSingleTaskStatus(
	tasksPath,
	taskIdInput,
	newStatus,
	data,
	showUi = true,
	context = {}
) {
	if (!isValidTaskStatus(newStatus)) {
		throw new Error(
			`Error: Invalid status value: ${newStatus}. Use one of: ${TASK_STATUS_OPTIONS.join(', ')}`
		);
	}

	const { session, projectRoot } = context;

	// Check if it's a subtask (e.g., "1.2")
	if (taskIdInput.includes('.')) {
		const [parentId, subtaskId] = taskIdInput
			.split('.')
			.map((id) => parseInt(id, 10));

		// Find the parent task
		const parentTask = data.tasks.find((t) => t.id === parentId);
		if (!parentTask) {
			throw new Error(`Parent task ${parentId} not found`);
		}

		// Find the subtask
		if (!parentTask.subtasks) {
			throw new Error(`Parent task ${parentId} has no subtasks`);
		}

		const subtask = parentTask.subtasks.find((st) => st.id === subtaskId);
		if (!subtask) {
			throw new Error(
				`Subtask ${subtaskId} not found in parent task ${parentId}`
			);
		}

		// Update the subtask status using unified status management
		const oldStatus = subtask.status || 'pending';
		
		try {
			// Use Monday.com Status Manager if available, otherwise direct assignment
			const persistenceMode = persistenceManager.getStatus().mode;
			
			if (persistenceMode === 'monday' || persistenceMode === 'hybrid') {
				// Use Monday.com Status Manager for advanced status management
				const statusResult = await mondayStatusManager.updateTaskStatus(
					`${parentId}.${subtaskId}`, 
					newStatus, 
					{
						optimistic: false, // We're updating data directly
						validateTransition: true,
						updateDependencies: false, // Handle dependencies separately
						triggerWebhooks: true,
						moveToGroup: true,
						projectRoot,
						session
					}
				);
				
				if (statusResult.success) {
					// Update the local data structure to match
					subtask.status = newStatus;
					log('info', `Updated subtask ${parentId}.${subtaskId} status from '${oldStatus}' to '${newStatus}' via Monday.com Status Manager`);
				} else {
					throw new Error(`Monday.com status update failed for subtask ${parentId}.${subtaskId}`);
				}
			} else {
				// Use direct assignment for local persistence
				subtask.status = newStatus;
				log('info', `Updated subtask ${parentId}.${subtaskId} status from '${oldStatus}' to '${newStatus}' (local mode)`);
			}
		} catch (error) {
			log('warn', `Failed to use advanced status management for subtask ${parentId}.${subtaskId}: ${error.message}. Falling back to direct assignment.`);
			subtask.status = newStatus;
		}

		// Check if all subtasks are done (if setting to 'done')
		if (
			newStatus.toLowerCase() === 'done' ||
			newStatus.toLowerCase() === 'completed'
		) {
			const allSubtasksDone = parentTask.subtasks.every(
				(st) => st.status === 'done' || st.status === 'completed'
			);

			// Suggest updating parent task if all subtasks are done
			if (
				allSubtasksDone &&
				parentTask.status !== 'done' &&
				parentTask.status !== 'completed'
			) {
				// Only show suggestion in CLI mode
				if (showUi) {
					console.log(
						chalk.yellow(
							`All subtasks of parent task ${parentId} are now marked as done.`
						)
					);
					console.log(
						chalk.yellow(
							`Consider updating the parent task status with: task-master set-status --id=${parentId} --status=done`
						)
					);
				}
			}
		}
	} else {
		// Handle regular task
		const taskId = parseInt(taskIdInput, 10);
		const task = data.tasks.find((t) => t.id === taskId);

		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}

		// Update the task status using unified status management
		const oldStatus = task.status || 'pending';

		try {
			// Use Monday.com Status Manager if available, otherwise direct assignment
			const persistenceMode = persistenceManager.getStatus().mode;
			
			if (persistenceMode === 'monday' || persistenceMode === 'hybrid') {
				// Use Monday.com Status Manager for advanced status management
				const statusResult = await mondayStatusManager.updateTaskStatus(
					taskId, 
					newStatus, 
					{
						optimistic: false, // We're updating data directly
						validateTransition: true,
						updateDependencies: true, // Enable dependency updates for main tasks
						triggerWebhooks: true,
						moveToGroup: true,
						projectRoot,
						session
					}
				);
				
				if (statusResult.success) {
					// Update the local data structure to match
					task.status = newStatus;
					log('info', `Updated task ${taskId} status from '${oldStatus}' to '${newStatus}' via Monday.com Status Manager`);
				} else {
					throw new Error(`Monday.com status update failed for task ${taskId}`);
				}
			} else {
				// Use direct assignment for local persistence
				task.status = newStatus;
				log('info', `Updated task ${taskId} status from '${oldStatus}' to '${newStatus}' (local mode)`);
			}
		} catch (error) {
			log('warn', `Failed to use advanced status management for task ${taskId}: ${error.message}. Falling back to direct assignment.`);
			task.status = newStatus;
		}

		// If marking as done, also mark all subtasks as done
		if (
			(newStatus.toLowerCase() === 'done' ||
				newStatus.toLowerCase() === 'completed') &&
			task.subtasks &&
			task.subtasks.length > 0
		) {
			const pendingSubtasks = task.subtasks.filter(
				(st) => st.status !== 'done' && st.status !== 'completed'
			);

			if (pendingSubtasks.length > 0) {
				log(
					'info',
					`Also marking ${pendingSubtasks.length} subtasks as '${newStatus}'`
				);

				// Update subtasks using the same unified approach
				for (const subtask of pendingSubtasks) {
					try {
						const persistenceMode = persistenceManager.getStatus().mode;
						
						if (persistenceMode === 'monday' || persistenceMode === 'hybrid') {
							// Use Monday.com Status Manager for subtasks
							const statusResult = await mondayStatusManager.updateTaskStatus(
								`${taskId}.${subtask.id}`, 
								newStatus, 
								{
									optimistic: false,
									validateTransition: false, // Skip validation for automatic updates
									updateDependencies: false,
									triggerWebhooks: true,
									moveToGroup: true,
									projectRoot,
									session
								}
							);
							
							if (statusResult.success) {
								subtask.status = newStatus;
							} else {
								log('warn', `Failed to update subtask ${taskId}.${subtask.id} via Monday.com Status Manager, using direct assignment`);
								subtask.status = newStatus;
							}
						} else {
							// Direct assignment for local mode
							subtask.status = newStatus;
						}
					} catch (error) {
						log('warn', `Error updating subtask ${taskId}.${subtask.id}: ${error.message}. Using direct assignment.`);
						subtask.status = newStatus;
					}
				}
			}
		}
	}
}

export default updateSingleTaskStatus;
