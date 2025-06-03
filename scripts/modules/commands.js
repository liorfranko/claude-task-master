/**
 * commands.js
 * Command-line interface for the Task Master CLI
 */

import { program } from 'commander';
import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import fs from 'fs';
import https from 'https';
import http from 'http';
import inquirer from 'inquirer';
import ora from 'ora'; // Import ora

import { log, readJSON, writeJSON } from './utils.js';
import {
	parsePRD,
	updateTasks,
	generateTaskFiles,
	setTaskStatus,
	listTasks,
	expandTask,
	expandAllTasks,
	clearSubtasks,
	addTask,
	addSubtask,
	removeSubtask,
	analyzeTaskComplexity,
	updateTaskById,
	updateSubtaskById,
	removeTask,
	findTaskById,
	taskExists,
	moveTask
} from './task-manager.js';

import {
	addDependency,
	removeDependency,
	validateDependenciesCommand,
	fixDependenciesCommand
} from './dependency-manager.js';

import {
	isApiKeySet,
	getDebugFlag,
	getConfig,
	writeConfig,
	ConfigurationError,
	isConfigFilePresent,
	getAvailableModels,
	getBaseUrlForRole,
	getMondayApiToken,
	validateMondayConfigWithBoardInfo,
	getMondayIntegrationConfig,
	updateMondayConfig,
	getMondayColumnMapping,
	getPersistenceConfig,
	getPersistenceMode,
	setPersistenceMode,
	validatePersistenceConfig,
	migrateMondayIntegrationToPersistence
} from './config-manager.js';

import {
	displayBanner,
	displayHelp,
	displayNextTask,
	displayTaskById,
	displayComplexityReport,
	getStatusWithColor,
	confirmTaskOverwrite,
	startLoadingIndicator,
	stopLoadingIndicator,
	displayModelConfiguration,
	displayAvailableModels,
	displayApiKeyStatus,
	displayAiUsageSummary,
	displayPersistenceConfiguration,
	displayPersistenceValidation,
	displayPersistenceModeHelp,
	displayPersistenceMigration
} from './ui.js';

import { MondayClient } from './monday-client.js';
import { initializeProject } from '../init.js';
import {
	getModelConfiguration,
	getAvailableModelsList,
	setModel,
	getApiKeyStatusReport
} from './task-manager/models.js';
import { findProjectRoot } from './utils.js';
import {
	isValidTaskStatus,
	TASK_STATUS_OPTIONS
} from '../../src/constants/task-status.js';
import { getTaskMasterVersion } from '../../src/utils/getVersion.js';
/**
 * Runs the interactive setup process for model configuration.
 * @param {string|null} projectRoot - The resolved project root directory.
 */
async function runInteractiveSetup(projectRoot) {
	if (!projectRoot) {
		console.error(
			chalk.red(
				'Error: Could not determine project root for interactive setup.'
			)
		);
		process.exit(1);
	}

	const currentConfigResult = await getModelConfiguration({ projectRoot });
	const currentModels = currentConfigResult.success
		? currentConfigResult.data.activeModels
		: { main: null, research: null, fallback: null };
	// Handle potential config load failure gracefully for the setup flow
	if (
		!currentConfigResult.success &&
		currentConfigResult.error?.code !== 'CONFIG_MISSING'
	) {
		console.warn(
			chalk.yellow(
				`Warning: Could not load current model configuration: ${currentConfigResult.error?.message || 'Unknown error'}. Proceeding with defaults.`
			)
		);
	}

	// Helper function to fetch OpenRouter models (duplicated for CLI context)
	function fetchOpenRouterModelsCLI() {
		return new Promise((resolve) => {
			const options = {
				hostname: 'openrouter.ai',
				path: '/api/v1/models',
				method: 'GET',
				headers: {
					Accept: 'application/json'
				}
			};

			const req = https.request(options, (res) => {
				let data = '';
				res.on('data', (chunk) => {
					data += chunk;
				});
				res.on('end', () => {
					if (res.statusCode === 200) {
						try {
							const parsedData = JSON.parse(data);
							resolve(parsedData.data || []); // Return the array of models
						} catch (e) {
							console.error('Error parsing OpenRouter response:', e);
							resolve(null); // Indicate failure
						}
					} else {
						console.error(
							`OpenRouter API request failed with status code: ${res.statusCode}`
						);
						resolve(null); // Indicate failure
					}
				});
			});

			req.on('error', (e) => {
				console.error('Error fetching OpenRouter models:', e);
				resolve(null); // Indicate failure
			});
			req.end();
		});
	}

	// Helper function to fetch Ollama models (duplicated for CLI context)
	function fetchOllamaModelsCLI(baseUrl = 'http://localhost:11434/api') {
		return new Promise((resolve) => {
			try {
				// Parse the base URL to extract hostname, port, and base path
				const url = new URL(baseUrl);
				const isHttps = url.protocol === 'https:';
				const port = url.port || (isHttps ? 443 : 80);
				const basePath = url.pathname.endsWith('/')
					? url.pathname.slice(0, -1)
					: url.pathname;

				const options = {
					hostname: url.hostname,
					port: parseInt(port, 10),
					path: `${basePath}/tags`,
					method: 'GET',
					headers: {
						Accept: 'application/json'
					}
				};

				const requestLib = isHttps ? https : http;
				const req = requestLib.request(options, (res) => {
					let data = '';
					res.on('data', (chunk) => {
						data += chunk;
					});
					res.on('end', () => {
						if (res.statusCode === 200) {
							try {
								const parsedData = JSON.parse(data);
								resolve(parsedData.models || []); // Return the array of models
							} catch (e) {
								console.error('Error parsing Ollama response:', e);
								resolve(null); // Indicate failure
							}
						} else {
							console.error(
								`Ollama API request failed with status code: ${res.statusCode}`
							);
							resolve(null); // Indicate failure
						}
					});
				});

				req.on('error', (e) => {
					console.error('Error fetching Ollama models:', e);
					resolve(null); // Indicate failure
				});
				req.end();
			} catch (e) {
				console.error('Error parsing Ollama base URL:', e);
				resolve(null); // Indicate failure
			}
		});
	}

	// Helper to get choices and default index for a role
	const getPromptData = (role, allowNone = false) => {
		const currentModel = currentModels[role]; // Use the fetched data
		const allModelsRaw = getAvailableModels(); // Get all available models

		// Manually group models by provider
		const modelsByProvider = allModelsRaw.reduce((acc, model) => {
			if (!acc[model.provider]) {
				acc[model.provider] = [];
			}
			acc[model.provider].push(model);
			return acc;
		}, {});

		const cancelOption = { name: '⏹ Cancel Model Setup', value: '__CANCEL__' }; // Symbol updated
		const noChangeOption = currentModel?.modelId
			? {
					name: `✔ No change to current ${role} model (${currentModel.modelId})`, // Symbol updated
					value: '__NO_CHANGE__'
				}
			: null;

		const customOpenRouterOption = {
			name: '* Custom OpenRouter model', // Symbol updated
			value: '__CUSTOM_OPENROUTER__'
		};

		const customOllamaOption = {
			name: '* Custom Ollama model', // Symbol updated
			value: '__CUSTOM_OLLAMA__'
		};

		let choices = [];
		let defaultIndex = 0; // Default to 'Cancel'

		// Filter and format models allowed for this role using the manually grouped data
		const roleChoices = Object.entries(modelsByProvider)
			.map(([provider, models]) => {
				const providerModels = models
					.filter((m) => m.allowed_roles.includes(role))
					.map((m) => ({
						name: `${provider} / ${m.id} ${
							m.cost_per_1m_tokens
								? chalk.gray(
										`($${m.cost_per_1m_tokens.input.toFixed(2)} input | $${m.cost_per_1m_tokens.output.toFixed(2)} output)`
									)
								: ''
						}`,
						value: { id: m.id, provider },
						short: `${provider}/${m.id}`
					}));
				if (providerModels.length > 0) {
					return [...providerModels];
				}
				return null;
			})
			.filter(Boolean)
			.flat();

		// Find the index of the currently selected model for setting the default
		let currentChoiceIndex = -1;
		if (currentModel?.modelId && currentModel?.provider) {
			currentChoiceIndex = roleChoices.findIndex(
				(choice) =>
					typeof choice.value === 'object' &&
					choice.value.id === currentModel.modelId &&
					choice.value.provider === currentModel.provider
			);
		}

		// Construct final choices list based on whether 'None' is allowed
		const commonPrefix = [];
		if (noChangeOption) {
			commonPrefix.push(noChangeOption);
		}
		commonPrefix.push(cancelOption);
		commonPrefix.push(customOpenRouterOption);
		commonPrefix.push(customOllamaOption);

		let prefixLength = commonPrefix.length; // Initial prefix length

		if (allowNone) {
			choices = [
				...commonPrefix,
				new inquirer.Separator(),
				{ name: '⚪ None (disable)', value: null }, // Symbol updated
				new inquirer.Separator(),
				...roleChoices
			];
			// Adjust default index: Prefix + Sep1 + None + Sep2 (+3)
			const noneOptionIndex = prefixLength + 1;
			defaultIndex =
				currentChoiceIndex !== -1
					? currentChoiceIndex + prefixLength + 3 // Offset by prefix and separators
					: noneOptionIndex; // Default to 'None' if no current model matched
		} else {
			choices = [
				...commonPrefix,
				new inquirer.Separator(),
				...roleChoices,
				new inquirer.Separator()
			];
			// Adjust default index: Prefix + Sep (+1)
			defaultIndex =
				currentChoiceIndex !== -1
					? currentChoiceIndex + prefixLength + 1 // Offset by prefix and separator
					: noChangeOption
						? 1
						: 0; // Default to 'No Change' if present, else 'Cancel'
		}

		// Ensure defaultIndex is valid within the final choices array length
		if (defaultIndex < 0 || defaultIndex >= choices.length) {
			// If default calculation failed or pointed outside bounds, reset intelligently
			defaultIndex = 0; // Default to 'Cancel'
			console.warn(
				`Warning: Could not determine default model for role '${role}'. Defaulting to 'Cancel'.`
			); // Add warning
		}

		return { choices, default: defaultIndex };
	};

	// --- Generate choices using the helper ---
	const mainPromptData = getPromptData('main');
	const researchPromptData = getPromptData('research');
	const fallbackPromptData = getPromptData('fallback', true); // Allow 'None' for fallback

	const answers = await inquirer.prompt([
		{
			type: 'list',
			name: 'mainModel',
			message: 'Select the main model for generation/updates:',
			choices: mainPromptData.choices,
			default: mainPromptData.default
		},
		{
			type: 'list',
			name: 'researchModel',
			message: 'Select the research model:',
			choices: researchPromptData.choices,
			default: researchPromptData.default,
			when: (ans) => ans.mainModel !== '__CANCEL__'
		},
		{
			type: 'list',
			name: 'fallbackModel',
			message: 'Select the fallback model (optional):',
			choices: fallbackPromptData.choices,
			default: fallbackPromptData.default,
			when: (ans) =>
				ans.mainModel !== '__CANCEL__' && ans.researchModel !== '__CANCEL__'
		}
	]);

	let setupSuccess = true;
	let setupConfigModified = false;
	const coreOptionsSetup = { projectRoot }; // Pass root for setup actions

	// Helper to handle setting a model (including custom)
	async function handleSetModel(role, selectedValue, currentModelId) {
		if (selectedValue === '__CANCEL__') {
			console.log(
				chalk.yellow(`\nSetup canceled during ${role} model selection.`)
			);
			setupSuccess = false; // Also mark success as false on cancel
			return false; // Indicate cancellation
		}

		// Handle the new 'No Change' option
		if (selectedValue === '__NO_CHANGE__') {
			console.log(chalk.gray(`No change selected for ${role} model.`));
			return true; // Indicate success, continue setup
		}

		let modelIdToSet = null;
		let providerHint = null;
		let isCustomSelection = false;

		if (selectedValue === '__CUSTOM_OPENROUTER__') {
			isCustomSelection = true;
			const { customId } = await inquirer.prompt([
				{
					type: 'input',
					name: 'customId',
					message: `Enter the custom OpenRouter Model ID for the ${role} role:`
				}
			]);
			if (!customId) {
				console.log(chalk.yellow('No custom ID entered. Skipping role.'));
				return true; // Continue setup, but don't set this role
			}
			modelIdToSet = customId;
			providerHint = 'openrouter';
			// Validate against live OpenRouter list
			const openRouterModels = await fetchOpenRouterModelsCLI();
			if (
				!openRouterModels ||
				!openRouterModels.some((m) => m.id === modelIdToSet)
			) {
				console.error(
					chalk.red(
						`Error: Model ID "${modelIdToSet}" not found in the live OpenRouter model list. Please check the ID.`
					)
				);
				setupSuccess = false;
				return true; // Continue setup, but mark as failed
			}
		} else if (selectedValue === '__CUSTOM_OLLAMA__') {
			isCustomSelection = true;
			const { customId } = await inquirer.prompt([
				{
					type: 'input',
					name: 'customId',
					message: `Enter the custom Ollama Model ID for the ${role} role:`
				}
			]);
			if (!customId) {
				console.log(chalk.yellow('No custom ID entered. Skipping role.'));
				return true; // Continue setup, but don't set this role
			}
			modelIdToSet = customId;
			providerHint = 'ollama';
			// Get the Ollama base URL from config for this role
			const ollamaBaseUrl = getBaseUrlForRole(role, projectRoot);
			// Validate against live Ollama list
			const ollamaModels = await fetchOllamaModelsCLI(ollamaBaseUrl);
			if (ollamaModels === null) {
				console.error(
					chalk.red(
						`Error: Unable to connect to Ollama server at ${ollamaBaseUrl}. Please ensure Ollama is running and try again.`
					)
				);
				setupSuccess = false;
				return true; // Continue setup, but mark as failed
			} else if (!ollamaModels.some((m) => m.model === modelIdToSet)) {
				console.error(
					chalk.red(
						`Error: Model ID "${modelIdToSet}" not found in the Ollama instance. Please verify the model is pulled and available.`
					)
				);
				console.log(
					chalk.yellow(
						`You can check available models with: curl ${ollamaBaseUrl}/tags`
					)
				);
				setupSuccess = false;
				return true; // Continue setup, but mark as failed
			}
		} else if (
			selectedValue &&
			typeof selectedValue === 'object' &&
			selectedValue.id
		) {
			// Standard model selected from list
			modelIdToSet = selectedValue.id;
			providerHint = selectedValue.provider; // Provider is known
		} else if (selectedValue === null && role === 'fallback') {
			// Handle disabling fallback
			modelIdToSet = null;
			providerHint = null;
		} else if (selectedValue) {
			console.error(
				chalk.red(
					`Internal Error: Unexpected selection value for ${role}: ${JSON.stringify(selectedValue)}`
				)
			);
			setupSuccess = false;
			return true;
		}

		// Only proceed if there's a change to be made
		if (modelIdToSet !== currentModelId) {
			if (modelIdToSet) {
				// Set a specific model (standard or custom)
				const result = await setModel(role, modelIdToSet, {
					...coreOptionsSetup,
					providerHint // Pass the hint
				});
				if (result.success) {
					console.log(
						chalk.blue(
							`Set ${role} model: ${result.data.provider} / ${result.data.modelId}`
						)
					);
					if (result.data.warning) {
						// Display warning if returned by setModel
						console.log(chalk.yellow(result.data.warning));
					}
					setupConfigModified = true;
				} else {
					console.error(
						chalk.red(
							`Error setting ${role} model: ${result.error?.message || 'Unknown'}`
						)
					);
					setupSuccess = false;
				}
			} else if (role === 'fallback') {
				// Disable fallback model
				const currentCfg = getConfig(projectRoot);
				if (currentCfg?.models?.fallback?.modelId) {
					// Check if it was actually set before clearing
					currentCfg.models.fallback = {
						...currentCfg.models.fallback,
						provider: undefined,
						modelId: undefined
					};
					if (writeConfig(currentCfg, projectRoot)) {
						console.log(chalk.blue('Fallback model disabled.'));
						setupConfigModified = true;
					} else {
						console.error(
							chalk.red('Failed to disable fallback model in config file.')
						);
						setupSuccess = false;
					}
				} else {
					console.log(chalk.blue('Fallback model was already disabled.'));
				}
			}
		}
		return true; // Indicate setup should continue
	}

	// Process answers using the handler
	if (
		!(await handleSetModel(
			'main',
			answers.mainModel,
			currentModels.main?.modelId // <--- Now 'currentModels' is defined
		))
	) {
		return false; // Explicitly return false if cancelled
	}
	if (
		!(await handleSetModel(
			'research',
			answers.researchModel,
			currentModels.research?.modelId // <--- Now 'currentModels' is defined
		))
	) {
		return false; // Explicitly return false if cancelled
	}
	if (
		!(await handleSetModel(
			'fallback',
			answers.fallbackModel,
			currentModels.fallback?.modelId // <--- Now 'currentModels' is defined
		))
	) {
		return false; // Explicitly return false if cancelled
	}

	if (setupSuccess && setupConfigModified) {
		console.log(chalk.green.bold('\nModel setup complete!'));
	} else if (setupSuccess && !setupConfigModified) {
		console.log(chalk.yellow('\nNo changes made to model configuration.'));
	} else if (!setupSuccess) {
		console.error(
			chalk.red(
				'\nErrors occurred during model selection. Please review and try again.'
			)
		);
	}
	return true; // Indicate setup flow completed (not cancelled)
	// Let the main command flow continue to display results
}

