import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';

import { log, readJSON, writeJSON, findTaskById, findProjectRoot } from '../utils.js';
import { displayBanner } from '../ui.js';
import { validateTaskDependencies } from '../dependency-manager.js';
import { getDebugFlag } from '../config-manager.js';
import updateSingleTaskStatus from './update-single-task-status.js';
import generateTaskFiles from './generate-task-files.js';
import { markTaskForSync } from './monday-sync-utils.js';
import { onTaskStatusChanged } from './auto-sync-hooks.js';
import {
	isValidTaskStatus,
	TASK_STATUS_OPTIONS
} from '../../../src/constants/task-status.js';

/**
 * Set the status of a task
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
		
		// Determine project root for sync hooks
		const projectRoot = options.projectRoot || findProjectRoot(path.dirname(tasksPath));

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

		log('info', `Reading tasks from ${tasksPath}...`);
		const data = readJSON(tasksPath);
		if (!data || !data.tasks) {
			throw new Error(`No valid tasks found in ${tasksPath}`);
		}

		// Handle multiple task IDs (comma-separated)
		const taskIds = taskIdInput.split(',').map((id) => id.trim());
		const updatedTasks = [];
		const syncResults = [];

		// Store old statuses for sync hooks
		const oldStatuses = {};
		for (const id of taskIds) {
			const task = findTaskById(data.tasks, id);
			if (task) {
				oldStatuses[id] = task.status;
			}
		}

		// Update each task
		for (const id of taskIds) {
			await updateSingleTaskStatus(tasksPath, id, newStatus, data, !isMcpMode);
			updatedTasks.push(id);
		}

		// Write the updated tasks to the file
		writeJSON(tasksPath, data);

		// Trigger automatic sync hooks for each updated task
		for (const id of updatedTasks) {
			const task = findTaskById(data.tasks, id);
			if (task) {
				try {
					// Call the auto-sync hook for status changes
					const syncSuccess = await onTaskStatusChanged(
						projectRoot,
						task,
						oldStatuses[id],
						{
							session: options.session,
							mcpLog: options.mcpLog,
							throwOnError: false // Don't throw errors in set-status, just log them
						}
					);
					
					syncResults.push({
						taskId: id,
						syncSuccess,
						oldStatus: oldStatuses[id],
						newStatus: task.status
					});
				} catch (error) {
					log('warn', `Auto-sync failed for task ${id}: ${error.message}`);
					syncResults.push({
						taskId: id,
						syncSuccess: false,
						syncError: error.message,
						oldStatus: oldStatuses[id],
						newStatus: task.status
					});
				}
			}
		}

		// Mark tasks for Monday.com sync unless this is part of a sync operation
		// Check if any of the updated tasks have Monday sync data to avoid marking during sync
		for (const id of updatedTasks) {
			const task = findTaskById(data.tasks, id);
			if (task && (!task.mondayItemId || !options.skipMondaySync)) {
				markTaskForSync(tasksPath, id);
				log('info', `Task ${id} marked for Monday.com sync`);
			}
		}

		// Validate dependencies after status update
		log('info', 'Validating dependencies after status update...');
		validateTaskDependencies(data.tasks);

		// Generate individual task files
		log('info', 'Regenerating task files...');
		await generateTaskFiles(tasksPath, path.dirname(tasksPath), {
			mcpLog: options.mcpLog
		});

		// Display success message - only in CLI mode
		if (!isMcpMode) {
			for (const id of updatedTasks) {
				const task = findTaskById(data.tasks, id);
				const taskName = task ? task.title : id;
				const syncResult = syncResults.find(r => r.taskId === id);

				console.log(
					boxen(
						chalk.white.bold(`Successfully updated task ${id} status:`) +
							'\n' +
							`From: ${chalk.yellow(syncResult?.oldStatus || 'unknown')}\n` +
							`To:   ${chalk.green(newStatus)}` +
							(syncResult?.syncSuccess === true 
								? '\n' + chalk.green('✅ Synced to Monday.com')
								: syncResult?.syncSuccess === false && !syncResult?.syncError
								? '\n' + chalk.yellow('⚠️ Monday.com sync skipped (not in hybrid mode)')
								: syncResult?.syncError
								? '\n' + chalk.red(`❌ Monday.com sync failed: ${syncResult.syncError}`)
								: ''),
						{ padding: 1, borderColor: 'green', borderStyle: 'round' }
					)
				);
			}
		}

		// Return success value for programmatic use
		return {
			success: true,
			updatedTasks: updatedTasks.map((id) => ({
				id,
				status: newStatus
			})),
			syncResults: syncResults // Include sync results in response
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
