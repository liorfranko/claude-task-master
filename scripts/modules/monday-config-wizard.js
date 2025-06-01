/**
 * monday-config-wizard.js
 * Interactive Configuration Wizard for Monday.com Integration
 * 
 * This module provides an interactive setup wizard for configuring
 * Monday.com integration with Task Master.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { 
	setupMondayIntegration, 
	disableMondayIntegration,
	getMondayIntegrationStatus,
	validateCompleteMondayConfig,
	getMondayEnvTemplate,
	isMondayApiKeyAvailable 
} from './monday-config-manager.js';
import { initializeMondayApiClient } from './monday-api-client.js';
import { createTaskMasterBoard, validateTaskMasterBoard } from './monday-board-manager.js';
import { log } from './utils.js';

/**
 * Runs the interactive Monday.com configuration wizard
 * @param {Object} options - Wizard options
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Wizard completion result
 */
export async function runMondayConfigurationWizard(options = {}, explicitRoot = null) {
	console.log(chalk.blue.bold('\n🎯 Task Master Monday.com Integration Wizard\n'));

	try {
		// Step 1: Check current status
		const currentStatus = getMondayIntegrationStatus(explicitRoot);
		
		if (currentStatus.enabled && currentStatus.valid) {
			console.log(chalk.green('✅ Monday.com integration is already configured and active.'));
			
			const { action } = await inquirer.prompt([{
				type: 'list',
				name: 'action',
				message: 'What would you like to do?',
				choices: [
					{ name: 'View current configuration', value: 'view' },
					{ name: 'Reconfigure integration', value: 'reconfigure' },
					{ name: 'Disable integration', value: 'disable' },
					{ name: 'Test integration', value: 'test' },
					{ name: 'Exit', value: 'exit' }
				]
			}]);

			switch (action) {
				case 'view':
					return await showCurrentConfiguration(explicitRoot);
				case 'reconfigure':
					return await runFullWizard(explicitRoot, true);
				case 'disable':
					return await confirmAndDisableIntegration(explicitRoot);
				case 'test':
					return await testIntegration(explicitRoot);
				case 'exit':
					return { cancelled: true, message: 'Wizard cancelled by user' };
			}
		}

		// Step 2: Run full setup wizard
		return await runFullWizard(explicitRoot, false);

	} catch (error) {
		console.error(chalk.red(`\n❌ Wizard failed: ${error.message}`));
		return {
			success: false,
			error: error.message
		};
	}
}

/**
 * Runs the complete configuration wizard
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @param {boolean} isReconfiguration - Whether this is a reconfiguration
 * @returns {Object} Setup result
 */
