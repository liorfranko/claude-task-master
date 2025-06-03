/**
 * storage/index.js
 * Storage module initialization
 * Registers storage providers with the persistence manager
 */

import persistenceManager from '../persistence-manager.js';
import LocalStorageProvider from './local-storage-provider.js';
import MondayStorageProvider from './monday-storage-provider.js';
import HybridStorageProvider from './hybrid-storage-provider.js';
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

		// Register Monday storage provider
		const mondayProvider = new MondayStorageProvider(config.monday || {});
		persistenceManager.registerProvider('monday', mondayProvider);
		
		log('debug', 'Monday storage provider registered');

		// Register hybrid storage provider
		const hybridProvider = new HybridStorageProvider(config.hybrid || {}, persistenceManager);
		persistenceManager.registerProvider('hybrid', hybridProvider);
		
		log('debug', 'Hybrid storage provider registered');

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

/**
 * Create a new Monday storage provider instance
 * @param {Object} config - Configuration for the provider
 * @returns {MondayStorageProvider} Monday storage provider instance
 */
function createMondayProvider(config = {}) {
	return new MondayStorageProvider(config);
}

/**
 * Create a new hybrid storage provider instance
 * @param {Object} config - Configuration for the provider
 * @param {Object} persistenceManager - Persistence manager instance
 * @returns {HybridStorageProvider} Hybrid storage provider instance
 */
function createHybridProvider(config = {}, persistenceManager) {
	return new HybridStorageProvider(config, persistenceManager);
}

export {
	initializeStorage,
	getPersistenceManager,
	createLocalProvider,
	createMondayProvider,
	createHybridProvider,
	persistenceManager as default
}; 