/**
 * Configure and register CLI commands
 * @param {Object} program - Commander program instance
 */
function registerCommands(programInstance) {
	// Add global error handler for unknown options
	programInstance.on('option:unknown', function (unknownOption) {
		const commandName = this._name || 'unknown';
		console.error(chalk.red(`Error: Unknown option '${unknownOption}'`));
		console.error(
			chalk.yellow(
				`Run 'task-master ${commandName} --help' to see available options`
			)
		);
		process.exit(1);
	});

	// parse-prd command
	programInstance
		.command('parse-prd')
		.description('Parse a PRD file and generate tasks')
		.argument('[file]', 'Path to the PRD file')
		.option(
			'-i, --input <file>',
			'Path to the PRD file (alternative to positional argument)'
		)
		.option('-o, --output <file>', 'Output file path', 'tasks/tasks.json')
		.option('-n, --num-tasks <number>', 'Number of tasks to generate', '10')
		.option('-f, --force', 'Skip confirmation when overwriting existing tasks')
		.option(
			'--append',
			'Append new tasks to existing tasks.json instead of overwriting'
		)
		.option(
			'-r, --research',
			'Use Perplexity AI for research-backed task generation, providing more comprehensive and accurate task breakdown'
		)
		.action(async (file, options) => {
			// Use input option if file argument not provided
			const inputFile = file || options.input;
			const defaultPrdPath = 'scripts/prd.txt';
			const numTasks = parseInt(options.numTasks, 10);
			const outputPath = options.output;
			const force = options.force || false;
			const append = options.append || false;
			const research = options.research || false;
			let useForce = force;
			let useAppend = append;

			// Helper function to check if tasks.json exists and confirm overwrite
			async function confirmOverwriteIfNeeded() {
				if (fs.existsSync(outputPath) && !useForce && !useAppend) {
					const overwrite = await confirmTaskOverwrite(outputPath);
					if (!overwrite) {
						log('info', 'Operation cancelled.');
						return false;
					}
					// If user confirms 'y', we should set useForce = true for the parsePRD call
					// Only overwrite if not appending
					useForce = true;
				}
				return true;
			}

			let spinner;

			try {
				if (!inputFile) {
					if (fs.existsSync(defaultPrdPath)) {
						console.log(
							chalk.blue(`Using default PRD file path: ${defaultPrdPath}`)
						);
						if (!(await confirmOverwriteIfNeeded())) return;

						console.log(chalk.blue(`Generating ${numTasks} tasks...`));
						spinner = ora('Parsing PRD and generating tasks...\n').start();
						await parsePRD(defaultPrdPath, outputPath, numTasks, {
							append: useAppend, // Changed key from useAppend to append
							force: useForce, // Changed key from useForce to force
							research: research
						});
						spinner.succeed('Tasks generated successfully!');
						return;
					}

					console.log(
						chalk.yellow(
							'No PRD file specified and default PRD file not found at scripts/prd.txt.'
						)
					);
					console.log(
						boxen(
							chalk.white.bold('Parse PRD Help') +
								'\n\n' +
								chalk.cyan('Usage:') +
								'\n' +
								`  task-master parse-prd <prd-file.txt> [options]\n\n` +
								chalk.cyan('Options:') +
								'\n' +
								'  -i, --input <file>       Path to the PRD file (alternative to positional argument)\n' +
								'  -o, --output <file>      Output file path (default: "tasks/tasks.json")\n' +
								'  -n, --num-tasks <number> Number of tasks to generate (default: 10)\n' +
								'  -f, --force              Skip confirmation when overwriting existing tasks\n' +
								'  --append                 Append new tasks to existing tasks.json instead of overwriting\n' +
								'  -r, --research           Use Perplexity AI for research-backed task generation\n\n' +
								chalk.cyan('Example:') +
								'\n' +
								'  task-master parse-prd requirements.txt --num-tasks 15\n' +
								'  task-master parse-prd --input=requirements.txt\n' +
								'  task-master parse-prd --force\n' +
								'  task-master parse-prd requirements_v2.txt --append\n' +
								'  task-master parse-prd requirements.txt --research\n\n' +
								chalk.yellow('Note: This command will:') +
								'\n' +
								'  1. Look for a PRD file at scripts/prd.txt by default\n' +
								'  2. Use the file specified by --input or positional argument if provided\n' +
								'  3. Generate tasks from the PRD and either:\n' +
								'     - Overwrite any existing tasks.json file (default)\n' +
								'     - Append to existing tasks.json if --append is used',
							{ padding: 1, borderColor: 'blue', borderStyle: 'round' }
						)
					);
					return;
				}

				if (!fs.existsSync(inputFile)) {
					console.error(
						chalk.red(`Error: Input PRD file not found: ${inputFile}`)
					);
					process.exit(1);
				}

				if (!(await confirmOverwriteIfNeeded())) return;

				console.log(chalk.blue(`Parsing PRD file: ${inputFile}`));
				console.log(chalk.blue(`Generating ${numTasks} tasks...`));
				if (append) {
					console.log(chalk.blue('Appending to existing tasks...'));
				}
				if (research) {
					console.log(
						chalk.blue(
							'Using Perplexity AI for research-backed task generation'
						)
					);
				}

				spinner = ora('Parsing PRD and generating tasks...\n').start();
				await parsePRD(inputFile, outputPath, numTasks, {
					append: useAppend,
					force: useForce,
					research: research
				});
				spinner.succeed('Tasks generated successfully!');
			} catch (error) {
				if (spinner) {
					spinner.fail(`Error parsing PRD: ${error.message}`);
				} else {
					console.error(chalk.red(`Error parsing PRD: ${error.message}`));
				}
				process.exit(1);
			}
		});

	// update command
	programInstance
		.command('update')
		.description(
			'Update multiple tasks with ID >= "from" based on new information or implementation changes'
		)
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option(
			'--from <id>',
			'Task ID to start updating from (tasks with ID >= this value will be updated)',
			'1'
		)
		.option(
			'-p, --prompt <text>',
			'Prompt explaining the changes or new context (required)'
		)
		.option(
			'-r, --research',
			'Use Perplexity AI for research-backed task updates'
		)
		.action(async (options) => {
			const tasksPath = options.file;
			const fromId = parseInt(options.from, 10); // Validation happens here
			const prompt = options.prompt;
			const useResearch = options.research || false;

			// Check if there's an 'id' option which is a common mistake (instead of 'from')
			if (
				process.argv.includes('--id') ||
				process.argv.some((arg) => arg.startsWith('--id='))
			) {
				console.error(
					chalk.red('Error: The update command uses --from=<id>, not --id=<id>')
				);
				console.log(chalk.yellow('\nTo update multiple tasks:'));
				console.log(
					`  task-master update --from=${fromId} --prompt="Your prompt here"`
				);
				console.log(
					chalk.yellow(
						'\nTo update a single specific task, use the update-task command instead:'
					)
				);
				console.log(
					`  task-master update-task --id=<id> --prompt="Your prompt here"`
				);
				process.exit(1);
			}

			if (!prompt) {
				console.error(
					chalk.red(
						'Error: --prompt parameter is required. Please provide information about the changes.'
					)
				);
				process.exit(1);
			}

			console.log(
				chalk.blue(
					`Updating tasks from ID >= ${fromId} with prompt: "${prompt}"`
				)
			);
			console.log(chalk.blue(`Tasks file: ${tasksPath}`));

			if (useResearch) {
				console.log(
					chalk.blue('Using Perplexity AI for research-backed task updates')
				);
			}

			// Call core updateTasks, passing empty context for CLI
			await updateTasks(
				tasksPath,
				fromId,
				prompt,
				useResearch,
				{} // Pass empty context
			);
		});

	// update-task command
	programInstance
		.command('update-task')
		.description(
			'Update a single specific task by ID with new information (use --id parameter)'
		)
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option('-i, --id <id>', 'Task ID to update (required)')
		.option(
			'-p, --prompt <text>',
			'Prompt explaining the changes or new context (required)'
		)
		.option(
			'-r, --research',
			'Use Perplexity AI for research-backed task updates'
		)
		.action(async (options) => {
			try {
				const tasksPath = options.file;

				// Validate required parameters
				if (!options.id) {
					console.error(chalk.red('Error: --id parameter is required'));
					console.log(
						chalk.yellow(
							'Usage example: task-master update-task --id=23 --prompt="Update with new information"'
						)
					);
					process.exit(1);
				}

				// Parse the task ID and validate it's a number
				const taskId = parseInt(options.id, 10);
				if (isNaN(taskId) || taskId <= 0) {
					console.error(
						chalk.red(
							`Error: Invalid task ID: ${options.id}. Task ID must be a positive integer.`
						)
					);
					console.log(
						chalk.yellow(
							'Usage example: task-master update-task --id=23 --prompt="Update with new information"'
						)
					);
					process.exit(1);
				}

				if (!options.prompt) {
					console.error(
						chalk.red(
							'Error: --prompt parameter is required. Please provide information about the changes.'
						)
					);
					console.log(
						chalk.yellow(
							'Usage example: task-master update-task --id=23 --prompt="Update with new information"'
						)
					);
					process.exit(1);
				}

				const prompt = options.prompt;
				const useResearch = options.research || false;

				// Validate tasks file exists
				if (!fs.existsSync(tasksPath)) {
					console.error(
						chalk.red(`Error: Tasks file not found at path: ${tasksPath}`)
					);
					if (tasksPath === 'tasks/tasks.json') {
						console.log(
							chalk.yellow(
								'Hint: Run task-master init or task-master parse-prd to create tasks.json first'
							)
						);
					} else {
						console.log(
							chalk.yellow(
								`Hint: Check if the file path is correct: ${tasksPath}`
							)
						);
					}
					process.exit(1);
				}

				console.log(
					chalk.blue(`Updating task ${taskId} with prompt: "${prompt}"`)
				);
				console.log(chalk.blue(`Tasks file: ${tasksPath}`));

				if (useResearch) {
					// Verify Perplexity API key exists if using research
					if (!isApiKeySet('perplexity')) {
						console.log(
							chalk.yellow(
								'Warning: PERPLEXITY_API_KEY environment variable is missing. Research-backed updates will not be available.'
							)
						);
						console.log(
							chalk.yellow('Falling back to Claude AI for task update.')
						);
					} else {
						console.log(
							chalk.blue('Using Perplexity AI for research-backed task update')
						);
					}
				}

				const result = await updateTaskById(
					tasksPath,
					taskId,
					prompt,
					useResearch
				);

				// If the task wasn't updated (e.g., if it was already marked as done)
				if (!result) {
					console.log(
						chalk.yellow(
							'\nTask update was not completed. Review the messages above for details.'
						)
					);
				}
			} catch (error) {
				console.error(chalk.red(`Error: ${error.message}`));

				// Provide more helpful error messages for common issues
				if (
					error.message.includes('task') &&
					error.message.includes('not found')
				) {
					console.log(chalk.yellow('\nTo fix this issue:'));
					console.log(
						'  1. Run task-master list to see all available task IDs'
					);
					console.log('  2. Use a valid task ID with the --id parameter');
				} else if (error.message.includes('API key')) {
					console.log(
						chalk.yellow(
							'\nThis error is related to API keys. Check your environment variables.'
						)
					);
				}

				// Use getDebugFlag getter instead of CONFIG.debug
				if (getDebugFlag()) {
					console.error(error);
				}

				process.exit(1);
			}
		});

	// update-subtask command
	programInstance
		.command('update-subtask')
		.description(
			'Update a subtask by appending additional timestamped information'
		)
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option(
			'-i, --id <id>',
			'Subtask ID to update in format "parentId.subtaskId" (required)'
		)
		.option(
			'-p, --prompt <text>',
			'Prompt explaining what information to add (required)'
		)
		.option('-r, --research', 'Use Perplexity AI for research-backed updates')
		.action(async (options) => {
			try {
				const tasksPath = options.file;

				// Validate required parameters
				if (!options.id) {
					console.error(chalk.red('Error: --id parameter is required'));
					console.log(
						chalk.yellow(
							'Usage example: task-master update-subtask --id=5.2 --prompt="Add more details about the API endpoint"'
						)
					);
					process.exit(1);
				}

				// Validate subtask ID format (should contain a dot)
				const subtaskId = options.id;
				if (!subtaskId.includes('.')) {
					console.error(
						chalk.red(
							`Error: Invalid subtask ID format: ${subtaskId}. Subtask ID must be in format "parentId.subtaskId"`
						)
					);
					console.log(
						chalk.yellow(
							'Usage example: task-master update-subtask --id=5.2 --prompt="Add more details about the API endpoint"'
						)
					);
					process.exit(1);
				}

				if (!options.prompt) {
					console.error(
						chalk.red(
							'Error: --prompt parameter is required. Please provide information to add to the subtask.'
						)
					);
					console.log(
						chalk.yellow(
							'Usage example: task-master update-subtask --id=5.2 --prompt="Add more details about the API endpoint"'
						)
					);
					process.exit(1);
				}

				const prompt = options.prompt;
				const useResearch = options.research || false;

				// Validate tasks file exists
				if (!fs.existsSync(tasksPath)) {
					console.error(
						chalk.red(`Error: Tasks file not found at path: ${tasksPath}`)
					);
					if (tasksPath === 'tasks/tasks.json') {
						console.log(
							chalk.yellow(
								'Hint: Run task-master init or task-master parse-prd to create tasks.json first'
							)
						);
					} else {
						console.log(
							chalk.yellow(
								`Hint: Check if the file path is correct: ${tasksPath}`
							)
						);
					}
					process.exit(1);
				}

				console.log(
					chalk.blue(`Updating subtask ${subtaskId} with prompt: "${prompt}"`)
				);
				console.log(chalk.blue(`Tasks file: ${tasksPath}`));

				if (useResearch) {
					// Verify Perplexity API key exists if using research
					if (!isApiKeySet('perplexity')) {
						console.log(
							chalk.yellow(
								'Warning: PERPLEXITY_API_KEY environment variable is missing. Research-backed updates will not be available.'
							)
						);
						console.log(
							chalk.yellow('Falling back to Claude AI for subtask update.')
						);
					} else {
						console.log(
							chalk.blue(
								'Using Perplexity AI for research-backed subtask update'
							)
						);
					}
				}

				const result = await updateSubtaskById(
					tasksPath,
					subtaskId,
					prompt,
					useResearch
				);

				if (!result) {
					console.log(
						chalk.yellow(
							'\nSubtask update was not completed. Review the messages above for details.'
						)
					);
				}
			} catch (error) {
				console.error(chalk.red(`Error: ${error.message}`));

				// Provide more helpful error messages for common issues
				if (
					error.message.includes('subtask') &&
					error.message.includes('not found')
				) {
					console.log(chalk.yellow('\nTo fix this issue:'));
					console.log(
						'  1. Run task-master list --with-subtasks to see all available subtask IDs'
					);
					console.log(
						'  2. Use a valid subtask ID with the --id parameter in format "parentId.subtaskId"'
					);
				} else if (error.message.includes('API key')) {
					console.log(
						chalk.yellow(
							'\nThis error is related to API keys. Check your environment variables.'
						)
					);
				}

				// Use getDebugFlag getter instead of CONFIG.debug
				if (getDebugFlag()) {
					console.error(error);
				}

				process.exit(1);
			}
		});

	// generate command
	programInstance
		.command('generate')
		.description('Generate task files from tasks.json')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option('-o, --output <dir>', 'Output directory', 'tasks')
		.action(async (options) => {
			const tasksPath = options.file;
			const outputDir = options.output;

			console.log(chalk.blue(`Generating task files from: ${tasksPath}`));
			console.log(chalk.blue(`Output directory: ${outputDir}`));

			await generateTaskFiles(tasksPath, outputDir);
		});

	// set-status command
	programInstance
		.command('set-status')
		.alias('mark')
		.alias('set')
		.description('Set the status of a task')
		.option(
			'-i, --id <id>',
			'Task ID (can be comma-separated for multiple tasks)'
		)
		.option(
			'-s, --status <status>',
			`New status (one of: ${TASK_STATUS_OPTIONS.join(', ')})`
		)
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.action(async (options) => {
			const tasksPath = options.file;
			const taskId = options.id;
			const status = options.status;

			if (!taskId || !status) {
				console.error(chalk.red('Error: Both --id and --status are required'));
				process.exit(1);
			}

			if (!isValidTaskStatus(status)) {
				console.error(
					chalk.red(
						`Error: Invalid status value: ${status}. Use one of: ${TASK_STATUS_OPTIONS.join(', ')}`
					)
				);

				process.exit(1);
			}

			console.log(
				chalk.blue(`Setting status of task(s) ${taskId} to: ${status}`)
			);

			await setTaskStatus(tasksPath, taskId, status);
		});

	// list command
	programInstance
		.command('list')
		.description('List all tasks')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option(
			'-r, --report <report>',
			'Path to the complexity report file',
			'scripts/task-complexity-report.json'
		)
		.option('-s, --status <status>', 'Filter by status')
		.option('--with-subtasks', 'Show subtasks for each task')
		.action(async (options) => {
			const tasksPath = options.file;
			const reportPath = options.report;
			const statusFilter = options.status;
			const withSubtasks = options.withSubtasks || false;

			console.log(chalk.blue(`Listing tasks from: ${tasksPath}`));
			if (statusFilter) {
				console.log(chalk.blue(`Filtering by status: ${statusFilter}`));
			}
			if (withSubtasks) {
				console.log(chalk.blue('Including subtasks in listing'));
			}

			await listTasks(tasksPath, statusFilter, reportPath, withSubtasks);
		});

	// expand command
	programInstance
		.command('expand')
		.description('Expand a task into subtasks using AI')
		.option('-i, --id <id>', 'ID of the task to expand')
		.option(
			'-a, --all',
			'Expand all pending tasks based on complexity analysis'
		)
		.option(
			'-n, --num <number>',
			'Number of subtasks to generate (uses complexity analysis by default if available)'
		)
		.option(
			'-r, --research',
			'Enable research-backed generation (e.g., using Perplexity)',
			false
		)
		.option('-p, --prompt <text>', 'Additional context for subtask generation')
		.option('-f, --force', 'Force expansion even if subtasks exist', false) // Ensure force option exists
		.option(
			'--file <file>',
			'Path to the tasks file (relative to project root)',
			'tasks/tasks.json'
		) // Allow file override
		.action(async (options) => {
			const projectRoot = findProjectRoot();
			if (!projectRoot) {
				console.error(chalk.red('Error: Could not find project root.'));
				process.exit(1);
			}
			const tasksPath = path.resolve(projectRoot, options.file); // Resolve tasks path

			if (options.all) {
				// --- Handle expand --all ---
				console.log(chalk.blue('Expanding all pending tasks...'));
				// Updated call to the refactored expandAllTasks
				try {
					const result = await expandAllTasks(
						tasksPath,
						options.num, // Pass num
						options.research, // Pass research flag
						options.prompt, // Pass additional context
						options.force, // Pass force flag
						{} // Pass empty context for CLI calls
						// outputFormat defaults to 'text' in expandAllTasks for CLI
					);
				} catch (error) {
					console.error(
						chalk.red(`Error expanding all tasks: ${error.message}`)
					);
					process.exit(1);
				}
			} else if (options.id) {
				// --- Handle expand --id <id> (Should be correct from previous refactor) ---
				if (!options.id) {
					console.error(
						chalk.red('Error: Task ID is required unless using --all.')
					);
					process.exit(1);
				}

				console.log(chalk.blue(`Expanding task ${options.id}...`));
				try {
					// Call the refactored expandTask function
					await expandTask(
						tasksPath,
						options.id,
						options.num,
						options.research,
						options.prompt,
						{}, // Pass empty context for CLI calls
						options.force // Pass the force flag down
					);
					// expandTask logs its own success/failure for single task
				} catch (error) {
					console.error(
						chalk.red(`Error expanding task ${options.id}: ${error.message}`)
					);
					process.exit(1);
				}
			} else {
				console.error(
					chalk.red('Error: You must specify either a task ID (--id) or --all.')
				);
				programInstance.help(); // Show help
			}
		});

	// analyze-complexity command
	programInstance
		.command('analyze-complexity')
		.description(
			`Analyze tasks and generate expansion recommendations${chalk.reset('')}`
		)
		.option(
			'-o, --output <file>',
			'Output file path for the report',
			'scripts/task-complexity-report.json'
		)
		.option(
			'-m, --model <model>',
			'LLM model to use for analysis (defaults to configured model)'
		)
		.option(
			'-t, --threshold <number>',
			'Minimum complexity score to recommend expansion (1-10)',
			'5'
		)
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option(
			'-r, --research',
			'Use Perplexity AI for research-backed complexity analysis'
		)
		.option(
			'-i, --id <ids>',
			'Comma-separated list of specific task IDs to analyze (e.g., "1,3,5")'
		)
		.option('--from <id>', 'Starting task ID in a range to analyze')
		.option('--to <id>', 'Ending task ID in a range to analyze')
		.action(async (options) => {
			const tasksPath = options.file || 'tasks/tasks.json';
			const outputPath = options.output;
			const modelOverride = options.model;
			const thresholdScore = parseFloat(options.threshold);
			const useResearch = options.research || false;

			console.log(chalk.blue(`Analyzing task complexity from: ${tasksPath}`));
			console.log(chalk.blue(`Output report will be saved to: ${outputPath}`));

			if (options.id) {
				console.log(chalk.blue(`Analyzing specific task IDs: ${options.id}`));
			} else if (options.from || options.to) {
				const fromStr = options.from ? options.from : 'first';
				const toStr = options.to ? options.to : 'last';
				console.log(
					chalk.blue(`Analyzing tasks in range: ${fromStr} to ${toStr}`)
				);
			}

			if (useResearch) {
				console.log(
					chalk.blue(
						'Using Perplexity AI for research-backed complexity analysis'
					)
				);
			}

			await analyzeTaskComplexity(options);
		});

	// clear-subtasks command
	programInstance
		.command('clear-subtasks')
		.description('Clear subtasks from specified tasks')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option(
			'-i, --id <ids>',
			'Task IDs (comma-separated) to clear subtasks from'
		)
		.option('--all', 'Clear subtasks from all tasks')
		.action(async (options) => {
			const tasksPath = options.file;
			const taskIds = options.id;
			const all = options.all;

			if (!taskIds && !all) {
				console.error(
					chalk.red(
						'Error: Please specify task IDs with --id=<ids> or use --all to clear all tasks'
					)
				);
				process.exit(1);
			}

			if (all) {
				// If --all is specified, get all task IDs
				const data = readJSON(tasksPath);
				if (!data || !data.tasks) {
					console.error(chalk.red('Error: No valid tasks found'));
					process.exit(1);
				}
				const allIds = data.tasks.map((t) => t.id).join(',');
				clearSubtasks(tasksPath, allIds);
			} else {
				clearSubtasks(tasksPath, taskIds);
			}
		});

	// add-task command
	programInstance
		.command('add-task')
		.description('Add a new task using AI, optionally providing manual details')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option(
			'-p, --prompt <prompt>',
			'Description of the task to add (required if not using manual fields)'
		)
		.option('-t, --title <title>', 'Task title (for manual task creation)')
		.option(
			'-d, --description <description>',
			'Task description (for manual task creation)'
		)
		.option(
			'--details <details>',
			'Implementation details (for manual task creation)'
		)
		.option(
			'--dependencies <dependencies>',
			'Comma-separated list of task IDs this task depends on'
		)
		.option(
			'--priority <priority>',
			'Task priority (high, medium, low)',
			'medium'
		)
		.option(
			'-r, --research',
			'Whether to use research capabilities for task creation'
		)
		.action(async (options) => {
			const isManualCreation = options.title && options.description;

			// Validate that either prompt or title+description are provided
			if (!options.prompt && !isManualCreation) {
				console.error(
					chalk.red(
						'Error: Either --prompt or both --title and --description must be provided'
					)
				);
				process.exit(1);
			}

			const tasksPath =
				options.file ||
				path.join(findProjectRoot() || '.', 'tasks', 'tasks.json') || // Ensure tasksPath is also relative to a found root or current dir
				'tasks/tasks.json';

			// Correctly determine projectRoot
			const projectRoot = findProjectRoot();

			let manualTaskData = null;
			if (isManualCreation) {
				manualTaskData = {
					title: options.title,
					description: options.description,
					details: options.details || '',
					testStrategy: options.testStrategy || ''
				};
				// Restore specific logging for manual creation
				console.log(
					chalk.blue(`Creating task manually with title: "${options.title}"`)
				);
			} else {
				// Restore specific logging for AI creation
				console.log(
					chalk.blue(`Creating task with AI using prompt: "${options.prompt}"`)
				);
			}

			// Log dependencies and priority if provided (restored)
			const dependenciesArray = options.dependencies
				? options.dependencies.split(',').map((id) => id.trim())
				: [];
			if (dependenciesArray.length > 0) {
				console.log(
					chalk.blue(`Dependencies: [${dependenciesArray.join(', ')}]`)
				);
			}
			if (options.priority) {
				console.log(chalk.blue(`Priority: ${options.priority}`));
			}

			const context = {
				projectRoot,
				commandName: 'add-task',
				outputType: 'cli'
			};

			try {
				const { newTaskId, telemetryData } = await addTask(
					tasksPath,
					options.prompt,
					dependenciesArray,
					options.priority,
					context,
					'text',
					manualTaskData,
					options.research
				);

				// addTask handles detailed CLI success logging AND telemetry display when outputFormat is 'text'
				// No need to call displayAiUsageSummary here anymore.
			} catch (error) {
				console.error(chalk.red(`Error adding task: ${error.message}`));
				if (error.details) {
					console.error(chalk.red(error.details));
				}
				process.exit(1);
			}
		});

	// next command
	programInstance
		.command('next')
		.description(
			`Show the next task to work on based on dependencies and status${chalk.reset('')}`
		)
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option(
			'-r, --report <report>',
			'Path to the complexity report file',
			'scripts/task-complexity-report.json'
		)
		.action(async (options) => {
			const tasksPath = options.file;
			const reportPath = options.report;
			await displayNextTask(tasksPath, reportPath);
		});

	// show command
	programInstance
		.command('show')
		.description(
			`Display detailed information about a specific task${chalk.reset('')}`
		)
		.argument('[id]', 'Task ID to show')
		.option('-i, --id <id>', 'Task ID to show')
		.option('-s, --status <status>', 'Filter subtasks by status') // ADDED status option
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option(
			'-r, --report <report>',
			'Path to the complexity report file',
			'scripts/task-complexity-report.json'
		)
		.action(async (taskId, options) => {
			const idArg = taskId || options.id;
			const statusFilter = options.status; // ADDED: Capture status filter

			if (!idArg) {
				console.error(chalk.red('Error: Please provide a task ID'));
				process.exit(1);
			}

			const tasksPath = options.file;
			const reportPath = options.report;
			// PASS statusFilter to the display function
			await displayTaskById(tasksPath, idArg, reportPath, statusFilter);
		});

	// add-dependency command
	programInstance
		.command('add-dependency')
		.description('Add a dependency to a task')
		.option('-i, --id <id>', 'Task ID to add dependency to')
		.option('-d, --depends-on <id>', 'Task ID that will become a dependency')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.action(async (options) => {
			const tasksPath = options.file;
			const taskId = options.id;
			const dependencyId = options.dependsOn;

			if (!taskId || !dependencyId) {
				console.error(
					chalk.red('Error: Both --id and --depends-on are required')
				);
				process.exit(1);
			}

			// Handle subtask IDs correctly by preserving the string format for IDs containing dots
			// Only use parseInt for simple numeric IDs
			const formattedTaskId = taskId.includes('.')
				? taskId
				: parseInt(taskId, 10);
			const formattedDependencyId = dependencyId.includes('.')
				? dependencyId
				: parseInt(dependencyId, 10);

			await addDependency(tasksPath, formattedTaskId, formattedDependencyId);
		});

	// remove-dependency command
	programInstance
		.command('remove-dependency')
		.description('Remove a dependency from a task')
		.option('-i, --id <id>', 'Task ID to remove dependency from')
		.option('-d, --depends-on <id>', 'Task ID to remove as a dependency')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.action(async (options) => {
			const tasksPath = options.file;
			const taskId = options.id;
			const dependencyId = options.dependsOn;

			if (!taskId || !dependencyId) {
				console.error(
					chalk.red('Error: Both --id and --depends-on are required')
				);
				process.exit(1);
			}

			// Handle subtask IDs correctly by preserving the string format for IDs containing dots
			// Only use parseInt for simple numeric IDs
			const formattedTaskId = taskId.includes('.')
				? taskId
				: parseInt(taskId, 10);
			const formattedDependencyId = dependencyId.includes('.')
				? dependencyId
				: parseInt(dependencyId, 10);

			await removeDependency(tasksPath, formattedTaskId, formattedDependencyId);
		});

	// validate-dependencies command
	programInstance
		.command('validate-dependencies')
		.description(
			`Identify invalid dependencies without fixing them${chalk.reset('')}`
		)
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.action(async (options) => {
			await validateDependenciesCommand(options.file);
		});

	// fix-dependencies command
	programInstance
		.command('fix-dependencies')
		.description(`Fix invalid dependencies automatically${chalk.reset('')}`)
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.action(async (options) => {
			await fixDependenciesCommand(options.file);
		});

	// complexity-report command
	programInstance
		.command('complexity-report')
		.description(`Display the complexity analysis report${chalk.reset('')}`)
		.option(
			'-f, --file <file>',
			'Path to the report file',
			'scripts/task-complexity-report.json'
		)
		.action(async (options) => {
			await displayComplexityReport(options.file);
		});

	// add-subtask command
	programInstance
		.command('add-subtask')
		.description('Add a subtask to an existing task')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option('-p, --parent <id>', 'Parent task ID (required)')
		.option('-i, --task-id <id>', 'Existing task ID to convert to subtask')
		.option(
			'-t, --title <title>',
			'Title for the new subtask (when creating a new subtask)'
		)
		.option('-d, --description <text>', 'Description for the new subtask')
		.option('--details <text>', 'Implementation details for the new subtask')
		.option(
			'--dependencies <ids>',
			'Comma-separated list of dependency IDs for the new subtask'
		)
		.option('-s, --status <status>', 'Status for the new subtask', 'pending')
		.option('--skip-generate', 'Skip regenerating task files')
		.action(async (options) => {
			const tasksPath = options.file;
			const parentId = options.parent;
			const existingTaskId = options.taskId;
			const generateFiles = !options.skipGenerate;

			if (!parentId) {
				console.error(
					chalk.red(
						'Error: --parent parameter is required. Please provide a parent task ID.'
					)
				);
				showAddSubtaskHelp();
				process.exit(1);
			}

			// Parse dependencies if provided
			let dependencies = [];
			if (options.dependencies) {
				dependencies = options.dependencies.split(',').map((id) => {
					// Handle both regular IDs and dot notation
					return id.includes('.') ? id.trim() : parseInt(id.trim(), 10);
				});
			}

			try {
				if (existingTaskId) {
					// Convert existing task to subtask
					console.log(
						chalk.blue(
							`Converting task ${existingTaskId} to a subtask of ${parentId}...`
						)
					);
					await addSubtask(
						tasksPath,
						parentId,
						existingTaskId,
						null,
						generateFiles
					);
					console.log(
						chalk.green(
							`✓ Task ${existingTaskId} successfully converted to a subtask of task ${parentId}`
						)
					);
				} else if (options.title) {
					// Create new subtask with provided data
					console.log(
						chalk.blue(`Creating new subtask for parent task ${parentId}...`)
					);

					const newSubtaskData = {
						title: options.title,
						description: options.description || '',
						details: options.details || '',
						status: options.status || 'pending',
						dependencies: dependencies
					};

					const subtask = await addSubtask(
						tasksPath,
						parentId,
						null,
						newSubtaskData,
						generateFiles
					);
					console.log(
						chalk.green(
							`✓ New subtask ${parentId}.${subtask.id} successfully created`
						)
					);

					// Display success message and suggested next steps
					console.log(
						boxen(
							chalk.white.bold(
								`Subtask ${parentId}.${subtask.id} Added Successfully`
							) +
								'\n\n' +
								chalk.white(`Title: ${subtask.title}`) +
								'\n' +
								chalk.white(`Status: ${getStatusWithColor(subtask.status)}`) +
								'\n' +
								(dependencies.length > 0
									? chalk.white(`Dependencies: ${dependencies.join(', ')}`) +
										'\n'
									: '') +
								'\n' +
								chalk.white.bold('Next Steps:') +
								'\n' +
								chalk.cyan(
									`1. Run ${chalk.yellow(`task-master show ${parentId}`)} to see the parent task with all subtasks`
								) +
								'\n' +
								chalk.cyan(
									`2. Run ${chalk.yellow(`task-master set-status --id=${parentId}.${subtask.id} --status=in-progress`)} to start working on it`
								),
							{
								padding: 1,
								borderColor: 'green',
								borderStyle: 'round',
								margin: { top: 1 }
							}
						)
					);
				} else {
					console.error(
						chalk.red('Error: Either --task-id or --title must be provided.')
					);
					console.log(
						boxen(
							chalk.white.bold('Usage Examples:') +
								'\n\n' +
								chalk.white('Convert existing task to subtask:') +
								'\n' +
								chalk.yellow(
									`  task-master add-subtask --parent=5 --task-id=8`
								) +
								'\n\n' +
								chalk.white('Create new subtask:') +
								'\n' +
								chalk.yellow(
									`  task-master add-subtask --parent=5 --title="Implement login UI" --description="Create the login form"`
								) +
								'\n\n',
							{ padding: 1, borderColor: 'blue', borderStyle: 'round' }
						)
					);
					process.exit(1);
				}
			} catch (error) {
				console.error(chalk.red(`Error: ${error.message}`));
				showAddSubtaskHelp();
				process.exit(1);
			}
		})
		.on('error', function (err) {
			console.error(chalk.red(`Error: ${err.message}`));
			showAddSubtaskHelp();
			process.exit(1);
		});

	// Helper function to show add-subtask command help
	function showAddSubtaskHelp() {
		console.log(
			boxen(
				chalk.white.bold('Add Subtask Command Help') +
					'\n\n' +
					chalk.cyan('Usage:') +
					'\n' +
					`  task-master add-subtask --parent=<id> [options]\n\n` +
					chalk.cyan('Options:') +
					'\n' +
					'  -p, --parent <id>         Parent task ID (required)\n' +
					'  -i, --task-id <id>        Existing task ID to convert to subtask\n' +
					'  -t, --title <title>       Title for the new subtask\n' +
					'  -d, --description <text>  Description for the new subtask\n' +
					'  --details <text>          Implementation details for the new subtask\n' +
					'  --dependencies <ids>      Comma-separated list of dependency IDs\n' +
					'  -s, --status <status>     Status for the new subtask (default: "pending")\n' +
					'  -f, --file <file>         Path to the tasks file (default: "tasks/tasks.json")\n' +
					'  --skip-generate           Skip regenerating task files\n\n' +
					chalk.cyan('Examples:') +
					'\n' +
					'  task-master add-subtask --parent=5 --task-id=8\n' +
					'  task-master add-subtask -p 5 -t "Implement login UI" -d "Create the login form"',
				{ padding: 1, borderColor: 'blue', borderStyle: 'round' }
			)
		);
	}

	// remove-subtask command
	programInstance
		.command('remove-subtask')
		.description('Remove a subtask from its parent task')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option(
			'-i, --id <id>',
			'Subtask ID(s) to remove in format "parentId.subtaskId" (can be comma-separated for multiple subtasks)'
		)
		.option(
			'-c, --convert',
			'Convert the subtask to a standalone task instead of deleting it'
		)
		.option('--skip-generate', 'Skip regenerating task files')
		.action(async (options) => {
			const tasksPath = options.file;
			const subtaskIds = options.id;
			const convertToTask = options.convert || false;
			const generateFiles = !options.skipGenerate;

			if (!subtaskIds) {
				console.error(
					chalk.red(
						'Error: --id parameter is required. Please provide subtask ID(s) in format "parentId.subtaskId".'
					)
				);
				showRemoveSubtaskHelp();
				process.exit(1);
			}

			try {
				// Split by comma to support multiple subtask IDs
				const subtaskIdArray = subtaskIds.split(',').map((id) => id.trim());

				for (const subtaskId of subtaskIdArray) {
					// Validate subtask ID format
					if (!subtaskId.includes('.')) {
						console.error(
							chalk.red(
								`Error: Subtask ID "${subtaskId}" must be in format "parentId.subtaskId"`
							)
						);
						showRemoveSubtaskHelp();
						process.exit(1);
					}

					console.log(chalk.blue(`Removing subtask ${subtaskId}...`));
					if (convertToTask) {
						console.log(
							chalk.blue('The subtask will be converted to a standalone task')
						);
					}

					const result = await removeSubtask(
						tasksPath,
						subtaskId,
						convertToTask,
						generateFiles
					);

					if (convertToTask && result) {
						// Display success message and next steps for converted task
						console.log(
							boxen(
								chalk.white.bold(
									`Subtask ${subtaskId} Converted to Task #${result.id}`
								) +
									'\n\n' +
									chalk.white(`Title: ${result.title}`) +
									'\n' +
									chalk.white(`Status: ${getStatusWithColor(result.status)}`) +
									'\n' +
									chalk.white(
										`Dependencies: ${result.dependencies.join(', ')}`
									) +
									'\n\n' +
									chalk.white.bold('Next Steps:') +
									'\n' +
									chalk.cyan(
										`1. Run ${chalk.yellow(`task-master show ${result.id}`)} to see details of the new task`
									) +
									'\n' +
									chalk.cyan(
										`2. Run ${chalk.yellow(`task-master set-status --id=${result.id} --status=in-progress`)} to start working on it`
									),
								{
									padding: 1,
									borderColor: 'green',
									borderStyle: 'round',
									margin: { top: 1 }
								}
							)
						);
					} else {
						// Display success message for deleted subtask
						console.log(
							boxen(
								chalk.white.bold(`Subtask ${subtaskId} Removed`) +
									'\n\n' +
									chalk.white('The subtask has been successfully deleted.'),
								{
									padding: 1,
									borderColor: 'green',
									borderStyle: 'round',
									margin: { top: 1 }
								}
							)
						);
					}
				}
			} catch (error) {
				console.error(chalk.red(`Error: ${error.message}`));
				showRemoveSubtaskHelp();
				process.exit(1);
			}
		})
		.on('error', function (err) {
			console.error(chalk.red(`Error: ${err.message}`));
			showRemoveSubtaskHelp();
			process.exit(1);
		});

	// Helper function to show remove-subtask command help
	function showRemoveSubtaskHelp() {
		console.log(
			boxen(
				chalk.white.bold('Remove Subtask Command Help') +
					'\n\n' +
					chalk.cyan('Usage:') +
					'\n' +
					`  task-master remove-subtask --id=<parentId.subtaskId> [options]\n\n` +
					chalk.cyan('Options:') +
					'\n' +
					'  -i, --id <id>       Subtask ID(s) to remove in format "parentId.subtaskId" (can be comma-separated, required)\n' +
					'  -c, --convert       Convert the subtask to a standalone task instead of deleting it\n' +
					'  -f, --file <file>   Path to the tasks file (default: "tasks/tasks.json")\n' +
					'  --skip-generate     Skip regenerating task files\n\n' +
					chalk.cyan('Examples:') +
					'\n' +
					'  task-master remove-subtask --id=5.2\n' +
					'  task-master remove-subtask --id=5.2,6.3,7.1\n' +
					'  task-master remove-subtask --id=5.2 --convert',
				{ padding: 1, borderColor: 'blue', borderStyle: 'round' }
			)
		);
	}

	// remove-task command
	programInstance
		.command('remove-task')
		.description('Remove one or more tasks or subtasks permanently')
		.description('Remove one or more tasks or subtasks permanently')
		.option(
			'-i, --id <ids>',
			'ID(s) of the task(s) or subtask(s) to remove (e.g., "5", "5.2", or "5,6.1,7")'
		)
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option('-y, --yes', 'Skip confirmation prompt', false)
		.action(async (options) => {
			const tasksPath = options.file;
			const taskIdsString = options.id;

			if (!taskIdsString) {
				console.error(chalk.red('Error: Task ID(s) are required'));
				console.error(
					chalk.yellow(
						'Usage: task-master remove-task --id=<taskId1,taskId2...>'
					)
				);
				process.exit(1);
			}

			const taskIdsToRemove = taskIdsString
				.split(',')
				.map((id) => id.trim())
				.filter(Boolean);

			if (taskIdsToRemove.length === 0) {
				console.error(chalk.red('Error: No valid task IDs provided.'));
				process.exit(1);
			}

			try {
				// Read data once for checks and confirmation
				const data = readJSON(tasksPath);
				if (!data || !data.tasks) {
					console.error(
						chalk.red(`Error: No valid tasks found in ${tasksPath}`)
					);
					process.exit(1);
				}

				const existingTasksToRemove = [];
				const nonExistentIds = [];
				let totalSubtasksToDelete = 0;
				const dependentTaskMessages = [];

				for (const taskId of taskIdsToRemove) {
					if (!taskExists(data.tasks, taskId)) {
						nonExistentIds.push(taskId);
					} else {
						// Correctly extract the task object from the result of findTaskById
						const findResult = findTaskById(data.tasks, taskId);
						const taskObject = findResult.task; // Get the actual task/subtask object

						if (taskObject) {
							existingTasksToRemove.push({ id: taskId, task: taskObject }); // Push the actual task object

							// If it's a main task, count its subtasks and check dependents
							if (!taskObject.isSubtask) {
								// Check the actual task object
								if (taskObject.subtasks && taskObject.subtasks.length > 0) {
									totalSubtasksToDelete += taskObject.subtasks.length;
								}
								const dependentTasks = data.tasks.filter(
									(t) =>
										t.dependencies &&
										t.dependencies.includes(parseInt(taskId, 10))
								);
								if (dependentTasks.length > 0) {
									dependentTaskMessages.push(
										`  - Task ${taskId}: ${dependentTasks.length} dependent tasks (${dependentTasks.map((t) => t.id).join(', ')})`
									);
								}
							}
						} else {
							// Handle case where findTaskById returned null for the task property (should be rare)
							nonExistentIds.push(`${taskId} (error finding details)`);
						}
					}
				}

				if (nonExistentIds.length > 0) {
					console.warn(
						chalk.yellow(
							`Warning: The following task IDs were not found: ${nonExistentIds.join(', ')}`
						)
					);
				}

				if (existingTasksToRemove.length === 0) {
					console.log(chalk.blue('No existing tasks found to remove.'));
					process.exit(0);
				}

				// Skip confirmation if --yes flag is provided
				if (!options.yes) {
					console.log();
					console.log(
						chalk.red.bold(
							`⚠️ WARNING: This will permanently delete the following ${existingTasksToRemove.length} item(s):`
						)
					);
					console.log();

					existingTasksToRemove.forEach(({ id, task }) => {
						if (!task) return; // Should not happen due to taskExists check, but safeguard
						if (task.isSubtask) {
							// Subtask - title is directly on the task object
							console.log(
								chalk.white(`  Subtask ${id}: ${task.title || '(no title)'}`)
							);
							// Optionally show parent context if available
							if (task.parentTask) {
								console.log(
									chalk.gray(
										`    (Parent: ${task.parentTask.id} - ${task.parentTask.title || '(no title)'})`
									)
								);
							}
						} else {
							// Main task - title is directly on the task object
							console.log(
								chalk.white.bold(`  Task ${id}: ${task.title || '(no title)'}`)
							);
						}
					});

					if (totalSubtasksToDelete > 0) {
						console.log(
							chalk.yellow(
								`⚠️ This will also delete ${totalSubtasksToDelete} subtasks associated with the selected main tasks!`
							)
						);
					}

					if (dependentTaskMessages.length > 0) {
						console.log(
							chalk.yellow(
								'⚠️ Warning: Dependencies on the following tasks will be removed:'
							)
						);
						dependentTaskMessages.forEach((msg) =>
							console.log(chalk.yellow(msg))
						);
					}

					console.log();

					const { confirm } = await inquirer.prompt([
						{
							type: 'confirm',
							name: 'confirm',
							message: chalk.red.bold(
								`Are you sure you want to permanently delete these ${existingTasksToRemove.length} item(s)?`
							),
							default: false
						}
					]);

					if (!confirm) {
						console.log(chalk.blue('Task deletion cancelled.'));
						process.exit(0);
					}
				}

				const indicator = startLoadingIndicator(
					`Removing ${existingTasksToRemove.length} task(s)/subtask(s)...`
				);

				// Use the string of existing IDs for the core function
				const existingIdsString = existingTasksToRemove
					.map(({ id }) => id)
					.join(',');
				const result = await removeTask(tasksPath, existingIdsString);

				stopLoadingIndicator(indicator);

				if (result.success) {
					console.log(
						boxen(
							chalk.green(
								`Successfully removed ${result.removedTasks.length} task(s)/subtask(s).`
							) +
								(result.message ? `\n\nDetails:\n${result.message}` : '') +
								(result.error
									? `\n\nWarnings:\n${chalk.yellow(result.error)}`
									: ''),
							{ padding: 1, borderColor: 'green', borderStyle: 'round' }
						)
					);
				} else {
					console.error(
						boxen(
							chalk.red(
								`Operation completed with errors. Removed ${result.removedTasks.length} task(s)/subtask(s).`
							) +
								(result.message ? `\n\nDetails:\n${result.message}` : '') +
								(result.error ? `\n\nErrors:\n${chalk.red(result.error)}` : ''),
							{
								padding: 1,
								borderColor: 'red',
								borderStyle: 'round'
							}
						)
					);
					process.exit(1); // Exit with error code if any part failed
				}

				// Log any initially non-existent IDs again for clarity
				if (nonExistentIds.length > 0) {
					console.warn(
						chalk.yellow(
							`Note: The following IDs were not found initially and were skipped: ${nonExistentIds.join(', ')}`
						)
					);

					// Exit with error if any removals failed
					if (result.removedTasks.length === 0) {
						process.exit(1);
					}
				}
			} catch (error) {
				console.error(
					chalk.red(`Error: ${error.message || 'An unknown error occurred'}`)
				);
				process.exit(1);
			}
		});

	// init command (Directly calls the implementation from init.js)
	programInstance
		.command('init')
		.description('Initialize a new project with Task Master structure')
		.option('-y, --yes', 'Skip prompts and use default values')
		.option('-n, --name <name>', 'Project name')
		.option('-d, --description <description>', 'Project description')
		.option('-v, --version <version>', 'Project version', '0.1.0') // Set default here
		.option('-a, --author <author>', 'Author name')
		.option('--skip-install', 'Skip installing dependencies')
		.option('--dry-run', 'Show what would be done without making changes')
		.option('--aliases', 'Add shell aliases (tm, taskmaster)')
		.action(async (cmdOptions) => {
			// cmdOptions contains parsed arguments
			try {
				console.log('DEBUG: Running init command action in commands.js');
				console.log(
					'DEBUG: Options received by action:',
					JSON.stringify(cmdOptions)
				);
				// Directly call the initializeProject function, passing the parsed options
				await initializeProject(cmdOptions);
				// initializeProject handles its own flow, including potential process.exit()
			} catch (error) {
				console.error(
					chalk.red(`Error during initialization: ${error.message}`)
				);
				process.exit(1);
			}
		});

	// models command
	programInstance
		.command('models')
		.description('Manage AI model configurations')
		.option(
			'--set-main <model_id>',
			'Set the primary model for task generation/updates'
		)
		.option(
			'--set-research <model_id>',
			'Set the model for research-backed operations'
		)
		.option(
			'--set-fallback <model_id>',
			'Set the model to use if the primary fails'
		)
		.option('--setup', 'Run interactive setup to configure models')
		.option(
			'--openrouter',
			'Allow setting a custom OpenRouter model ID (use with --set-*) '
		)
		.option(
			'--ollama',
			'Allow setting a custom Ollama model ID (use with --set-*) '
		)
		.addHelpText(
			'after',
			`
Examples:
  $ task-master models                              # View current configuration
  $ task-master models --set-main gpt-4o             # Set main model (provider inferred)
  $ task-master models --set-research sonar-pro       # Set research model
  $ task-master models --set-fallback claude-3-5-sonnet-20241022 # Set fallback
  $ task-master models --set-main my-custom-model --ollama  # Set custom Ollama model for main role
  $ task-master models --set-main some/other-model --openrouter # Set custom OpenRouter model for main role
  $ task-master models --setup                            # Run interactive setup`
		)
		.action(async (options) => {
			const projectRoot = findProjectRoot(); // Find project root for context

			// Validate flags: cannot use both --openrouter and --ollama simultaneously
			if (options.openrouter && options.ollama) {
				console.error(
					chalk.red(
						'Error: Cannot use both --openrouter and --ollama flags simultaneously.'
					)
				);
				process.exit(1);
			}

			// Determine the primary action based on flags
			const isSetup = options.setup;
			const isSetOperation =
				options.setMain || options.setResearch || options.setFallback;

			// --- Execute Action ---

			if (isSetup) {
				// Action 1: Run Interactive Setup
				console.log(chalk.blue('Starting interactive model setup...')); // Added feedback
				try {
					await runInteractiveSetup(projectRoot);
					// runInteractiveSetup logs its own completion/error messages
				} catch (setupError) {
					console.error(
						chalk.red('\\nInteractive setup failed unexpectedly:'),
						setupError.message
					);
				}
				// --- IMPORTANT: Exit after setup ---
				return; // Stop execution here
			}

			if (isSetOperation) {
				// Action 2: Perform Direct Set Operations
				let updateOccurred = false; // Track if any update actually happened

				if (options.setMain) {
					const result = await setModel('main', options.setMain, {
						projectRoot,
						providerHint: options.openrouter
							? 'openrouter'
							: options.ollama
								? 'ollama'
								: undefined
					});
					if (result.success) {
						console.log(chalk.green(`✅ ${result.data.message}`));
						if (result.data.warning)
							console.log(chalk.yellow(result.data.warning));
						updateOccurred = true;
					} else {
						console.error(
							chalk.red(`❌ Error setting main model: ${result.error.message}`)
						);
					}
				}
				if (options.setResearch) {
					const result = await setModel('research', options.setResearch, {
						projectRoot,
						providerHint: options.openrouter
							? 'openrouter'
							: options.ollama
								? 'ollama'
								: undefined
					});
					if (result.success) {
						console.log(chalk.green(`✅ ${result.data.message}`));
						if (result.data.warning)
							console.log(chalk.yellow(result.data.warning));
						updateOccurred = true;
					} else {
						console.error(
							chalk.red(
								`❌ Error setting research model: ${result.error.message}`
							)
						);
					}
				}
				if (options.setFallback) {
					const result = await setModel('fallback', options.setFallback, {
						projectRoot,
						providerHint: options.openrouter
							? 'openrouter'
							: options.ollama
								? 'ollama'
								: undefined
					});
					if (result.success) {
						console.log(chalk.green(`✅ ${result.data.message}`));
						if (result.data.warning)
							console.log(chalk.yellow(result.data.warning));
						updateOccurred = true;
					} else {
						console.error(
							chalk.red(
								`❌ Error setting fallback model: ${result.error.message}`
							)
						);
					}
				}

				// Optional: Add a final confirmation if any update occurred
				if (updateOccurred) {
					console.log(chalk.blue('\nModel configuration updated.'));
				} else {
					console.log(
						chalk.yellow(
							'\nNo model configuration changes were made (or errors occurred).'
						)
					);
				}

				// --- IMPORTANT: Exit after set operations ---
				return; // Stop execution here
			}

			// Action 3: Display Full Status (Only runs if no setup and no set flags)
			console.log(chalk.blue('Fetching current model configuration...')); // Added feedback
			const configResult = await getModelConfiguration({ projectRoot });
			const availableResult = await getAvailableModelsList({ projectRoot });
			const apiKeyStatusResult = await getApiKeyStatusReport({ projectRoot });

			// 1. Display Active Models
			if (!configResult.success) {
				console.error(
					chalk.red(
						`❌ Error fetching configuration: ${configResult.error.message}`
					)
				);
			} else {
				displayModelConfiguration(
					configResult.data,
					availableResult.data?.models || []
				);
			}

			// 2. Display API Key Status
			if (apiKeyStatusResult.success) {
				displayApiKeyStatus(apiKeyStatusResult.data.report);
			} else {
				console.error(
					chalk.yellow(
						`⚠️ Warning: Could not display API Key status: ${apiKeyStatusResult.error.message}`
					)
				);
			}

			// 3. Display Other Available Models (Filtered)
			if (availableResult.success) {
				const activeIds = configResult.success
					? [
							configResult.data.activeModels.main.modelId,
							configResult.data.activeModels.research.modelId,
							configResult.data.activeModels.fallback?.modelId
						].filter(Boolean)
					: [];
				const displayableAvailable = availableResult.data.models.filter(
					(m) => !activeIds.includes(m.modelId) && !m.modelId.startsWith('[')
				);
				displayAvailableModels(displayableAvailable);
			} else {
				console.error(
					chalk.yellow(
						`⚠️ Warning: Could not display available models: ${availableResult.error.message}`
					)
				);
			}

			// 4. Conditional Hint if Config File is Missing
			const configExists = isConfigFilePresent(projectRoot);
			if (!configExists) {
				console.log(
					chalk.yellow(
						"\\nHint: Run 'task-master models --setup' to create or update your configuration."
					)
				);
			}
			// --- IMPORTANT: Exit after displaying status ---
			return; // Stop execution here
		});

	// Monday.com Configuration Command
	programInstance
		.command('config-monday')
		.alias('monday')
		.description('Configure Monday.com integration settings')
		.option('--board-id <id>', 'Set Monday.com board ID')
		.option('--token <token>', 'Set Monday.com API token')
		.option('--status-column <name>', 'Set status column name (default: status)')
		.option('--name-column <name>', 'Set name column name (default: name)')
		.option('--notes-column <name>', 'Set notes column name (default: notes)')
		.option('--details-column <name>', 'Set details column name (default: details)')
		.option('--task-id-column <name>', 'Set task ID column name (default: task_id)')
		.option('--priority-column <name>', 'Set priority column name (default: priority)')
		.option('--test-strategy-column <name>', 'Set test strategy column name (default: test_strategy)')
		.option('--dependencies-column <name>', 'Set dependencies column name (default: dependencies)')
		.option('--auto-sync', 'Enable automatic sync')
		.option('--no-auto-sync', 'Disable automatic sync')
		.option('--show', 'Show current Monday.com configuration')
		.option('--validate', 'Validate Monday.com configuration and connection')
		.option('--init-board', 'Initialize Monday.com board by creating missing columns for Task Master integration')
		.action(async (options) => {
			try {


				// Show current configuration
				if (options.show) {
					const config = getMondayIntegrationConfig();
					console.log('\n📋 Monday.com Configuration:');
					console.log(`  Board ID: ${config.boardId || 'Not set'}`);
					console.log(`  API Token: ${config.apiToken ? '***set***' : 'Not set'}`);
					console.log('\n📊 Column Mapping:');
					console.log(`  Status: ${config.columnMapping.status}`);
					console.log(`  Name: ${config.columnMapping.name}`);
					console.log(`  Notes: ${config.columnMapping.notes}`);
					console.log(`  Details: ${config.columnMapping.details}`);
					console.log(`  Task ID: ${config.columnMapping.taskId}`);
					console.log(`  Priority: ${config.columnMapping.priority}`);
					console.log(`  Test Strategy: ${config.columnMapping.testStrategy}`);
					console.log(`  Dependencies: ${config.columnMapping.dependencies}`);
					console.log('\n⚙️ Sync Settings:');
					console.log(`  Auto-sync: ${config.syncSettings.autoSync ? 'Enabled' : 'Disabled'}`);
					return;
				}

				// Initialize board by creating missing columns
				if (options.initBoard) {
					
					const config = getMondayIntegrationConfig();
					
					if (!config.boardId) {
						console.error('❌ Board ID is required for board initialization. Set it first with --board-id=<id>');
						process.exit(1);
					}
					
					const apiToken = getMondayApiToken();
					if (!apiToken) {
						console.error('❌ Monday.com API token is required. Set MONDAY_API_TOKEN environment variable or use --token=<token>');
						process.exit(1);
					}
					
					console.log('🔧 Initializing Monday.com board for Task Master integration...');
					console.log(`📋 Board ID: ${config.boardId}`);
					
					const client = new MondayClient(apiToken);
					const result = await client.createMissingTaskMasterColumns(config.boardId);
					
					if (result.success) {
						console.log('\n✅ Board initialization completed successfully!');
						const { created, skipped, failed, updated, summary } = result.data;
						
						if (created.length > 0) {
							console.log('\n📝 Created columns:');
							created.forEach(({ purpose, column }) => {
								console.log(`  ✅ ${purpose}: "${column.title}" (ID: ${column.id}, Type: ${column.type})`);
							});
						}
						
						if (updated.length > 0) {
							console.log('\n🔄 Updated columns:');
							updated.forEach(({ purpose, column, action }) => {
								console.log(`  🔄 ${purpose}: "${column.title}" (ID: ${column.id}) - ${action}`);
							});
						}
						
						if (skipped.length > 0) {
							console.log('\n⚠️ Skipped columns (already exist):');
							skipped.forEach(({ purpose, column, reason, note }) => {
								console.log(`  ⏭️ ${purpose}: "${column.title}" (ID: ${column.id}) - ${reason}`);
								if (note) {
									console.log(`    ↳ ${note}`);
								}
							});
						}
						
						if (failed.length > 0) {
							console.log('\n❌ Failed columns:');
							failed.forEach(({ purpose, title, error }) => {
								console.log(`  ❌ ${purpose}: "${title}" - ${error}`);
							});
						}
						
						console.log(`\n📊 Summary: ${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.failed} failed`);
						
						// Automatically update configuration with new column IDs
						if (created.length > 0 || updated.length > 0) {
							console.log('\n🔄 Updating Task Master configuration with column IDs...');
							const columnMapping = {};
							
							// Handle created columns
							created.forEach(({ purpose, column }) => {
								if (purpose === 'details') {
									columnMapping.details = column.id;
								} else if (purpose === 'taskId') {
									columnMapping.taskId = column.id;
								} else if (purpose === 'priority') {
									columnMapping.priority = column.id;
								} else if (purpose === 'testStrategy') {
									columnMapping.testStrategy = column.id;
								} else if (purpose === 'dependencies') {
									columnMapping.dependencies = column.id;
								}
							});
							
							// Handle updated columns (ensure they're in the mapping)
							updated.forEach(({ purpose, column }) => {
								if (purpose === 'details') {
									columnMapping.details = column.id;
								} else if (purpose === 'taskId') {
									columnMapping.taskId = column.id;
								} else if (purpose === 'priority') {
									columnMapping.priority = column.id;
								} else if (purpose === 'testStrategy') {
									columnMapping.testStrategy = column.id;
								} else if (purpose === 'dependencies') {
									columnMapping.dependencies = column.id;
								}
							});
							
							if (Object.keys(columnMapping).length > 0) {
								updateMondayConfig({ columnMapping });
								console.log('✅ Configuration updated with column mappings:');
								Object.entries(columnMapping).forEach(([key, value]) => {
									console.log(`  ${key}: ${value}`);
								});
							}
						}
						
						console.log('\n🏷️ Available Priority Values for Task Master integration:');
						console.log('  • High (maps to high priority tasks)');
						console.log('  • Medium (maps to medium priority tasks)');
						console.log('  • Low (maps to low priority tasks)');
						console.log('');
						console.log('  📋 The priority dropdown has been configured with these labels.');
						console.log('  💡 Tasks will automatically map to these values during sync.');
						
						if (failed.length === 0) {
							console.log('\n🎉 Your Monday.com board is now ready for Task Master integration!');
							console.log('💡 You can run "task-master config-monday --validate" to verify everything is working.');
						} else {
							console.log('\n⚠️ Board initialization completed with some issues. Please review the failed columns above.');
						}
					} else {
						console.error(`❌ Board initialization failed: ${result.error}`);
						process.exit(1);
					}
					
					return;
				}

				// Validate configuration
				if (options.validate) {
					const validation = await validateMondayConfigWithBoardInfo(null, null, true);
					
					if (validation.valid) {
						console.log('✅ Monday.com configuration is valid');
						console.log(`📋 Connected to board: ${validation.boardName} (ID: ${validation.boardId})`);
						
						if (validation.boardInfo && validation.boardInfo.columns) {
							console.log('\n📊 Available Board Columns:');
							validation.boardInfo.columns.forEach(column => {
								console.log(`  - Column ID: "${column.id}"`);
								console.log(`    Title: ${column.title}`);
								console.log(`    Type: ${column.type}`);
								console.log('');
							});
							
							console.log('🔧 Current Column Mapping:');
							const columnMapping = getMondayColumnMapping();
							Object.entries(columnMapping).forEach(([key, value]) => {
								const columnExists = validation.boardInfo.columns.find(col => col.id === value);
								const status = columnExists ? '✅' : '❌';
								console.log(`  ${key}: "${value}" ${status}`);
								if (!columnExists) {
									console.log(`    ↳ Column "${value}" not found on board`);
								}
							});
						}
					} else {
						console.error('❌ Monday.com configuration is invalid:');
						validation.errors.forEach(error => console.error(`  - ${error}`));
						
						// If we have board info despite errors, show available columns
						if (validation.boardInfo && validation.boardInfo.columns) {
							console.log('\n📊 Available Board Columns (for reference):');
							validation.boardInfo.columns.forEach(column => {
								console.log(`  - Column ID: "${column.id}" (${column.title})`);
							});
						}
						process.exit(1);
					}
					return;
				}

				// Update configuration
				const updates = {};
				
				if (options.boardId) updates.boardId = options.boardId;
				if (options.token) updates.apiToken = options.token;
				
				// Column mapping updates
				const columnMapping = {};
				if (options.statusColumn) columnMapping.status = options.statusColumn;
				if (options.nameColumn) columnMapping.name = options.nameColumn;
				if (options.notesColumn) columnMapping.notes = options.notesColumn;
				if (options.detailsColumn) columnMapping.details = options.detailsColumn;
				if (options.taskIdColumn) columnMapping.taskId = options.taskIdColumn;
				if (options.priorityColumn) columnMapping.priority = options.priorityColumn;
				if (options.testStrategyColumn) columnMapping.testStrategy = options.testStrategyColumn;
				if (options.dependenciesColumn) columnMapping.dependencies = options.dependenciesColumn;
				if (Object.keys(columnMapping).length > 0) {
					updates.columnMapping = columnMapping;
				}

				// Auto-sync setting
				if (options.autoSync === true) updates.autoSync = true;
				if (options.autoSync === false) updates.autoSync = false;

				if (Object.keys(updates).length === 0) {
					console.log('No configuration changes specified. Use --show to view current settings.');
					return;
				}

				updateMondayConfig(updates);
				console.log('✅ Monday.com configuration updated successfully');

				// Show what was updated
				if (updates.boardId) console.log(`📋 Board ID set to: ${updates.boardId}`);
				if (updates.apiToken) console.log('🔑 API token updated');
				if (updates.columnMapping) {
					console.log('📊 Column mapping updated:');
					Object.entries(updates.columnMapping).forEach(([key, value]) => {
						console.log(`  ${key}: ${value}`);
					});
				}
				if (updates.autoSync !== undefined) {
					console.log(`⚙️ Auto-sync: ${updates.autoSync ? 'Enabled' : 'Disabled'}`);
				}

			} catch (error) {
				console.error('❌ Error configuring Monday.com integration:', error.message);
				process.exit(1);
			}
		});

	// Persistence configuration command
	programInstance
		.command('config-persistence')
		.alias('persistence')
		.description('Configure Task Master persistence mode and settings')
		.option('--mode <mode>', 'Set persistence mode (local, monday, hybrid)')
		.option('--show', 'Show current persistence configuration')
		.option('--validate', 'Validate persistence configuration')
		.option('--migrate', 'Migrate legacy Monday.com configuration to persistence structure')
		.action(async (options) => {
			try {

				// Show current configuration
				if (options.show) {
					const config = getPersistenceConfig();
					const mondayConfig = getMondayIntegrationConfig();
					displayPersistenceConfiguration(config, mondayConfig);
					return;
				}

				// Validate configuration
				if (options.validate) {
					console.log('🔍 Validating persistence configuration...');
					const validation = await validatePersistenceConfig();
					displayPersistenceValidation(validation);
					return;
				}

				// Migrate legacy configuration
				if (options.migrate) {
					console.log('🔄 Migrating legacy Monday.com configuration...');
					const migrated = migrateMondayIntegrationToPersistence();
					const currentMode = getPersistenceMode();
					displayPersistenceMigration(migrated, currentMode);
					return;
				}

				// Set persistence mode
				if (options.mode) {
					const validModes = ['local', 'monday', 'hybrid'];
					if (!validModes.includes(options.mode)) {
						console.error(`❌ Invalid persistence mode: ${options.mode}`);
						console.error(`Valid modes: ${validModes.join(', ')}`);
						process.exit(1);
					}

					console.log(`🔄 Setting persistence mode to: ${options.mode}`);
					const success = setPersistenceMode(options.mode);
					
					if (success) {
						console.log('✅ Persistence mode updated successfully');
						
						// Show helpful next steps for Monday.com modes
						if (options.mode === 'monday' || options.mode === 'hybrid') {
							console.log('\n💡 Next steps for Monday.com integration:');
							console.log('1. Configure Monday.com settings: task-master config-monday --board-id <id> --token <token>');
							console.log('2. Validate the configuration: task-master config-persistence --validate');
						}
					} else {
						console.error('❌ Failed to update persistence mode');
						process.exit(1);
					}
					return;
				}

				// If no options provided, show help and mode selection guide
				displayPersistenceModeHelp();
				console.log('\nUsage: task-master config-persistence [options]');
				console.log('');
				console.log('Options:');
				console.log('  --mode <mode>     Set persistence mode (local, monday, hybrid)');
				console.log('  --show           Show current persistence configuration');
				console.log('  --validate       Validate persistence configuration');
				console.log('  --migrate        Migrate legacy configuration');
				console.log('');
				console.log('Examples:');
				console.log('  task-master config-persistence --mode monday');
				console.log('  task-master config-persistence --show');
				console.log('  task-master config-persistence --validate');
				
			} catch (error) {
				console.error('❌ Error managing persistence configuration:', error.message);
				if (getDebugFlag()) {
					console.error('Error details:', error);
				}
				process.exit(1);
			}
		});

	// move-task command
	programInstance
		.command('move')
		.description('Move a task or subtask to a new position')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option(
			'--from <id>',
			'ID of the task/subtask to move (e.g., "5" or "5.2"). Can be comma-separated to move multiple tasks (e.g., "5,6,7")'
		)
		.option(
			'--to <id>',
			'ID of the destination (e.g., "7" or "7.3"). Must match the number of source IDs if comma-separated'
		)
		.action(async (options) => {
			const tasksPath = options.file;
			const sourceId = options.from;
			const destinationId = options.to;

			if (!sourceId || !destinationId) {
				console.error(
					chalk.red('Error: Both --from and --to parameters are required')
				);
				console.log(
					chalk.yellow(
						'Usage: task-master move --from=<sourceId> --to=<destinationId>'
					)
				);
				process.exit(1);
			}

			// Check if we're moving multiple tasks (comma-separated IDs)
			const sourceIds = sourceId.split(',').map((id) => id.trim());
			const destinationIds = destinationId.split(',').map((id) => id.trim());

			// Validate that the number of source and destination IDs match
			if (sourceIds.length !== destinationIds.length) {
				console.error(
					chalk.red(
						'Error: The number of source and destination IDs must match'
					)
				);
				console.log(
					chalk.yellow('Example: task-master move --from=5,6,7 --to=10,11,12')
				);
				process.exit(1);
			}

			// If moving multiple tasks
			if (sourceIds.length > 1) {
				console.log(
					chalk.blue(
						`Moving multiple tasks: ${sourceIds.join(', ')} to ${destinationIds.join(', ')}...`
					)
				);

				try {
					// Read tasks data once to validate destination IDs
					const tasksData = readJSON(tasksPath);
					if (!tasksData || !tasksData.tasks) {
						console.error(
							chalk.red(`Error: Invalid or missing tasks file at ${tasksPath}`)
						);
						process.exit(1);
					}

					// Move tasks one by one
					for (let i = 0; i < sourceIds.length; i++) {
						const fromId = sourceIds[i];
						const toId = destinationIds[i];

						// Skip if source and destination are the same
						if (fromId === toId) {
							console.log(
								chalk.yellow(`Skipping ${fromId} -> ${toId} (same ID)`)
							);
							continue;
						}

						console.log(
							chalk.blue(`Moving task/subtask ${fromId} to ${toId}...`)
						);
						try {
							await moveTask(
								tasksPath,
								fromId,
								toId,
								i === sourceIds.length - 1
							);
							console.log(
								chalk.green(
									`✓ Successfully moved task/subtask ${fromId} to ${toId}`
								)
							);
						} catch (error) {
							console.error(
								chalk.red(`Error moving ${fromId} to ${toId}: ${error.message}`)
							);
							// Continue with the next task rather than exiting
						}
					}
				} catch (error) {
					console.error(chalk.red(`Error: ${error.message}`));
					process.exit(1);
				}
			} else {
				// Moving a single task (existing logic)
				console.log(
					chalk.blue(`Moving task/subtask ${sourceId} to ${destinationId}...`)
				);

				try {
					const result = await moveTask(
						tasksPath,
						sourceId,
						destinationId,
						true
					);
					console.log(
						chalk.green(
							`✓ Successfully moved task/subtask ${sourceId} to ${destinationId}`
						)
					);
				} catch (error) {
					console.error(chalk.red(`Error: ${error.message}`));
					process.exit(1);
				}
			}
		});

	// Monday.com Sync Commands
	programInstance
		.command('sync-monday')
		.description('Sync all tasks to Monday.com board')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option('--task-id <id>', 'Sync only a specific task by ID')
		.option('--dry-run', 'Show what would be synced without making changes')
		.option('--force', 'Clear all sync data and resync all tasks from scratch')
		.action(async (options) => {
			try {
				const projectRoot = findProjectRoot();
				if (!projectRoot) {
					console.error(chalk.red('Error: Could not find project root directory'));
					process.exit(1);
				}



				// Check if Monday.com integration is configured
				const config = getMondayIntegrationConfig(projectRoot);
				if (!config || !config.boardId) {
					console.error(chalk.red('Error: Monday.com integration not configured.'));
					console.log(chalk.yellow('Run "task-master config-monday" first to configure the integration.'));
					process.exit(1);
				}

				// Check if API token is available
				const token = getMondayApiToken(projectRoot);
				if (!token) {
					console.error(chalk.red('Error: Monday.com API token not found.'));
					console.log(chalk.yellow('Set MONDAY_API_TOKEN environment variable or configure via "task-master config-monday --token=YOUR_TOKEN"'));
					process.exit(1);
				}

				const tasksPath = path.resolve(options.file);
				if (!fs.existsSync(tasksPath)) {
					console.error(chalk.red(`Error: Tasks file not found at ${tasksPath}`));
					process.exit(1);
				}

				const tasks = readJSON(tasksPath);
				if (!tasks || !tasks.tasks) {
					console.error(chalk.red('Error: Invalid tasks file format'));
					process.exit(1);
				}

				// Handle force option - clear all Monday sync data to start fresh
				if (options.force) {
					console.log(chalk.yellow('🔄 Force mode: Clearing all Monday sync data and resyncing from scratch...\n'));
					
					// Clear Monday sync data from all tasks and subtasks
					tasks.tasks.forEach(task => {
						// Clear task sync data and mark as pending
						delete task.mondayItemId;
						task.syncStatus = 'pending';  // Mark as pending so it gets picked up by sync
						delete task.syncError;
						delete task.lastSyncedAt;
						delete task.lastModifiedMonday;
						
						// Clear subtask sync data and mark as pending
						if (task.subtasks && Array.isArray(task.subtasks)) {
							task.subtasks.forEach(subtask => {
								delete subtask.mondayItemId;
								subtask.syncStatus = 'pending';  // Mark as pending so it gets picked up by sync--all
								delete subtask.syncError;
								delete subtask.lastSyncedAt;
								delete subtask.lastModifiedMonday;
							});
						}
					});
					
					// Save the cleaned tasks file
					writeJSON(tasksPath, tasks);
					console.log(chalk.green('✅ Cleared all Monday sync data from tasks.json'));
				}

				// Handle dry run mode
				if (options.dryRun) {
					console.log(chalk.blue('🔍 Dry run mode - no changes will be made to Monday.com\n'));
					
					if (options.taskId) {
						const taskId = parseInt(options.taskId);
						const task = tasks.tasks.find(t => t.id === taskId);
						if (task) {
							console.log(chalk.green(`Would sync task ${task.id}: ${task.title}`));
							if (task.mondayItemId && !options.force) {
								console.log(chalk.yellow(`  → Update existing Monday item ${task.mondayItemId}`));
							} else {
								console.log(chalk.blue('  → Create new Monday item'));
							}
							
							// Check subtasks if they exist
							if (task.subtasks && task.subtasks.length > 0) {
								const subtasksNeedingSync = options.force ? task.subtasks : task.subtasks.filter(st => 
									st.syncStatus === 'pending' || st.syncStatus === 'error' || !st.hasOwnProperty('syncStatus')
								);
								if (subtasksNeedingSync.length > 0) {
									console.log(chalk.blue(`  → Would also sync ${subtasksNeedingSync.length} subtasks`));
									subtasksNeedingSync.forEach(subtask => {
										console.log(chalk.blue(`    - Subtask ${task.id}.${subtask.id}: ${subtask.title}`));
									});
								}
							}
						} else {
							console.error(chalk.red(`Task with ID ${options.taskId} not found`));
							process.exit(1);
						}
					} else {
						// In force mode, sync everything; otherwise use getTasksNeedingSync
						let itemsToSync;
						if (options.force) {
							// Count all tasks and subtasks for force mode
							itemsToSync = [];
							tasks.tasks.forEach(task => {
								itemsToSync.push({ type: 'task', id: task.id, task });
								if (task.subtasks && Array.isArray(task.subtasks)) {
									task.subtasks.forEach(subtask => {
										itemsToSync.push({ 
											type: 'subtask', 
											id: `${task.id}.${subtask.id}`, 
											task: subtask, 
											parentId: task.id 
										});
									});
								}
							});
						} else {
							itemsToSync = getTasksNeedingSync(tasksPath);
						}
						
						console.log(chalk.green(`Would sync ${itemsToSync.length} items${options.force ? ' (all tasks and subtasks)' : ' that need syncing'}:`));
						itemsToSync.forEach(item => {
							if (item.type === 'task') {
								console.log(chalk.blue(`  - Task ${item.id}: ${item.task.title}`));
							} else {
								console.log(chalk.blue(`  - Subtask ${item.id}: ${item.task.title}`));
							}
						});
						
						if (itemsToSync.length === 0 && !options.force) {
							console.log(chalk.green('✅ All tasks and subtasks are already synced - nothing to do!'));
						}
					}
					return;
				}

				// Create sync engine
				let syncEngine;
				try {
					syncEngine = createMondaySyncEngine(projectRoot);
				} catch (error) {
					console.error(chalk.red(`Error creating sync engine: ${error.message}`));
					process.exit(1);
				}

				// Perform actual sync
				const spinner = ora('Initializing Monday.com sync...').start();

				try {
					if (options.taskId) {
						// Sync specific task
						const taskId = parseInt(options.taskId);
						const task = tasks.tasks.find(t => t.id === taskId);
						
						if (!task) {
							spinner.fail(chalk.red(`Task with ID ${options.taskId} not found`));
							process.exit(1);
						}

						spinner.text = `Syncing task ${taskId} to Monday.com...`;
						const result = await syncEngine.syncTask(task, tasksPath, taskId.toString());
						
						if (result.success) {
							spinner.succeed(chalk.green(`✅ Task ${taskId} synced successfully to Monday item ${result.mondayItemId}`));
						} else {
							spinner.fail(chalk.red(`❌ Error syncing task ${taskId}: ${result.error}`));
							process.exit(1);
						}
					} else {
						// In force mode, sync everything; otherwise only sync tasks that need syncing
						let itemsToSync;
						if (options.force) {
							// Force mode - sync all tasks
							spinner.text = 'Force mode: Syncing all tasks to Monday.com...';
						} else {
							itemsToSync = getTasksNeedingSync(tasksPath);
							
							if (itemsToSync.length === 0) {
								spinner.succeed(chalk.green('✅ All tasks and subtasks are already synced - nothing to sync!'));
								return;
							}
							spinner.text = `Syncing ${itemsToSync.length} items to Monday.com...`;
						}

						const results = await syncEngine.syncAll(tasksPath);
						
						spinner.stop();
						
						console.log(chalk.green(`\n📊 Sync completed:`));
						console.log(chalk.green(`  ✅ Succeeded: ${results.synced}`));
						console.log(chalk.red(`  ❌ Failed: ${results.errors}`));
						console.log(chalk.blue(`  📋 Total: ${results.totalItems}`));
						
						if (options.force) {
							console.log(chalk.yellow('\n🔄 Force sync completed - all tasks have been resynced from scratch'));
						}
						
						if (results.errors > 0) {
							console.log(chalk.red('\n❌ Failed items:'));
							results.details.filter(d => !d.success).forEach(detail => {
								console.log(chalk.red(`  - ${detail.type} ${detail.id}: ${detail.title} - ${detail.error}`));
							});
							process.exit(1);
						} else {
							console.log(chalk.green('\n🎉 All items synced successfully!'));
						}
					}
				} catch (error) {
					spinner.fail(chalk.red(`Exception during sync: ${error.message}`));
					console.error(chalk.gray(error.stack));
					process.exit(1);
				}

			} catch (error) {
				console.error(chalk.red(`Error syncing to Monday.com: ${error.message}`));
				process.exit(1);
			}
		});

	// Monday.com Status Command
	programInstance
		.command('monday-status')
		.description('Show Monday.com sync status')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option('--verbose', 'Show detailed status information')
		.action(async (options) => {
			try {
				const projectRoot = findProjectRoot();
				if (!projectRoot) {
					console.error(chalk.red('Error: Could not find project root directory'));
					process.exit(1);
				}



				// Check if Monday.com integration is configured
				const config = getMondayIntegrationConfig(projectRoot);
				if (!config || !config.boardId) {
					console.error(chalk.red('Error: Monday.com integration not configured.'));
					console.log(chalk.yellow('Run "task-master config-monday" first to configure the integration.'));
					process.exit(1);
				}

				const tasksPath = path.resolve(options.file);
				if (!fs.existsSync(tasksPath)) {
					console.error(chalk.red(`Error: Tasks file not found at ${tasksPath}`));
					process.exit(1);
				}

				const tasks = readJSON(tasksPath);
				if (!tasks || !tasks.tasks) {
					console.error(chalk.red('Error: Invalid tasks file format'));
					process.exit(1);
				}

				// Calculate sync statistics
				const syncedTasks = tasks.tasks.filter(t => t.mondayItemId && t.syncStatus === 'synced');
				const pendingItems = getTasksNeedingSync(tasksPath);
				const errorTasks = tasks.tasks.filter(t => t.syncStatus === 'error');
				
				// Count subtasks separately
				let totalSubtasks = 0;
				let syncedSubtasks = 0;
				let errorSubtasks = 0;
				
				tasks.tasks.forEach(task => {
					if (task.subtasks) {
						totalSubtasks += task.subtasks.length;
						syncedSubtasks += task.subtasks.filter(st => st.mondayItemId && st.syncStatus === 'synced').length;
						errorSubtasks += task.subtasks.filter(st => st.syncStatus === 'error').length;
					}
				});

				// Display status
				console.log(chalk.blue('\n📋 Monday.com Sync Status'));
				console.log(chalk.blue('================================\n'));
				
				// Configuration info
				console.log(chalk.green('⚙️  Configuration:'));
				console.log(`   Board ID: ${chalk.yellow(config.boardId)}`);
				console.log(`   API Token: ${getMondayApiToken(projectRoot) ? chalk.green('✅ Set') : chalk.red('❌ Not set')}`);
				
				// Overall statistics
				console.log(chalk.green('\n📊 Overall Statistics:'));
				console.log(`   Total tasks: ${chalk.blue(tasks.tasks.length)}`);
				console.log(`   Total subtasks: ${chalk.blue(totalSubtasks)}`);
				console.log(`   Synced tasks: ${chalk.green(syncedTasks.length)}`);
				console.log(`   Synced subtasks: ${chalk.green(syncedSubtasks)}`);
				console.log(`   Pending sync: ${chalk.yellow(pendingItems.length)}`);
				console.log(`   Failed tasks: ${chalk.red(errorTasks.length)}`);
				console.log(`   Failed subtasks: ${chalk.red(errorSubtasks)}`);

				// Show failed items
				if (errorTasks.length > 0 || errorSubtasks > 0) {
					console.log(chalk.red('\n❌ Items with sync errors:'));
					
					// Failed tasks
					errorTasks.forEach(task => {
						console.log(chalk.red(`   Task ${task.id}: ${task.title}`));
						if (task.syncError) {
							console.log(chalk.gray(`     Error: ${task.syncError}`));
						}
					});
					
					// Failed subtasks
					tasks.tasks.forEach(task => {
						if (task.subtasks) {
							task.subtasks.filter(st => st.syncStatus === 'error').forEach(subtask => {
								console.log(chalk.red(`   Subtask ${task.id}.${subtask.id}: ${subtask.title}`));
								if (subtask.syncError) {
									console.log(chalk.gray(`     Error: ${subtask.syncError}`));
								}
							});
						}
					});
				}

				// Show pending items
				if (pendingItems.length > 0) {
					console.log(chalk.yellow('\n⏳ Items pending sync:'));
					pendingItems.forEach(item => {
						if (item.type === 'task') {
							console.log(chalk.yellow(`   Task ${item.id}: ${item.task.title}`));
						} else {
							console.log(chalk.yellow(`   Subtask ${item.id}: ${item.task.title}`));
						}
					});
				}

				// Verbose mode - show detailed information
				if (options.verbose) {
					console.log(chalk.blue('\n🔍 Detailed Information:'));
					
					console.log(chalk.green('\n✅ Successfully synced tasks:'));
					if (syncedTasks.length === 0) {
						console.log(chalk.gray('   None'));
					} else {
						syncedTasks.forEach(task => {
							console.log(chalk.green(`   Task ${task.id}: ${task.title}`));
							console.log(chalk.gray(`     Monday Item ID: ${task.mondayItemId}`));
							if (task.lastSyncedAt) {
								console.log(chalk.gray(`     Last synced: ${new Date(task.lastSyncedAt).toLocaleString()}`));
							}
						});
					}
					
					console.log(chalk.green('\n✅ Successfully synced subtasks:'));
					const syncedSubtasksList = [];
					tasks.tasks.forEach(task => {
						if (task.subtasks) {
							task.subtasks.filter(st => st.mondayItemId && st.syncStatus === 'synced').forEach(subtask => {
								syncedSubtasksList.push({ parentId: task.id, subtask });
							});
						}
					});
					
					if (syncedSubtasksList.length === 0) {
						console.log(chalk.gray('   None'));
					} else {
						syncedSubtasksList.forEach(({ parentId, subtask }) => {
							console.log(chalk.green(`   Subtask ${parentId}.${subtask.id}: ${subtask.title}`));
							console.log(chalk.gray(`     Monday Item ID: ${subtask.mondayItemId}`));
							if (subtask.lastSyncedAt) {
								console.log(chalk.gray(`     Last synced: ${new Date(subtask.lastSyncedAt).toLocaleString()}`));
							}
						});
					}
				}

				// Suggest next steps
				if (pendingItems.length > 0) {
					console.log(chalk.blue('\n💡 Next steps:'));
					console.log(chalk.yellow('   Run "task-master sync-monday" to sync all tasks'));
				} else if (errorTasks.length === 0 && errorSubtasks === 0) {
					console.log(chalk.green('\n🎉 All items are in sync!'));
				}

			} catch (error) {
				console.error(chalk.red(`Error getting Monday.com status: ${error.message}`));
				process.exit(1);
			}
		});

	// Monday.com Init Sync Command
	programInstance
		.command('init-monday-sync')
		.description('Initialize all local tasks with Monday.com sync fields (sets syncStatus to pending)')
		.option('-f, --file <file>', 'Path to the tasks file', 'tasks/tasks.json')
		.option('-y, --yes', 'Skip confirmation prompt')
		.action(async (options) => {
			try {
				const projectRoot = findProjectRoot();
				if (!projectRoot) {
					console.error(chalk.red('Error: Could not find project root directory'));
					process.exit(1);
				}



				// Check if Monday.com integration is configured
				const config = getMondayIntegrationConfig(projectRoot);
				if (!config || !config.boardId) {
					console.error(chalk.red('Error: Monday.com integration not configured.'));
					console.log(chalk.yellow('Run "task-master config-monday" first to configure the integration.'));
					process.exit(1);
				}

				const tasksPath = path.resolve(options.file);
				if (!fs.existsSync(tasksPath)) {
					console.error(chalk.red(`Error: Tasks file not found at ${tasksPath}`));
					process.exit(1);
				}

				const tasks = readJSON(tasksPath);
				if (!tasks || !tasks.tasks) {
					console.error(chalk.red('Error: Invalid tasks file format'));
					process.exit(1);
				}

				// Show information about what will be done
				console.log(chalk.blue('📋 Monday.com Sync Initialization\n'));
				console.log(chalk.white(`This will initialize all tasks in ${tasksPath} with Monday.com sync fields.`));
				console.log(chalk.white('Tasks without sync fields will be marked as "pending" for sync.\n'));
				
				// Count tasks that need initialization
				let tasksNeedingInit = 0;
				let subtasksNeedingInit = 0;
				
				tasks.tasks.forEach(task => {
					if (!task.hasOwnProperty('mondayItemId')) {
						tasksNeedingInit++;
					}
					if (task.subtasks) {
						task.subtasks.forEach(subtask => {
							if (!subtask.hasOwnProperty('mondayItemId')) {
								subtasksNeedingInit++;
							}
						});
					}
				});

				const totalNeedingInit = tasksNeedingInit + subtasksNeedingInit;
				
				if (totalNeedingInit === 0) {
					console.log(chalk.green('✅ All tasks already have Monday.com sync fields initialized!'));
					return;
				}

				console.log(chalk.yellow(`Found ${tasksNeedingInit} tasks and ${subtasksNeedingInit} subtasks that need initialization.`));
				console.log(chalk.yellow(`Total items to initialize: ${totalNeedingInit}\n`));

				// Confirmation prompt (unless --yes flag is used)
				if (!options.yes) {
					const { confirmInit } = await inquirer.prompt([
						{
							type: 'confirm',
							name: 'confirmInit',
							message: 'Do you want to proceed with initializing Monday.com sync fields?',
							default: true
						}
					]);

					if (!confirmInit) {
						console.log(chalk.yellow('❌ Operation cancelled.'));
						return;
					}
				}

				// Perform the initialization
				const spinner = ora('Initializing Monday.com sync fields...').start();

				try {
					const result = await initializeMondayFieldsForAllTasks(tasksPath);
					
					if (result.success) {
						spinner.succeed(chalk.green(`✅ ${result.message}`));
						console.log(chalk.green(`\n🎉 Initialization completed! You can now run "task-master sync-monday" to sync your tasks.`));
						
						if (result.updatedCount > 0) {
							console.log(chalk.blue(`\n💡 Tip: Use "task-master monday-status" to check sync status before syncing.`));
						}
					} else {
						spinner.fail(chalk.red(`❌ Initialization failed: ${result.error}`));
						process.exit(1);
					}
				} catch (error) {
					spinner.fail(chalk.red(`❌ Exception during initialization: ${error.message}`));
					console.error(chalk.gray(error.stack));
					process.exit(1);
				}

			} catch (error) {
				console.error(chalk.red(`Error initializing Monday.com sync: ${error.message}`));
				process.exit(1);
			}
		});

	return programInstance;
}

