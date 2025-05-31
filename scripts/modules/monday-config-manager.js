/**
 * monday-config-manager.js
 * Monday.com Configuration Management Module
 * 
 * This module handles Monday.com specific configuration settings, validation,
 * and secure credential management for Task Master.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { log, resolveEnvVariable, findProjectRoot } from './utils.js';
import { getConfig, writeConfig, ConfigurationError } from './config-manager.js';

// Monday.com integration configuration defaults
export const MONDAY_DEFAULTS = {
	enabled: false,
	boardId: null,
	workspaceId: null,
	persistenceMode: 'local', // 'local', 'monday', 'hybrid'
	autoSync: false,
	syncInterval: 300, // 5 minutes in seconds
	conflictResolution: 'prompt', // 'local', 'monday', 'prompt', 'newest'
	fallbackToLocal: true,
	cacheEnabled: true,
	retryAttempts: 3,
	timeout: 30000, // 30 seconds
	columnMapping: {
		// Maps Task Master fields to Monday.com column IDs (set during board setup)
		task_id: null,
		title: 'name', // Built-in Monday.com name column
		description: null,
		status: null,
		priority: null,
		dependencies: null,
		parent_task: null,
		details: null,
		test_strategy: null,
		task_type: null,
		complexity_score: null,
		created_by: null,
		assigned_to: null
	},
	groupMapping: {
		// Maps Task Master task states to Monday.com group IDs (set during board setup)
		pending: null,
		in_progress: null,
		completed: null,
		blocked: null,
		subtasks: null
	}
};

/**
 * Validates Monday.com configuration
 * @param {Object} mondayConfig - Monday.com configuration object
 * @returns {Object} Validation result with valid flag and errors array
 */
export function validateMondayConfig(mondayConfig) {
	const validation = {
		valid: true,
		errors: [],
		warnings: []
	};

	if (!mondayConfig) {
		validation.errors.push('Monday.com configuration is missing');
		validation.valid = false;
		return validation;
	}

	// Check persistence mode
	const validModes = ['local', 'monday', 'hybrid'];
	if (!validModes.includes(mondayConfig.persistenceMode)) {
		validation.errors.push(`Invalid persistence mode: ${mondayConfig.persistenceMode}. Must be one of: ${validModes.join(', ')}`);
		validation.valid = false;
	}

	// Check conflict resolution
	const validResolutions = ['local', 'monday', 'prompt', 'newest'];
	if (!validResolutions.includes(mondayConfig.conflictResolution)) {
		validation.errors.push(`Invalid conflict resolution: ${mondayConfig.conflictResolution}. Must be one of: ${validResolutions.join(', ')}`);
		validation.valid = false;
	}

	// Check sync interval
	if (mondayConfig.syncInterval < 60) {
		validation.warnings.push('Sync interval less than 60 seconds may cause rate limiting issues');
	}

	// Check timeout
	if (mondayConfig.timeout < 5000) {
		validation.warnings.push('Timeout less than 5 seconds may cause reliability issues');
	}

	// Check retry attempts
	if (mondayConfig.retryAttempts > 10) {
		validation.warnings.push('More than 10 retry attempts may cause excessive delays');
	}

	// Check if enabled but missing required fields
	if (mondayConfig.enabled && mondayConfig.persistenceMode !== 'local') {
		if (!mondayConfig.boardId) {
			validation.errors.push('boardId is required when Monday.com integration is enabled');
			validation.valid = false;
		}

		// Check API key availability
		const apiKey = resolveEnvVariable('MONDAY_API_KEY');
		if (!apiKey) {
			validation.errors.push('MONDAY_API_KEY environment variable is required when Monday.com integration is enabled');
			validation.valid = false;
		}
	}

	return validation;
}

/**
 * Migrates old configuration format to new format with Monday.com support
 * @param {Object} config - Configuration object to migrate
 * @returns {Object} Migrated configuration object
 */
export function migrateMondayConfig(config) {
	const migrated = { ...config };

	// Add Monday.com configuration if missing
	if (!migrated.monday) {
		migrated.monday = { ...MONDAY_DEFAULTS };
		log('[CONFIG] Added Monday.com integration settings to configuration', 'info');
	} else {
		// Ensure all Monday.com defaults are present
		migrated.monday = { ...MONDAY_DEFAULTS, ...migrated.monday };
	}

	// Migrate column mapping if needed
	if (!migrated.monday.columnMapping) {
		migrated.monday.columnMapping = { ...MONDAY_DEFAULTS.columnMapping };
	}

	// Migrate group mapping if needed
	if (!migrated.monday.groupMapping) {
		migrated.monday.groupMapping = { ...MONDAY_DEFAULTS.groupMapping };
	}

	// Add config version for future migrations
	if (!migrated.configVersion) {
		migrated.configVersion = '2.0.0';
	}

	return migrated;
}

/**
 * Gets Monday.com configuration settings.
 * @param {string|null} explicitRoot - Optional explicit path to the project root.
 * @returns {object} Monday.com configuration object.
 */
