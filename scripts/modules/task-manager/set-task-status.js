import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';

import { log, findTaskById } from '../utils.js';
import { persistenceManager } from '../persistence-manager.js';
import { mondayStatusManager } from '../monday-status-manager.js';
import { displayBanner } from '../ui.js';
import { validateTaskDependencies } from '../dependency-manager.js';
import { getDebugFlag } from '../config-manager.js';
import updateSingleTaskStatus from './update-single-task-status.js';
import generateTaskFiles from './generate-task-files.js';
import {
	isValidTaskStatus,
	TASK_STATUS_OPTIONS
} from '../../../src/constants/task-status.js';

/**
 * Set the status of a task with Monday.com integration
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {string} taskIdInput - Task ID(s) to update
 * @param {string} newStatus - New status
 * @param {Object} options - Additional options (mcpLog for MCP mode, session, projectRoot)
 * @returns {Object|undefined} Result object in MCP mode, undefined in CLI mode
 */
async function setTaskStatus(tasksPath, taskIdInput, newStatus, options = {}) {
	try {
		if (!isValidTaskStatus(newStatus)) {
			throw new Error(
				`Error: Invalid status value: ${newStatus}. Use one of: ${TASK_STATUS_OPTIONS.join(', ')}`
			);
		}
		
		// Determine if we're in MCP mode by checking for mcpLog
		const isMcpMode = !!options?.mcpLog;
		const { session, projectRoot } = options;

		// Initialize both persistence manager and Monday.com status manager
		await persistenceManager.initialize(projectRoot, session);
		await mondayStatusManager.initialize(projectRoot, session);

		// Only display UI elements if not in MCP mode
		if (!isMcpMode) {
			displayBanner();

			console.log(
				boxen(chalk.white.bold(`Updating Task Status to: ${newStatus}`), {
					padding: 1,
					borderColor: 'blue',
					borderStyle: 'round'
				})
			);
		}

		const persistenceStatus = persistenceManager.getStatus();
		log('info', `Updating task status using ${persistenceStatus.mode} persistence mode...`);

		// Handle multiple task IDs (comma-separated)
		const taskIds = taskIdInput.split(',').map((id) => id.trim());
		const updatedTasks = [];
		const updateResults = [];

		// Update each task using the appropriate method based on persistence mode
		for (const id of taskIds) {
			try {
				let result;

				if (persistenceStatus.mode === 'monday' || persistenceStatus.mode === 'hybrid') {
					// Use the Monday.com Status Manager for advanced status management
					result = await mondayStatusManager.updateTaskStatus(id, newStatus, {
						optimistic: true,
						validateTransition: true,
						updateDependencies: true,
						triggerWebhooks: true,
						moveToGroup: true,
						projectRoot,
						session
					});

					log('info', `Task ${id} updated via Monday.com Status Manager`);
				} else {
					// Use traditional local persistence method
					const data = await persistenceManager.readTasks(tasksPath, { projectRoot, session });
					
					if (!data || !data.tasks) {
						throw new Error(`No valid tasks found in ${tasksPath}`);
					}

					await updateSingleTaskStatus(tasksPath, id, newStatus, data, !isMcpMode, {
						session,
						projectRoot
					});
					await persistenceManager.writeTasks(tasksPath, data, { projectRoot, session });

					result = {
						success: true,
						taskId: id,
						newStatus,
						mode: 'local',
						updatedAt: new Date().toISOString()
					};

					log('info', `Task ${id} updated via local persistence`);
				}

				updatedTasks.push(id);
				updateResults.push(result);

			} catch (error) {
				log('error', `Failed to update task ${id}: ${error.message}`);
				
				// In MCP mode, collect errors and continue with other tasks
				if (isMcpMode) {
					updateResults.push({
						success: false,
						taskId: id,
						error: error.message
					});
				} else {
					throw error; // In CLI mode, fail immediately
				}
			}
		}

		// Post-update operations for successful updates
		if (updatedTasks.length > 0) {
			// Validate dependencies after status updates
			if (persistenceStatus.mode === 'local') {
				log('info', 'Validating dependencies after status update...');
				const data = await persistenceManager.readTasks(tasksPath, { projectRoot, session });
				if (data && data.tasks) {
					validateTaskDependencies(data.tasks);
				}

				// Generate individual task files for local mode
				log('info', 'Regenerating task files...');
				await generateTaskFiles(tasksPath, path.dirname(tasksPath), {
					mcpLog: options.mcpLog
				});
			}

			// Display success messages - only in CLI mode
			if (!isMcpMode) {
				for (const id of updatedTasks) {
					const updateResult = updateResults.find(r => r.taskId === id && r.success);
					const oldStatus = updateResult?.oldStatus || 'unknown';

					console.log(
						boxen(
							chalk.white.bold(`Successfully updated task ${id} status:`) +
								'\n' +
								`From: ${chalk.yellow(oldStatus)}\n` +
								`To:   ${chalk.green(newStatus)}\n` +
								`Mode: ${chalk.blue(updateResult?.mode || persistenceStatus.mode)}`,
							{ padding: 1, borderColor: 'green', borderStyle: 'round' }
						)
					);
				}

				// Display telemetry if Monday.com mode
				if (persistenceStatus.mode === 'monday' || persistenceStatus.mode === 'hybrid') {
					const telemetry = mondayStatusManager.getTelemetry();
					console.log(chalk.gray(`\n📊 Status Manager Stats: ${telemetry.statusUpdates} updates, ${telemetry.optimisticUpdates} optimistic, ${telemetry.errors} errors`));
				}
			}
		}

		// Return success value for programmatic use
		const successfulUpdates = updateResults.filter(r => r.success);
		const failedUpdates = updateResults.filter(r => !r.success);

		return {
			success: successfulUpdates.length > 0,
			totalRequested: taskIds.length,
			successful: successfulUpdates.length,
			failed: failedUpdates.length,
			persistenceMode: persistenceStatus.mode,
			mondayInitialized: persistenceStatus.mondayInitialized,
			fallbackActive: persistenceStatus.fallbackActive,
			updates: updateResults,
			telemetry: persistenceStatus.mode === 'monday' || persistenceStatus.mode === 'hybrid' 
				? mondayStatusManager.getTelemetry() 
				: null
		};

	} catch (error) {
		log('error', `Error setting task status: ${error.message}`);

		// Only show error UI in CLI mode
		if (!options?.mcpLog) {
			console.error(chalk.red(`Error: ${error.message}`));

			// Pass session to getDebugFlag
			if (getDebugFlag(options?.session)) {
				// Use getter
				console.error(error);
			}

			process.exit(1);
		} else {
			// In MCP mode, throw the error for the caller to handle
			throw error;
		}
	}
}

export default setTaskStatus;