/**
 * Setup the CLI application
 * @returns {Object} Configured Commander program
 */
function setupCLI() {
	// Create a new program instance
	const programInstance = program
		.name('dev')
		.description('AI-driven development task management')
		.version(() => {
			// Read version directly from package.json ONLY
			try {
				const packageJsonPath = path.join(process.cwd(), 'package.json');
				if (fs.existsSync(packageJsonPath)) {
					const packageJson = JSON.parse(
						fs.readFileSync(packageJsonPath, 'utf8')
					);
					return packageJson.version;
				}
			} catch (error) {
				// Silently fall back to 'unknown'
				log(
					'warn',
					'Could not read package.json for version info in .version()'
				);
			}
			return 'unknown'; // Default fallback if package.json fails
		})
		.helpOption('-h, --help', 'Display help')
		.addHelpCommand(false); // Disable default help command

	// Modify the help option to use your custom display
	programInstance.helpInformation = () => {
		displayHelp();
		return '';
	};

	// Register commands
	registerCommands(programInstance);

	return programInstance;
}

/**
 * Check for newer version of task-master-ai
 * @returns {Promise<{currentVersion: string, latestVersion: string, needsUpdate: boolean}>}
 */
async function checkForUpdate() {
	// Get current version from package.json ONLY
	const currentVersion = getTaskMasterVersion();

	return new Promise((resolve) => {
		// Get the latest version from npm registry
		const options = {
			hostname: 'registry.npmjs.org',
			path: '/task-master-ai',
			method: 'GET',
			headers: {
				Accept: 'application/vnd.npm.install-v1+json' // Lightweight response
			}
		};

		const req = https.request(options, (res) => {
			let data = '';

			res.on('data', (chunk) => {
				data += chunk;
			});

			res.on('end', () => {
				try {
					const npmData = JSON.parse(data);
					const latestVersion = npmData['dist-tags']?.latest || currentVersion;

					// Compare versions
					const needsUpdate =
						compareVersions(currentVersion, latestVersion) < 0;

					resolve({
						currentVersion,
						latestVersion,
						needsUpdate
					});
				} catch (error) {
					log('debug', `Error parsing npm response: ${error.message}`);
					resolve({
						currentVersion,
						latestVersion: currentVersion,
						needsUpdate: false
					});
				}
			});
		});

		req.on('error', (error) => {
			log('debug', `Error checking for updates: ${error.message}`);
			resolve({
				currentVersion,
				latestVersion: currentVersion,
				needsUpdate: false
			});
		});

		// Set a timeout to avoid hanging if npm is slow
		req.setTimeout(3000, () => {
			req.abort();
			log('debug', 'Update check timed out');
			resolve({
				currentVersion,
				latestVersion: currentVersion,
				needsUpdate: false
			});
		});

		req.end();
	});
}

