import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';
import { z } from 'zod'; // Keep Zod for post-parse validation

import {
	log as consoleLog,
	truncate
} from '../utils.js';
import { persistenceManager } from '../persistence-manager.js';
import {
	displayBanner,
	getStatusWithColor,
	startLoadingIndicator,
	stopLoadingIndicator,
	displayAiUsageSummary
} from '../ui.js';
import { generateTextService } from '../ai-services-unified.js';
import {
	getDebugFlag,
	isApiKeySet // Keep this check
} from '../config-manager.js';
import generateTaskFiles from './generate-task-files.js';

// Zod schema for post-parsing validation of the updated task object
const updatedTaskSchema = z
	.object({
		id: z.number().int(),
		title: z.string(), // Title should be preserved, but check it exists
		description: z.string(),
		status: z.string(),
		dependencies: z.array(z.union([z.number().int(), z.string()])),
		priority: z.string().optional(),
		details: z.string().optional(),
		testStrategy: z.string().optional(),
		subtasks: z.array(z.any()).optional()
	})
	.strip(); // Allows parsing even if AI adds extra fields, but validation focuses on schema

/**
 * Parses AI response text for task update
 * @param {string} text - AI response text
 * @param {number} expectedTaskId - Expected task ID for validation
 * @param {function} logFn - Logging function
 * @param {boolean} isMCP - Whether we're in MCP mode
 * @returns {Object|null} Parsed task object or null if parsing fails
 */
