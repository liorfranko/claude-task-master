/**
 * persistence-manager.js
 * Unified Persistence Manager for Task Master
 * 
 * This module provides a single interface that automatically routes persistence operations
 * to either local file storage or Monday.com API based on the current configuration.
 */

import { readJSON as readJSONLocal, writeJSON as writeJSONLocal } from './utils.js';
import { log } from './utils.js';
import { getPersistenceMode, getMondayEnabled } from './monday-config-manager.js';
import { mondayPersistence } from './monday-persistence.js';
import { ensureBackwardCompatibility, checkBackwardCompatibility } from './backward-compatibility.js';
import { getConfig } from './config-manager.js';

/**
 * Unified Persistence Manager
 * Provides a single interface for both local file and Monday.com persistence
 */
class PersistenceManager {
	constructor() {
		this.currentMode = 'local'; // Default to local mode
		this.initialized = false;
		this.mondayInitialized = false;
		this.fallbackActive = false;
	}

	/**
	 * Initialize the persistence manager and determine the active mode
	 * @param {string} projectRoot - Project root directory for configuration lookup
	 * @param {Object} session - Optional session object for MCP mode
	 */
	async initialize(projectRoot = null, session = null) {
		try {
			// First, ensure backward compatibility
			const compatibilityCheck = await checkBackwardCompatibility(projectRoot);
			
			// Only perform migration if genuinely needed AND the config doesn't already have Monday settings configured
			if (compatibilityCheck.needsMigration) {
				// Check if Monday configuration is already properly set up
				const config = getConfig(projectRoot);
				const hasMondayConfig = config && config.monday && typeof config.monday === 'object';
				const hasMondaySettings = hasMondayConfig && (
					config.monday.enabled !== undefined ||
					config.monday.boardId ||
					config.monday.persistenceMode
				);
				
				// Only migrate if there's no Monday configuration or it's completely empty/default
				if (!hasMondaySettings) {
					log('info', `Project requires migration from ${compatibilityCheck.state}. Attempting automatic migration...`);
					const migrationResult = await ensureBackwardCompatibility(projectRoot, { autoMigrate: true, backup: true });
					
					if (migrationResult.success) {
						log('success', `Migration completed successfully: ${migrationResult.message}`);
					} else {
						log('warn', `Migration failed: ${migrationResult.message}. Falling back to local mode.`);
						this.currentMode = 'local';
						this.initialized = true;
						return { success: true, mode: this.currentMode, migrationAttempted: true, migrationFailed: true };
					}
				} else {
					log('info', 'Monday configuration already exists, skipping automatic migration');
				}
			}
			
			// Determine persistence mode from configuration
			this.currentMode = getPersistenceMode(projectRoot);
			
			// If Monday.com mode is selected, ensure it's properly enabled and initialized
			if (this.currentMode === 'monday' || this.currentMode === 'hybrid') {
				if (!getMondayEnabled(projectRoot)) {
					log('warn', 'Monday.com persistence mode selected but not enabled. Falling back to local mode.');
					this.currentMode = 'local';
					this.fallbackActive = true;
				} else {
					try {
						await mondayPersistence.initialize();
						this.mondayInitialized = true;
						log('info', `Persistence manager initialized in ${this.currentMode} mode`);
					} catch (error) {
						log('warn', `Monday.com initialization failed: ${error.message}. Falling back to local mode.`);
						this.currentMode = 'local';
						this.fallbackActive = true;
					}
				}
			}
			
			this.initialized = true;
			return { 
				success: true, 
				mode: this.currentMode, 
				fallbackActive: this.fallbackActive,
				mondayInitialized: this.mondayInitialized,
				compatible: compatibilityCheck.compatible
			};
			
		} catch (error) {
			log('error', `Persistence manager initialization failed: ${error.message}`);
			// Fallback to local mode in case of any issues
			this.currentMode = 'local';
			this.fallbackActive = true;
			this.initialized = true;
			return { 
				success: false, 
				mode: this.currentMode, 
				error: error.message,
				fallbackActive: true
			};
		}
	}