async function runFullWizard(explicitRoot = null, isReconfiguration = false) {
	console.log(chalk.yellow(isReconfiguration ? 
		'🔄 Reconfiguring Monday.com integration...' : 
		'🚀 Setting up Monday.com integration...'
	));

	// Step 1: API Key Check
	if (!isMondayApiKeyAvailable()) {
		console.log(chalk.red('\n❌ Monday.com API key not found'));
		console.log(chalk.yellow('Please add your Monday.com API key to your environment.'));
		console.log(chalk.gray('Add this to your .env file:'));
		console.log(chalk.cyan(getMondayEnvTemplate()));
		
		const { continueWithoutKey } = await inquirer.prompt([{
			type: 'confirm',
			name: 'continueWithoutKey',
			message: 'Continue wizard anyway? (Integration won\'t work until API key is added)',
			default: false
		}]);

		if (!continueWithoutKey) {
			return {
				success: false,
				message: 'Setup cancelled - please add API key and try again'
			};
		}
	} else {
		console.log(chalk.green('✅ Monday.com API key found'));
	}

	// Step 2: Board Setup Choice
	const { boardChoice } = await inquirer.prompt([{
		type: 'list',
		name: 'boardChoice',
		message: 'How would you like to set up your Monday.com board?',
		choices: [
			{ name: 'Create a new Task Master board', value: 'create' },
			{ name: 'Use an existing board (provide board ID)', value: 'existing' },
			{ name: 'Skip board setup for now', value: 'skip' }
		]
	}]);

	let boardId = null;
	let boardCreated = false;

	if (boardChoice === 'create') {
		const result = await createNewBoard(explicitRoot);
		if (result.success) {
			boardId = result.boardId;
			boardCreated = true;
		} else {
			console.log(chalk.yellow('⚠️ Board creation failed, continuing with manual setup'));
		}
	} else if (boardChoice === 'existing') {
		const { inputBoardId } = await inquirer.prompt([{
			type: 'input',
			name: 'inputBoardId',
			message: 'Enter your Monday.com board ID:',
			validate: (input) => {
				if (!input || input.trim().length === 0) {
					return 'Board ID is required';
				}
				if (!/^\d+$/.test(input.trim())) {
					return 'Board ID should be a number';
				}
				return true;
			}
		}]);
		boardId = inputBoardId.trim();

		// Validate the board
		if (isMondayApiKeyAvailable()) {
			try {
				console.log(chalk.blue('🔍 Validating board...'));
				const validation = await validateTaskMasterBoard(process.env.MONDAY_API_KEY, boardId);
				
				if (validation.valid) {
					console.log(chalk.green('✅ Board is ready for Task Master'));
				} else {
					console.log(chalk.yellow('⚠️ Board needs setup for Task Master'));
					console.log(chalk.gray(`Missing: ${validation.missingColumns.concat(validation.missingGroups).join(', ')}`));
					
					const { setupBoard } = await inquirer.prompt([{
						type: 'confirm',
						name: 'setupBoard',
						message: 'Would you like to setup the required columns and groups?',
						default: true
					}]);

					if (setupBoard) {
						// Here you would call board setup logic
						console.log(chalk.blue('📋 Setting up board schema...'));
						console.log(chalk.yellow('Note: Board setup integration would be implemented here'));
					}
				}
			} catch (error) {
				console.log(chalk.yellow(`⚠️ Could not validate board: ${error.message}`));
			}
		}
	}

	// Step 3: Configuration Preferences
	const preferences = await inquirer.prompt([
		{
			type: 'list',
			name: 'persistenceMode',
			message: 'Choose your persistence mode:',
			choices: [
				{ 
					name: 'Monday.com only - All tasks stored on Monday.com', 
					value: 'monday' 
				},
				{ 
					name: 'Hybrid - Local files synced with Monday.com', 
					value: 'hybrid' 
				},
				{ 
					name: 'Local only - Keep using local files', 
					value: 'local' 
				}
			],
			default: 'monday'
		},
		{
			type: 'confirm',
			name: 'autoSync',
			message: 'Enable automatic synchronization?',
			default: false,
			when: (answers) => answers.persistenceMode === 'hybrid'
		},
		{
			type: 'number',
			name: 'syncInterval',
			message: 'Sync interval (seconds):',
			default: 300,
			validate: (input) => input >= 60 || 'Minimum sync interval is 60 seconds',
			when: (answers) => answers.autoSync
		},
		{
			type: 'list',
			name: 'conflictResolution',
			message: 'How should conflicts be resolved?',
			choices: [
				{ name: 'Always prompt me', value: 'prompt' },
				{ name: 'Prefer Monday.com version', value: 'monday' },
				{ name: 'Prefer local version', value: 'local' },
				{ name: 'Use newest version', value: 'newest' }
			],
			default: 'prompt',
			when: (answers) => answers.persistenceMode === 'hybrid'
		}
	]);

	// Step 4: Apply Configuration
	try {
		const setupOptions = {
			boardId,
			persistenceMode: preferences.persistenceMode,
			autoSync: preferences.autoSync || false,
			syncInterval: preferences.syncInterval || 300,
			conflictResolution: preferences.conflictResolution || 'prompt',
			enabled: preferences.persistenceMode !== 'local'
		};

		if (setupOptions.enabled && !boardId) {
			console.log(chalk.yellow('⚠️ Integration enabled but no board ID provided'));
			console.log(chalk.gray('You can add a board ID later by running the wizard again'));
		}

		let result;
		if (setupOptions.enabled) {
			result = setupMondayIntegration(setupOptions, explicitRoot);
		} else {
			result = disableMondayIntegration(explicitRoot);
		}

		// Step 5: Success Summary
		console.log(chalk.green.bold('\n🎉 Configuration completed successfully!'));
		
		if (boardCreated) {
			console.log(chalk.cyan(`📋 New board created: ${boardId}`));
		}
		
		console.log(chalk.blue('📊 Configuration Summary:'));
		console.log(chalk.gray(`   Persistence Mode: ${preferences.persistenceMode}`));
		console.log(chalk.gray(`   Board ID: ${boardId || 'Not set'}`));
		console.log(chalk.gray(`   Auto Sync: ${preferences.autoSync ? 'Enabled' : 'Disabled'}`));
		
		if (preferences.autoSync) {
			console.log(chalk.gray(`   Sync Interval: ${preferences.syncInterval} seconds`));
			console.log(chalk.gray(`   Conflict Resolution: ${preferences.conflictResolution}`));
		}

		console.log(chalk.green('\n✅ Monday.com integration is now configured!'));
		
		if (preferences.persistenceMode !== 'local') {
			console.log(chalk.yellow('\n💡 Next steps:'));
			console.log(chalk.gray('   1. Your tasks will now be synchronized with Monday.com'));
			console.log(chalk.gray('   2. You can switch between modes anytime by running this wizard again'));
			console.log(chalk.gray('   3. Use regular Task Master commands - they\'ll work with Monday.com automatically'));
		}

		return {
			success: true,
			configuration: result.config,
			boardCreated,
			boardId,
			message: 'Monday.com integration configured successfully'
		};

	} catch (error) {
		console.log(chalk.red(`\n❌ Configuration failed: ${error.message}`));
		return {
			success: false,
			error: error.message
		};
	}
}