/**
 * Compare semantic versions
 * @param {string} v1 - First version
 * @param {string} v2 - Second version
 * @returns {number} -1 if v1 < v2, 0 if v1 = v2, 1 if v1 > v2
 */
function compareVersions(v1, v2) {
	const v1Parts = v1.split('.').map((p) => parseInt(p, 10));
	const v2Parts = v2.split('.').map((p) => parseInt(p, 10));

	for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
		const v1Part = v1Parts[i] || 0;
		const v2Part = v2Parts[i] || 0;

		if (v1Part < v2Part) return -1;
		if (v1Part > v2Part) return 1;
	}

	return 0;
}

/**
 * Display upgrade notification message
 * @param {string} currentVersion - Current version
 * @param {string} latestVersion - Latest version
 */
function displayUpgradeNotification(currentVersion, latestVersion) {
	const message = boxen(
		`${chalk.blue.bold('Update Available!')} ${chalk.dim(currentVersion)} → ${chalk.green(latestVersion)}\n\n` +
			`Run ${chalk.cyan('npm i task-master-ai@latest -g')} to update to the latest version with new features and bug fixes.`,
		{
			padding: 1,
			margin: { top: 1, bottom: 1 },
			borderColor: 'yellow',
			borderStyle: 'round'
		}
	);

	console.log(message);
}