export function getMondayConfig(explicitRoot = null) {
	const config = getConfig(explicitRoot);
	if (!config.monday) {
		// Apply migration to add Monday.com config
		const migratedConfig = migrateMondayConfig(config);
		try {
			writeConfig(migratedConfig, explicitRoot);
		} catch (error) {
			log(`[WARN] Could not save migrated configuration: ${error.message}`, 'warn');
		}
		return migratedConfig.monday;
	}
	return config.monday;
}

export function getMondayEnabled(explicitRoot = null) {
	return getMondayConfig(explicitRoot).enabled || false;
}

export function getMondayBoardId(explicitRoot = null) {
	return getMondayConfig(explicitRoot).boardId;
}

export function getMondayWorkspaceId(explicitRoot = null) {
	return getMondayConfig(explicitRoot).workspaceId;
}

export function getPersistenceMode(explicitRoot = null) {
	return getMondayConfig(explicitRoot).persistenceMode || 'local';
}

export function getMondayAutoSync(explicitRoot = null) {
	return getMondayConfig(explicitRoot).autoSync || false;
}

export function getMondaySyncInterval(explicitRoot = null) {
	return getMondayConfig(explicitRoot).syncInterval || 300;
}

export function getMondayConflictResolution(explicitRoot = null) {
	return getMondayConfig(explicitRoot).conflictResolution || 'prompt';
}

export function getMondayFallbackToLocal(explicitRoot = null) {
	return getMondayConfig(explicitRoot).fallbackToLocal !== false;
}

export function getMondayCacheEnabled(explicitRoot = null) {
	return getMondayConfig(explicitRoot).cacheEnabled !== false;
}

export function getMondayRetryAttempts(explicitRoot = null) {
	return getMondayConfig(explicitRoot).retryAttempts || 3;
}

export function getMondayTimeout(explicitRoot = null) {
	return getMondayConfig(explicitRoot).timeout || 30000;
}

export function getMondayColumnMapping(explicitRoot = null) {
	return getMondayConfig(explicitRoot).columnMapping || MONDAY_DEFAULTS.columnMapping;
}

export function getMondayGroupMapping(explicitRoot = null) {
	return getMondayConfig(explicitRoot).groupMapping || MONDAY_DEFAULTS.groupMapping;
}

/**
 * Checks if Monday.com API key is available
 * @param {Object} session - Optional session object with environment variables
 * @returns {boolean} True if API key is available
 */
export function isMondayApiKeyAvailable(session = null) {
	const apiKey = resolveEnvVariable('MONDAY_API_KEY', session?.env);
	return !!apiKey;
}

/**
 * Gets Monday.com API key from environment
 * @param {Object} session - Optional session object with environment variables
 * @returns {string|null} API key or null if not found
 */
export function getMondayApiKey(session = null) {
	return resolveEnvVariable('MONDAY_API_KEY', session?.env);
}

/**
 * Validates the complete Monday.com configuration
 * @param {string|null} explicitRoot - Optional explicit path to the project root.
 * @param {Object} session - Optional session object with environment variables
 * @returns {Object} Validation result
 */
export function validateCompleteMondayConfig(explicitRoot = null, session = null) {
	const mondayConfig = getMondayConfig(explicitRoot);
	const validation = validateMondayConfig(mondayConfig);

	// Additional checks for environment
	if (mondayConfig.enabled && mondayConfig.persistenceMode !== 'local') {
		if (!isMondayApiKeyAvailable(session)) {
			validation.errors.push('MONDAY_API_KEY environment variable is not set');
			validation.valid = false;
		}
	}

	return validation;
}

/**
 * Updates Monday.com configuration settings
 * @param {Object} updates - Configuration updates to apply
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Updated configuration
 */
export function updateMondayConfig(updates, explicitRoot = null) {
	const config = getConfig(explicitRoot);
	
	// Ensure Monday.com config exists
	if (!config.monday) {
		config.monday = { ...MONDAY_DEFAULTS };
	}

	// Apply updates
	config.monday = { ...config.monday, ...updates };

	// Validate the updated configuration
	const validation = validateMondayConfig(config.monday);
	if (!validation.valid) {
		throw new ConfigurationError(`Invalid Monday.com configuration: ${validation.errors.join(', ')}`);
	}

	// Write the updated configuration
	writeConfig(config, explicitRoot);
	
	log('[CONFIG] Monday.com configuration updated successfully', 'success');
	return config.monday;
}

/**
 * Sets up Monday.com integration with guided configuration
 * @param {Object} options - Setup options
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Setup result
 */
export function setupMondayIntegration(options = {}, explicitRoot = null) {
	const {
		boardId,
		workspaceId = null,
		persistenceMode = 'monday',
		autoSync = false,
		syncInterval = 300,
		conflictResolution = 'prompt',
		enabled = true
	} = options;

	// Validate required parameters
	if (!boardId) {
		throw new ConfigurationError('boardId is required for Monday.com integration setup');
	}

	if (!isMondayApiKeyAvailable()) {
		throw new ConfigurationError('MONDAY_API_KEY environment variable is required for Monday.com integration');
	}

	// Create configuration update
	const mondayConfig = {
		enabled,
		boardId,
		workspaceId,
		persistenceMode,
		autoSync,
		syncInterval,
		conflictResolution,
		fallbackToLocal: true,
		cacheEnabled: true,
		retryAttempts: 3,
		timeout: 30000,
		columnMapping: { ...MONDAY_DEFAULTS.columnMapping },
		groupMapping: { ...MONDAY_DEFAULTS.groupMapping }
	};

	// Update configuration
	const updatedConfig = updateMondayConfig(mondayConfig, explicitRoot);

	return {
		success: true,
		config: updatedConfig,
		message: 'Monday.com integration setup completed successfully'
	};
}