	/**
	 * Read tasks data using the appropriate persistence layer
	 * @param {string} tasksPath - Path to tasks file (for local mode) or board reference (for Monday mode)
	 * @param {Object} options - Additional options like projectRoot and session
	 * @returns {Object|null} Tasks data or null if not found
	 */
	async readTasks(tasksPath, options = {}) {
		if (!this.initialized) {
			await this.initialize(options.projectRoot, options.session);
		}

		try {
			switch (this.currentMode) {
				case 'monday':
					if (this.mondayInitialized) {
						try {
							const result = await mondayPersistence.readTasks(tasksPath, options);
							if (result) {
								return result;
							}
							// If Monday.com read fails, fall back to local mode automatically
							log('warn', 'Monday.com read failed, falling back to local storage');
							this.fallbackActive = true;
							return await this._readLocal(tasksPath, options);
						} catch (error) {
							log('warn', `Monday.com read error: ${error.message}. Falling back to local storage.`);
							this.fallbackActive = true;
							return await this._readLocal(tasksPath, options);
						}
					}
					// Monday not initialized, fall back to local
					return await this._readLocal(tasksPath, options);

				case 'hybrid':
					// Try Monday.com first, fall back to local on failure
					if (this.mondayInitialized) {
						try {
							const mondayResult = await mondayPersistence.readTasks(tasksPath, options);
							if (mondayResult) {
								return mondayResult;
							}
						} catch (error) {
							log('warn', `Monday.com read failed in hybrid mode: ${error.message}. Using local storage.`);
						}
					}
					return await this._readLocal(tasksPath, options);

				case 'local':
				default:
					return await this._readLocal(tasksPath, options);
			}
		} catch (error) {
			log('error', `Read operation failed: ${error.message}`);
			
			// Ultimate fallback to local mode if all else fails
			if (this.currentMode !== 'local') {
				log('warn', 'Attempting emergency fallback to local storage');
				try {
					return await this._readLocal(tasksPath, options);
				} catch (fallbackError) {
					log('error', `Fallback read failed: ${fallbackError.message}`);
					return null;
				}
			}
			return null;
		}
	}

	/**
	 * Write tasks data using the appropriate persistence layer
	 * @param {string} tasksPath - Path to tasks file (for local mode) or board reference (for Monday mode)
	 * @param {Object} data - Tasks data to write
	 * @param {Object} options - Additional options like projectRoot and session
	 * @returns {boolean} Success status
	 */
	async writeTasks(tasksPath, data, options = {}) {
		if (!this.initialized) {
			await this.initialize(options.projectRoot, options.session);
		}

		try {
			switch (this.currentMode) {
				case 'monday':
					if (this.mondayInitialized) {
						try {
							const result = await mondayPersistence.writeTasks(tasksPath, data, options);
							if (result) {
								return true;
							}
							// If Monday.com write fails, fall back to local mode
							log('warn', 'Monday.com write failed, falling back to local storage');
							this.fallbackActive = true;
							return await this._writeLocal(tasksPath, data, options);
						} catch (error) {
							log('warn', `Monday.com write error: ${error.message}. Falling back to local storage.`);
							this.fallbackActive = true;
							return await this._writeLocal(tasksPath, data, options);
						}
					}
					// Monday not initialized, fall back to local
					return await this._writeLocal(tasksPath, data, options);

				case 'hybrid':
					// Try to write to both Monday.com and local
					let mondaySuccess = false;
					let localSuccess = false;

					// Try Monday.com first
					if (this.mondayInitialized) {
						try {
							mondaySuccess = await mondayPersistence.writeTasks(tasksPath, data, options);
						} catch (error) {
							log('warn', `Monday.com write failed in hybrid mode: ${error.message}`);
						}
					}

					// Always write to local in hybrid mode
					try {
						localSuccess = await this._writeLocal(tasksPath, data, options);
					} catch (error) {
						log('error', `Local write failed in hybrid mode: ${error.message}`);
					}

					// Succeed if at least one write succeeded
					return mondaySuccess || localSuccess;

				case 'local':
				default:
					return await this._writeLocal(tasksPath, data, options);
			}
		} catch (error) {
			log('error', `Write operation failed: ${error.message}`);
			
			// Ultimate fallback to local mode if all else fails
			if (this.currentMode !== 'local') {
				log('warn', 'Attempting emergency fallback to local storage for write');
				try {
					return await this._writeLocal(tasksPath, data, options);
				} catch (fallbackError) {
					log('error', `Fallback write failed: ${fallbackError.message}`);
					return false;
				}
			}
			return false;
		}
	}