/**
 * Parse arguments and run the CLI
 * @param {Array} argv - Command-line arguments
 */
async function runCLI(argv = process.argv) {
	try {
		// Display banner if not in a pipe
		if (process.stdout.isTTY) {
			displayBanner();
		}

		// If no arguments provided, show help
		if (argv.length <= 2) {
			displayHelp();
			process.exit(0);
		}

		// Start the update check in the background - don't await yet
		const updateCheckPromise = checkForUpdate();

		// Setup and parse
		// NOTE: getConfig() might be called during setupCLI->registerCommands if commands need config
		// This means the ConfigurationError might be thrown here if .taskmasterconfig is missing.
		const programInstance = setupCLI();
		await programInstance.parseAsync(argv);

		// After command execution, check if an update is available
		const updateInfo = await updateCheckPromise;
		if (updateInfo.needsUpdate) {
			displayUpgradeNotification(
				updateInfo.currentVersion,
				updateInfo.latestVersion
			);
		}
	} catch (error) {
		// ** Specific catch block for missing configuration file **
		if (error instanceof ConfigurationError) {
			console.error(
				boxen(
					chalk.red.bold('Configuration Update Required!') +
						'\n\n' +
						chalk.white('Taskmaster now uses the ') +
						chalk.yellow.bold('.taskmasterconfig') +
						chalk.white(
							' file in your project root for AI model choices and settings.\n\n' +
								'This file appears to be '
						) +
						chalk.red.bold('missing') +
						chalk.white('. No worries though.\n\n') +
						chalk.cyan.bold('To create this file, run the interactive setup:') +
						'\n' +
						chalk.green('   task-master models --setup') +
						'\n\n' +
						chalk.white.bold('Key Points:') +
						'\n' +
						chalk.white('*   ') +
						chalk.yellow.bold('.taskmasterconfig') +
						chalk.white(
							': Stores your AI model settings (do not manually edit)\n'
						) +
						chalk.white('*   ') +
						chalk.yellow.bold('.env & .mcp.json') +
						chalk.white(': Still used ') +
						chalk.red.bold('only') +
						chalk.white(' for your AI provider API keys.\n\n') +
						chalk.cyan(
							'`task-master models` to check your config & available models\n'
						) +
						chalk.cyan(
							'`task-master models --setup` to adjust the AI models used by Taskmaster'
						),
					{
						padding: 1,
						margin: { top: 1 },
						borderColor: 'red',
						borderStyle: 'round'
					}
				)
			);
		} else {
			// Generic error handling for other errors
			console.error(chalk.red(`Error: ${error.message}`));
			if (getDebugFlag()) {
				console.error(error);
			}
		}

		process.exit(1);
	}
}

export {
	registerCommands,
	setupCLI,
	runCLI,
	checkForUpdate,
	compareVersions,
	displayUpgradeNotification
};
