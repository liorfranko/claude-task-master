/**
 * storage/index.js
 * Storage module initialization
 * Registers storage providers with the persistence manager
 */

import persistenceManager from '../persistence-manager.js';
import LocalStorageProvider from './local-storage-provider.js';
import { log } from '../utils.js';

/**
 * Initialize storage providers
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 */
async function initializeStorage(config = {}) {
	try {
		// Register local storage provider
		const localProvider = new LocalStorageProvider(config.local || {});
		persistenceManager.registerProvider('local', localProvider);
		
		log('debug', 'Local storage provider registered');

		// TODO: Register other providers (Monday, hybrid) when implemented
		// const mondayProvider = new MondayStorageProvider(config.monday || {});
		// persistenceManager.registerProvider('monday', mondayProvider);
		
		// const hybridProvider = new HybridStorageProvider(config.hybrid || {});
		// persistenceManager.registerProvider('hybrid', hybridProvider);

		// Initialize the persistence manager
		await persistenceManager.initialize();
		
		log('info', 'Storage providers initialized successfully');
	} catch (error) {
		log('error', 'Failed to initialize storage providers:', error);
		throw error;
	}
}

/**
 * Get the persistence manager instance
 * @returns {PersistenceManager} Persistence manager instance
 */
function getPersistenceManager() {
	return persistenceManager;
}

/**
 * Create a new local storage provider instance
 * @param {Object} config - Configuration for the provider
 * @returns {LocalStorageProvider} Local storage provider instance
 */
function createLocalProvider(config = {}) {
	return new LocalStorageProvider(config);
}

export {
	initializeStorage,
	getPersistenceManager,
	createLocalProvider,
	persistenceManager as default
}; 