/**
 * Disables Monday.com integration and switches to local mode
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Result of disabling integration
 */
export function disableMondayIntegration(explicitRoot = null) {
	const updates = {
		enabled: false,
		persistenceMode: 'local'
	};

	const updatedConfig = updateMondayConfig(updates, explicitRoot);

	return {
		success: true,
		config: updatedConfig,
		message: 'Monday.com integration disabled, switched to local persistence'
	};
}

/**
 * Updates column mapping after board schema setup
 * @param {Object} columnMapping - Column ID mapping
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Updated configuration
 */
export function updateColumnMapping(columnMapping, explicitRoot = null) {
	const mondayConfig = getMondayConfig(explicitRoot);
	const updates = {
		columnMapping: { ...mondayConfig.columnMapping, ...columnMapping }
	};

	return updateMondayConfig(updates, explicitRoot);
}

/**
 * Updates group mapping after board schema setup
 * @param {Object} groupMapping - Group ID mapping
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Updated configuration
 */
export function updateGroupMapping(groupMapping, explicitRoot = null) {
	const mondayConfig = getMondayConfig(explicitRoot);
	const updates = {
		groupMapping: { ...mondayConfig.groupMapping, ...groupMapping }
	};

	return updateMondayConfig(updates, explicitRoot);
}

/**
 * Gets a summary of Monday.com integration status
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @param {Object} session - Optional session object with environment variables
 * @returns {Object} Integration status summary
 */
export function getMondayIntegrationStatus(explicitRoot = null, session = null) {
	const mondayConfig = getMondayConfig(explicitRoot);
	const validation = validateCompleteMondayConfig(explicitRoot, session);
	const apiKeyAvailable = isMondayApiKeyAvailable(session);

	return {
		enabled: mondayConfig.enabled,
		persistenceMode: mondayConfig.persistenceMode,
		apiKeyAvailable,
		boardConfigured: !!mondayConfig.boardId,
		valid: validation.valid,
		errors: validation.errors,
		warnings: validation.warnings,
		config: mondayConfig
	};
}

/**
 * Configuration wizard helper that guides users through Monday.com setup
 * @param {Object} userInputs - User provided inputs
 * @param {string|null} explicitRoot - Optional explicit path to the project root
 * @returns {Object} Wizard result
 */
export function mondayConfigurationWizard(userInputs = {}, explicitRoot = null) {
	const steps = [];
	const errors = [];

	// Step 1: Check API key
	if (!isMondayApiKeyAvailable()) {
		errors.push('Please set MONDAY_API_KEY environment variable');
		steps.push({
			step: 'api_key',
			required: true,
			instruction: 'Add MONDAY_API_KEY to your .env file or environment variables',
			example: 'MONDAY_API_KEY=your_monday_api_key_here'
		});
	} else {
		steps.push({
			step: 'api_key',
			status: 'completed',
			message: 'API key found'
		});
	}

	// Step 2: Board setup
	if (!userInputs.boardId) {
		steps.push({
			step: 'board_setup',
			required: true,
			instruction: 'Provide your Monday.com board ID',
			hint: 'You can create a new board or use an existing one'
		});
	} else {
		steps.push({
			step: 'board_setup',
			status: 'completed',
			boardId: userInputs.boardId
		});
	}

	// Step 3: Configuration preferences
	if (!userInputs.configurationComplete) {
		steps.push({
			step: 'configuration',
			required: false,
			options: {
				persistenceMode: {
					description: 'Choose persistence mode',
					options: ['local', 'monday', 'hybrid'],
					default: 'monday'
				},
				autoSync: {
					description: 'Enable automatic synchronization',
					type: 'boolean',
					default: false
				},
				conflictResolution: {
					description: 'How to handle conflicts',
					options: ['local', 'monday', 'prompt', 'newest'],
					default: 'prompt'
				}
			}
		});
	}

	return {
		completed: errors.length === 0 && userInputs.boardId && userInputs.configurationComplete,
		steps,
		errors,
		canProceed: errors.length === 0 && userInputs.boardId
	};
}

/**
 * Exports environment variables template for Monday.com integration
 * @returns {string} Environment variables template
 */
export function getMondayEnvTemplate() {
	return `
# Monday.com Integration
MONDAY_API_KEY=your_monday_api_key_here
MONDAY_WORKSPACE_ID=your_workspace_id_here (optional)

# To get your API key:
# 1. Go to https://monday.com
# 2. Click on your profile picture (bottom left)
# 3. Select "Admin" -> "API"
# 4. Generate a new API token
# 5. Copy the token and paste it above
`.trim();
} 