/**
 * Creates a new Task Master board
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Creation result
 */
async function createNewBoard(explicitRoot = null) {
	try {
		const { projectName } = await inquirer.prompt([{
			type: 'input',
			name: 'projectName',
			message: 'Enter a name for your Task Master board:',
			default: 'Task Master Project',
			validate: (input) => input.trim().length > 0 || 'Project name is required'
		}]);

		console.log(chalk.blue('🔨 Creating Monday.com board...'));

		const apiKey = process.env.MONDAY_API_KEY;
		const result = await createTaskMasterBoard(apiKey, projectName.trim());

		console.log(chalk.green(`✅ Board created successfully!`));
		console.log(chalk.cyan(`📋 Board ID: ${result.board.id}`));
		console.log(chalk.cyan(`🔗 Board URL: ${result.board.url}`));
		console.log(chalk.gray(`   Columns: ${result.schema.columnsCreated.length} created`));
		console.log(chalk.gray(`   Groups: ${result.schema.groupsCreated.length} created`));

		return {
			success: true,
			boardId: result.board.id,
			board: result.board,
			schema: result.schema
		};

	} catch (error) {
		console.log(chalk.red(`❌ Failed to create board: ${error.message}`));
		return {
			success: false,
			error: error.message
		};
	}
}

/**
 * Shows current configuration
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Display result
 */
async function showCurrentConfiguration(explicitRoot = null) {
	const status = getMondayIntegrationStatus(explicitRoot);
	
	console.log(chalk.blue.bold('\n📋 Current Monday.com Configuration:'));
	console.log(chalk.gray('────────────────────────────────────'));
	console.log(chalk.cyan(`Enabled: ${status.enabled ? '✅ Yes' : '❌ No'}`));
	console.log(chalk.cyan(`Persistence Mode: ${status.config.persistenceMode}`));
	console.log(chalk.cyan(`Board ID: ${status.config.boardId || 'Not set'}`));
	console.log(chalk.cyan(`Workspace ID: ${status.config.workspaceId || 'Not set'}`));
	console.log(chalk.cyan(`Auto Sync: ${status.config.autoSync ? '✅ Enabled' : '❌ Disabled'}`));
	
	if (status.config.autoSync) {
		console.log(chalk.cyan(`Sync Interval: ${status.config.syncInterval} seconds`));
		console.log(chalk.cyan(`Conflict Resolution: ${status.config.conflictResolution}`));
	}
	
	console.log(chalk.cyan(`API Key Available: ${status.apiKeyAvailable ? '✅ Yes' : '❌ No'}`));
	console.log(chalk.cyan(`Configuration Valid: ${status.valid ? '✅ Yes' : '❌ No'}`));

	if (status.errors.length > 0) {
		console.log(chalk.red('\n❌ Configuration Errors:'));
		status.errors.forEach(error => {
			console.log(chalk.red(`   • ${error}`));
		});
	}

	if (status.warnings.length > 0) {
		console.log(chalk.yellow('\n⚠️ Configuration Warnings:'));
		status.warnings.forEach(warning => {
			console.log(chalk.yellow(`   • ${warning}`));
		});
	}

	return {
		success: true,
		status
	};
}