	/**
	 * Get the current persistence mode and status
	 * @returns {Object} Current status information
	 */
	getStatus() {
		return {
			mode: this.currentMode,
			initialized: this.initialized,
			mondayInitialized: this.mondayInitialized,
			fallbackActive: this.fallbackActive,
			available: {
				local: true, // Local is always available
				monday: this.mondayInitialized
			}
		};
	}

	/**
	 * Force a mode switch (for testing or emergency scenarios)
	 * @param {string} newMode - New persistence mode
	 * @param {string} projectRoot - Project root for reinitializing
	 * @param {Object} session - Session object
	 */
	async forceMode(newMode, projectRoot = null, session = null) {
		log('info', `Forcing persistence mode switch from ${this.currentMode} to ${newMode}`);
		this.currentMode = newMode;
		this.initialized = false;
		this.mondayInitialized = false;
		this.fallbackActive = false;
		
		return await this.initialize(projectRoot, session);
	}

	/**
	 * Test connectivity for a specific persistence mode
	 * @param {string} mode - Mode to test
	 * @param {string} projectRoot - Project root
	 * @param {Object} session - Session object
	 * @returns {Object} Test results
	 */
	async testMode(mode, projectRoot = null, session = null) {
		const testResults = {
			mode,
			available: false,
			canRead: false,
			canWrite: false,
			error: null,
			latency: null
		};

		const startTime = Date.now();

		try {
			if (mode === 'local') {
				// Test local file operations
				testResults.available = true;
				testResults.canRead = true;
				testResults.canWrite = true; // Assuming local filesystem is writable
			} else if (mode === 'monday' || mode === 'hybrid') {
				// Test Monday.com connectivity
				if (!getMondayEnabled(projectRoot)) {
					testResults.error = 'Monday.com integration is not enabled';
				} else {
					try {
						await mondayPersistence.initialize();
						testResults.available = true;
						
						// Test basic connectivity (this would need to be implemented in monday-persistence)
						// For now, assume if initialization succeeds, read/write are available
						testResults.canRead = true;
						testResults.canWrite = true;
					} catch (error) {
						testResults.error = error.message;
					}
				}
			}
		} catch (error) {
			testResults.error = error.message;
		}

		testResults.latency = Date.now() - startTime;
		return testResults;
	}

	/**
	 * Private method for local file reading
	 * @private
	 */
	async _readLocal(tasksPath, options = {}) {
		try {
			return readJSONLocal(tasksPath);
		} catch (error) {
			// Handle backward compatibility for legacy task file locations
			if (tasksPath.includes('tasks/tasks.json')) {
				const legacyPath = tasksPath.replace('tasks/tasks.json', 'tasks.json');
				try {
					log('info', 'Trying legacy tasks.json location for backward compatibility');
					return readJSONLocal(legacyPath);
				} catch (legacyError) {
					// Both modern and legacy paths failed
					throw error; // Throw the original error
				}
			}
			throw error;
		}
	}

	/**
	 * Private method for local file writing
	 * @private
	 */
	async _writeLocal(tasksPath, data, options = {}) {
		try {
			writeJSONLocal(tasksPath, data);
			return true;
		} catch (error) {
			log('error', `Local file write failed: ${error.message}`);
			return false;
		}
	}
}

// Export singleton instance
export const persistenceManager = new PersistenceManager();

// Export convenient wrapper functions that match the existing readJSON/writeJSON interface
export async function readJSON(tasksPath, options = {}) {
	const result = await persistenceManager.readTasks(tasksPath, options);
	
	// For backward compatibility, return the data in the same format as the original readJSON
	// Monday.com persistence returns { tasks: [], metadata: {} }
	// Local persistence returns the raw data or null
	if (result && result.tasks) {
		return result; // Monday.com format
	} else if (result) {
		return result; // Local format
	} else {
		return null; // Error case
	}
}

export async function writeJSON(tasksPath, data, options = {}) {
	return await persistenceManager.writeTasks(tasksPath, data, options);
}

// Export the manager for advanced usage
export { PersistenceManager }; 