function parseUpdatedTaskFromText(text, expectedTaskId, logFn, isMCP) {
	// Helper function for reporting
	const report = (level, ...args) => {
		if (logFn && typeof logFn[level] === 'function') {
			logFn[level](...args);
		} else if (logFn && typeof logFn === 'function') {
			logFn(level, ...args);
		} else {
			consoleLog(level, ...args);
		}
	};

	try {
		// Clean the text and extract JSON
		let cleanedText = text.trim();

		// Remove common AI response wrapping
		cleanedText = cleanedText.replace(/^Here(?:'s| is) (?:the )?updated task:?\s*/i, '');
		cleanedText = cleanedText.replace(/^```json\s*/i, '');
		cleanedText = cleanedText.replace(/\s*```\s*$/i, '');
		cleanedText = cleanedText.replace(/^```\s*/i, '');

		// Try to find JSON content
		const jsonStartIndex = cleanedText.indexOf('{');
		const jsonEndIndex = cleanedText.lastIndexOf('}');

		if (jsonStartIndex === -1 || jsonEndIndex === -1) {
			throw new Error('No JSON object found in AI response');
		}

		const jsonText = cleanedText.substring(jsonStartIndex, jsonEndIndex + 1);
		const parsedTask = JSON.parse(jsonText);

		// Validate the parsed task
		if (!parsedTask || typeof parsedTask !== 'object') {
			throw new Error('Parsed result is not a valid object');
		}

		if (!parsedTask.title || !parsedTask.description) {
			throw new Error('Parsed task missing required fields (title, description)');
		}

		// Validate ID matches
		if (parsedTask.id !== expectedTaskId) {
			report('warn', `AI changed task ID from ${expectedTaskId} to ${parsedTask.id}. Correcting...`);
			parsedTask.id = expectedTaskId;
		}

		return parsedTask;

	} catch (error) {
		report('error', `Failed to parse AI response: ${error.message}`);
		report('debug', `Raw AI response: ${text}`);
		return null;
	}
}

/**
 * Updates a specific task by ID using AI
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {number} taskId - ID of the task to update
 * @param {string} prompt - Description of the changes to make
 * @param {boolean} useResearch - Whether to use research capabilities
 * @param {Object} context - Context object containing session and potentially projectRoot
 * @param {string} outputFormat - Output format ('text' or 'json')
 * @returns {Promise<Object|null>} Updated task data or null if not updated
 */
async function updateTaskById(
	tasksPath,
	taskId,
	prompt,
	useResearch = false,
	context = {},
	outputFormat = 'text'
) {
	const { session, mcpLog, projectRoot } = context;
	const isMCP = !!mcpLog;

	// Initialize persistence manager with project context
	await persistenceManager.initialize(projectRoot, session);

	// Create a consistent logFn object regardless of context
	const logFn = isMCP
		? mcpLog // Use MCP logger if provided
		: {
				// Create a wrapper around consoleLog for CLI
				info: (...args) => consoleLog('info', ...args),
				warn: (...args) => consoleLog('warn', ...args),
				error: (...args) => consoleLog('error', ...args),
				debug: (...args) => consoleLog('debug', ...args),
				success: (...args) => consoleLog('success', ...args)
			};

	// Helper function for reporting that works in both MCP and CLI modes
	const report = (level, ...args) => {
		if (logFn && typeof logFn[level] === 'function') {
			logFn[level](...args);
		} else if (logFn && typeof logFn === 'function') {
			logFn(level, ...args);
		} else {
			consoleLog(level, ...args);
		}
	};

	try {
		// --- Input Validations ---
		if (!prompt || prompt.trim().length === 0) {
			throw new Error('Update prompt cannot be empty.');
		}
		if (!taskId || isNaN(parseInt(taskId, 10))) {
			throw new Error('Invalid task ID provided.');
		}
		taskId = parseInt(taskId, 10);
		// Validate research usage
		if (useResearch) {
			try {
				// Test if Perplexity is available in the environment
				const testResponse = await generateTextService({
					role: 'research',
					session: session,
					projectRoot: projectRoot,
					systemPrompt: 'Test',
					prompt: 'Test',
					commandName: 'test',
					outputType: isMCP ? 'mcp' : 'cli'
				});
			} catch (testError) {
				report(
					'warn',
					chalk.yellow('Perplexity AI not available. Falling back to main AI.')
				);
				useResearch = false;
			}
		}
		if (!fs.existsSync(tasksPath))
			throw new Error(`Tasks file not found: ${tasksPath}`);
		// --- End Input Validations ---

		// --- Task Loading and Status Check (Keep existing) ---
		const data = await persistenceManager.readTasks(tasksPath, { projectRoot, session });
		if (!data || !data.tasks)
			throw new Error(`No valid tasks found in ${tasksPath}.`);
		const taskIndex = data.tasks.findIndex((task) => task.id === taskId);
		if (taskIndex === -1) throw new Error(`Task with ID ${taskId} not found.`);
		const taskToUpdate = data.tasks[taskIndex];
		if (taskToUpdate.status === 'done' || taskToUpdate.status === 'completed') {
			report(
				'warn',
				`Task ${taskId} is already marked as done and cannot be updated`
			);

			// Only show warning box for text output (CLI)
			if (outputFormat === 'text') {
				console.log(
					boxen(
						chalk.yellow(
							`Task ${taskId} is already marked as ${taskToUpdate.status} and cannot be updated.`
						) +
							'\n\n' +
							chalk.white(
								'Completed tasks are locked to maintain consistency. To modify a completed task, you must first:'
							) +
							'\n' +
							chalk.white(
								'1. Change its status to "pending" or "in-progress"'
							) +
							'\n' +
							chalk.white('2. Then run the update-task command'),
						{ padding: 1, borderColor: 'yellow', borderStyle: 'round' }
					)
				);
			}
			return null;
		}
		// --- End Task Loading ---

		// --- Display Task Info (CLI Only - Keep existing) ---
		if (outputFormat === 'text') {
			// Show the task that will be updated
			const table = new Table({
				head: [
					chalk.cyan.bold('ID'),
					chalk.cyan.bold('Title'),
					chalk.cyan.bold('Status')
				],
				colWidths: [5, 60, 10]
			});

			table.push([
				taskToUpdate.id,
				truncate(taskToUpdate.title, 57),
				getStatusWithColor(taskToUpdate.status)
			]);

			console.log(
				boxen(chalk.white.bold(`Updating Task #${taskId}`), {
					padding: 1,
					borderColor: 'blue',
					borderStyle: 'round',
					margin: { top: 1, bottom: 0 }
				})
			);

			console.log(table.toString());

			// Display a message about how completed subtasks are handled
			console.log(
				boxen(
					chalk.cyan.bold('How Completed Subtasks Are Handled:') +
						'\n\n' +
						chalk.white(
							'• Subtasks marked as "done" or "completed" will be preserved\n'
						) +
						chalk.white(
							'• New subtasks will build upon what has already been completed\n'
						) +
						chalk.white(
							'• If completed work needs revision, a new subtask will be created instead of modifying done items\n'
						) +
						chalk.white(
							'• This approach maintains a clear record of completed work and new requirements'
						),
					{
						padding: 1,
						borderColor: 'blue',
						borderStyle: 'round',
						margin: { top: 1, bottom: 1 }
					}
				)
			);
		}

		// --- Build Prompts (Keep EXACT original prompts) ---
		const systemPrompt = `You are an AI assistant helping to update a software development task based on new context.
You will be given a task and a prompt describing changes or new implementation details.
Your job is to update the task to reflect these changes, while preserving its basic structure.

Guidelines:
1. VERY IMPORTANT: NEVER change the title of the task - keep it exactly as is
2. Maintain the same ID, status, and dependencies unless specifically mentioned in the prompt
3. Update the description, details, and test strategy to reflect the new information
4. Do not change anything unnecessarily - just adapt what needs to change based on the prompt
5. Return a complete valid JSON object representing the updated task
6. VERY IMPORTANT: Preserve all subtasks marked as "done" or "completed" - do not modify their content
7. For tasks with completed subtasks, build upon what has already been done rather than rewriting everything
8. If an existing completed subtask needs to be changed/undone based on the new context, DO NOT modify it directly
9. Instead, add a new subtask that clearly indicates what needs to be changed or replaced
10. Use the existence of completed subtasks as an opportunity to make new subtasks more specific and targeted
11. Ensure any new subtasks have unique IDs that don't conflict with existing ones

The changes described in the prompt should be thoughtfully applied to make the task more accurate and actionable.`;

		const taskDataString = JSON.stringify(taskToUpdate, null, 2); // Use original task data
		const userPrompt = `Here is the task to update:\n${taskDataString}\n\nPlease update this task based on the following new context:\n${prompt}\n\nIMPORTANT: In the task JSON above, any subtasks with "status": "done" or "status": "completed" should be preserved exactly as is. Build your changes around these completed items.\n\nReturn only the updated task as a valid JSON object.`;
		// --- End Build Prompts ---

		let loadingIndicator = null;
		let aiServiceResponse = null;

		if (!isMCP && outputFormat === 'text') {
			loadingIndicator = startLoadingIndicator(
				useResearch ? 'Updating task with research...\n' : 'Updating task...\n'
			);
		}

		try {
			const serviceRole = useResearch ? 'research' : 'main';
			aiServiceResponse = await generateTextService({
				role: serviceRole,
				session: session,
				projectRoot: projectRoot,
				systemPrompt: systemPrompt,
				prompt: userPrompt,
				commandName: 'update-task',
				outputType: isMCP ? 'mcp' : 'cli'
			});

			if (loadingIndicator)
				stopLoadingIndicator(loadingIndicator, 'AI update complete.');

			// Use mainResult (text) for parsing
			const updatedTask = parseUpdatedTaskFromText(
				aiServiceResponse.mainResult,
				taskId,
				logFn,
				isMCP
			);

			// --- Task Validation/Correction (Keep existing logic) ---
			if (!updatedTask || typeof updatedTask !== 'object')
				throw new Error('Received invalid task object from AI.');
			if (!updatedTask.title || !updatedTask.description)
				throw new Error('Updated task missing required fields.');
			// Preserve ID if AI changed it
			if (updatedTask.id !== taskId) {
				report('warn', `AI changed task ID. Restoring original ID ${taskId}.`);
				updatedTask.id = taskId;
			}
			// Preserve status if AI changed it
			if (
				updatedTask.status !== taskToUpdate.status &&
				!prompt.toLowerCase().includes('status')
			) {
				report(
					'warn',
					`AI changed task status. Restoring original status '${taskToUpdate.status}'.`
				);
				updatedTask.status = taskToUpdate.status;
			}
			// Preserve completed subtasks (Keep existing logic)
			if (taskToUpdate.subtasks?.length > 0) {
				if (!updatedTask.subtasks) {
					report(
						'warn',
						'Subtasks removed by AI. Restoring original subtasks.'
					);
					updatedTask.subtasks = taskToUpdate.subtasks;
				} else {
					const completedOriginal = taskToUpdate.subtasks.filter(
						(st) => st.status === 'done' || st.status === 'completed'
					);
					completedOriginal.forEach((compSub) => {
						const updatedSub = updatedTask.subtasks.find(
							(st) => st.id === compSub.id
						);
						if (
							!updatedSub ||
							JSON.stringify(updatedSub) !== JSON.stringify(compSub)
						) {
							report(
								'warn',
								`Completed subtask ${compSub.id} was modified. Restoring original.`
							);
							const subIndex = updatedTask.subtasks.findIndex(
								(st) => st.id === compSub.id
							);
							if (subIndex !== -1) {
								updatedTask.subtasks[subIndex] = compSub;
							} else {
								updatedTask.subtasks.push(compSub);
							}
						}
					});
				}
			}
			// --- End Task Validation ---

			// --- Update Task in Data (Keep existing) ---
			data.tasks[taskIndex] = updatedTask;
			// --- End Update ---

			// --- Save to File ---
			await persistenceManager.writeTasks(tasksPath, data, { projectRoot, session });
			// --- End Save ---

			// --- Generate Task Files ---
			try {
				await generateTaskFiles(tasksPath, path.dirname(tasksPath), {
					mcpLog: logFn
				});
				report('info', 'Task files updated successfully.');
			} catch (genError) {
				report('warn', `Failed to update task files: ${genError.message}`);
			}
			// --- End Generate ---

			// --- Display Results (CLI Only) ---
			if (outputFormat === 'text') {
				console.log(
					boxen(
						chalk.white.bold(`Task ${taskId} Updated Successfully`) +
							'\n\n' +
							chalk.white(`Updated Title: ${updatedTask.title}`) +
							'\n' +
							chalk.white(`Status: ${getStatusWithColor(updatedTask.status)}`) +
							'\n' +
							chalk.white(`Dependencies: ${updatedTask.dependencies?.length || 0}`) +
							'\n' +
							chalk.white(`Subtasks: ${updatedTask.subtasks?.length || 0}`),
						{ padding: 1, borderColor: 'green', borderStyle: 'round' }
					)
				);

				// Display AI Usage Summary if available
				if (aiServiceResponse && aiServiceResponse.telemetryData) {
					displayAiUsageSummary(aiServiceResponse.telemetryData, 'cli');
				}
			}
			// --- End Display ---

			return {
				success: true,
				updatedTask: updatedTask,
				telemetryData: aiServiceResponse?.telemetryData || null,
				persistenceMode: persistenceManager.getStatus().mode
			};
		} catch (serviceError) {
			if (loadingIndicator)
				stopLoadingIndicator(loadingIndicator, 'Update failed.');
			throw serviceError;
		}
	} catch (error) {
		report('error', `Error updating task: ${error.message}`);
		if (outputFormat === 'text' && !isMCP) {
			console.error(chalk.red(`Error: ${error.message}`));
		}
		// Let MCP mode handle the error appropriately
		if (isMCP) {
			throw error;
		}
		return null;
	}
}

export default updateTaskById;