/**
 * Confirms and disables integration
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Disable result
 */
async function confirmAndDisableIntegration(explicitRoot = null) {
	const { confirm } = await inquirer.prompt([{
		type: 'confirm',
		name: 'confirm',
		message: 'Are you sure you want to disable Monday.com integration?',
		default: false
	}]);

	if (!confirm) {
		return { cancelled: true, message: 'Disable operation cancelled' };
	}

	try {
		const result = disableMondayIntegration(explicitRoot);
		console.log(chalk.green('✅ Monday.com integration disabled'));
		console.log(chalk.yellow('📝 Tasks will now be stored locally only'));
		
		return {
			success: true,
			message: 'Monday.com integration disabled successfully'
		};
	} catch (error) {
		console.log(chalk.red(`❌ Failed to disable integration: ${error.message}`));
		return {
			success: false,
			error: error.message
		};
	}
}

/**
 * Tests the Monday.com integration
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Test result
 */
async function testIntegration(explicitRoot = null) {
	console.log(chalk.blue('🧪 Testing Monday.com integration...'));

	try {
		const validation = validateCompleteMondayConfig(explicitRoot);
		
		if (!validation.valid) {
			console.log(chalk.red('❌ Configuration is invalid:'));
			validation.errors.forEach(error => {
				console.log(chalk.red(`   • ${error}`));
			});
			return {
				success: false,
				errors: validation.errors
			};
		}

		if (!isMondayApiKeyAvailable()) {
			console.log(chalk.red('❌ API key not available'));
			return {
				success: false,
				error: 'API key not available'
			};
		}

		// Test API connection
		console.log(chalk.blue('   Testing API connection...'));
		const apiKey = process.env.MONDAY_API_KEY;
		const client = await initializeMondayApiClient(apiKey);
		
		const userInfo = await client.getCurrentUser();
		console.log(chalk.green(`   ✅ Connected as: ${userInfo.data.name}`));

		// Test board access if configured
		const status = getMondayIntegrationStatus(explicitRoot);
		if (status.config.boardId) {
			console.log(chalk.blue('   Testing board access...'));
			const boardSchema = await client.getBoardSchema(status.config.boardId);
			console.log(chalk.green(`   ✅ Board accessible: ${boardSchema.data.name}`));
		}

		console.log(chalk.green('🎉 All tests passed!'));
		
		return {
			success: true,
			message: 'Integration test completed successfully'
		};

	} catch (error) {
		console.log(chalk.red(`❌ Test failed: ${error.message}`));
		return {
			success: false,
			error: error.message
		};
	}
}

/**
 * Quick setup function for non-interactive environments
 * @param {Object} config - Configuration parameters
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Setup result
 */
export async function quickMondaySetup(config, explicitRoot = null) {
	const {
		boardId,
		workspaceId = null,
		persistenceMode = 'monday',
		autoSync = false,
		syncInterval = 300,
		conflictResolution = 'prompt'
	} = config;

	try {
		const result = setupMondayIntegration({
			boardId,
			workspaceId,
			persistenceMode,
			autoSync,
			syncInterval,
			conflictResolution,
			enabled: true
		}, explicitRoot);

		return {
			success: true,
			configuration: result.config,
			message: 'Monday.com integration setup completed'
		};

	} catch (error) {
		return {
			success: false,
			error: error.message
		};
	}
} 