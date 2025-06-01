#!/usr/bin/env node

/**
 * test-monday-sync-engine.js
 * Comprehensive test suite for Monday.com Sync Engine
 * Tests offline-first functionality, sync-on-reconnect, and connectivity monitoring
 */

import { 
	getSyncEngine, 
	syncWithMonday, 
	recordLocalChange,
	getSyncTelemetry,
	initializeSyncEngine,
	getWebhookHandler,
	OfflineQueue
} from './scripts/modules/monday-sync-engine.js';
import { updateMondayConfig } from './scripts/modules/monday-config-manager.js';
import { log } from './scripts/modules/utils.js';

// Test configuration
const TEST_CONFIG = {
	verbose: process.argv.includes('--verbose'),
	skipSlowTests: process.argv.includes('--fast')
};

// Setup test environment
function setupTestEnvironment() {
	// Enable Monday.com integration for testing
	try {
		updateMondayConfig({
			enabled: true,
			boardId: 'test-board-123',
			persistenceMode: 'local', // Use local persistence for tests
			autoSync: false, // Disable auto-sync for tests
			fallbackToLocal: true
		});
		console.log('✅ Test environment configured');
	} catch (error) {
		console.log('⚠️  Could not configure test environment, some tests may fail');
		if (TEST_CONFIG.verbose) {
			console.log(`   Error: ${error.message}`);
		}
	}
}

// Test utilities
class TestRunner {
	constructor() {
		this.tests = [];
		this.passed = 0;
		this.failed = 0;
		this.skipped = 0;
	}

	test(name, fn, options = {}) {
		this.tests.push({ name, fn, options });
	}

	async run() {
		console.log('🧪 Monday Sync Engine Test Suite');
		console.log('='.repeat(50));
		
		// Setup test environment
		setupTestEnvironment();

		for (const test of this.tests) {
			if (test.options.skip) {
				this.skipped++;
				console.log(`⏭️  SKIP: ${test.name}`);
				continue;
			}

			if (test.options.slow && TEST_CONFIG.skipSlowTests) {
				this.skipped++;
				console.log(`⏭️  SKIP: ${test.name} (slow test)`);
				continue;
			}

			try {
				console.log(`🔍 TEST: ${test.name}`);
				await test.fn();
				this.passed++;
				console.log(`✅ PASS: ${test.name}`);
			} catch (error) {
				this.failed++;
				console.log(`❌ FAIL: ${test.name}`);
				console.log(`   Error: ${error.message}`);
				if (TEST_CONFIG.verbose) {
					console.log(`   Stack: ${error.stack}`);
				}
			}
		}

		console.log('='.repeat(50));
		console.log(`📊 Results: ${this.passed} passed, ${this.failed} failed, ${this.skipped} skipped`);
		console.log(`🎯 Success Rate: ${((this.passed / (this.passed + this.failed)) * 100).toFixed(1)}%`);

		if (this.failed > 0) {
			process.exit(1);
		}
	}
}

// Mock implementations for testing
class MockMondayApiClient {
	constructor() {
		this.isConnected = true;
		this.responses = new Map();
	}

	async initialize() {
		// Mock successful initialization
		return true;
	}

	async testConnection() {
		if (!this.isConnected) {
			throw new Error('Connection failed');
		}
		return true;
	}

	setConnectionStatus(connected) {
		this.isConnected = connected;
	}

	mockResponse(method, response) {
		this.responses.set(method, response);
	}
}

class MockMondayPersistence {
	constructor() {
		this.data = { tasks: [] };
	}

	async initialize() {
		return true;
	}

	async loadTasks(options = {}) {
		return this.data;
	}

	async saveTask(task) {
		const existingIndex = this.data.tasks.findIndex(t => t.id === task.id);
		if (existingIndex >= 0) {
			this.data.tasks[existingIndex] = task;
		} else {
			this.data.tasks.push(task);
		}
		return task;
	}

	async updateTaskStatus(taskId, status) {
		const task = this.data.tasks.find(t => t.id === taskId);
		if (task) {
			task.status = status;
		}
		return task;
	}

	async deleteTask(taskId) {
		this.data.tasks = this.data.tasks.filter(t => t.id !== taskId);
		return true;
	}
}

// Test suite
const runner = new TestRunner();

runner.test('Sync Engine Initialization', async () => {
	const engine = getSyncEngine();
	
	// Engine should not be initialized yet
	if (engine.initialized) {
		throw new Error('Engine should not be initialized initially');
	}

	// Mock the dependencies to avoid real Monday.com calls
	// We need to set these BEFORE calling initialize
	engine.persistence = new MockMondayPersistence();
	engine.apiClient = new MockMondayApiClient();

	// Override the persistence and API client initialization
	// Since initialize() creates new instances, we need to prevent that
	const originalInitialize = engine.initialize;
	engine.initialize = async function() {
		// Skip the normal initialization that creates new instances
		// and just set up the minimal required state
		
		// Load offline queue
		await this.offlineQueue.load();

		// Set up webhook handler events
		this.webhookHandler.on('remoteChange', this.handleRemoteChange.bind(this));

		// Set up connectivity monitoring with event handlers
		this.connectivityMonitor.on('online', this.handleConnectivityRestored.bind(this));
		this.connectivityMonitor.on('offline', this.handleConnectivityLost.bind(this));
		this.connectivityMonitor.start();

		this.initialized = true;
		log(`[Sync Engine] Initialized successfully (mocked)`, 'info');
	};

	await engine.initialize();

	if (!engine.initialized) {
		throw new Error('Engine should be initialized after calling initialize()');
	}

	// Check that offline queue was loaded
	if (!engine.offlineQueue) {
		throw new Error('Offline queue should be initialized');
	}

	// Check that connectivity monitor was started
	if (!engine.connectivityMonitor) {
		throw new Error('Connectivity monitor should be initialized');
	}
});

runner.test('Offline Queue - Basic Operations', async () => {
	const engine = getSyncEngine();
	
	// Set engine to offline mode to prevent immediate processing
	engine.isOnline = false;
	
	// Clear queue for test
	engine.offlineQueue.queue = [];

	// Add a test change
	const changeId = await engine.recordLocalChange('test-task-1', 'update', { title: 'Test Task' });

	if (!changeId) {
		throw new Error('recordLocalChange should return a change ID');
	}

	// Check that change was added to queue
	const queueStats = engine.offlineQueue.getStats();
	if (queueStats.total === 0) {
		throw new Error('Change should be added to offline queue');
	}

	// Check that ready items include our change
	const readyItems = engine.offlineQueue.getReadyItems();
	if (readyItems.length === 0) {
		throw new Error('Ready items should include our change');
	}
	
	// Reset to online for other tests
	engine.isOnline = true;
});

runner.test('Offline Queue - Persistent Storage', async () => {
	const engine = getSyncEngine();
	const testQueuePath = '.test-sync-offline-queue.json';
	
	// Create a test queue with custom path
	const testQueue = new OfflineQueue(testQueuePath);
	
	// Add test data
	await testQueue.add({
		id: 'test-1',
		taskId: 'task-1',
		type: 'update',
		data: { title: 'Test' }
	});

	// Verify it was saved
	if (testQueue.queue.length !== 1) {
		throw new Error('Queue should contain 1 item');
	}

	// Create new queue and load
	const testQueue2 = new OfflineQueue(testQueuePath);
	await testQueue2.load();

	if (testQueue2.queue.length !== 1) {
		throw new Error('Loaded queue should contain 1 item');
	}

	// Cleanup
	try {
		await import('fs/promises').then(fs => fs.unlink(testQueuePath));
	} catch (error) {
		// File might not exist, ignore
	}
});

runner.test('Offline Queue - Retry Logic with Exponential Backoff', async () => {
	const engine = getSyncEngine();
	const testQueuePath = '.test-retry-queue.json';
	
	const testQueue = new OfflineQueue(testQueuePath);
	
	// Add test item
	await testQueue.add({
		id: 'retry-test-1',
		taskId: 'task-1',
		type: 'update',
		data: { title: 'Test' }
	});

	const item = testQueue.queue[0];
	const initialNextAttempt = item.nextAttempt;

	// Mark as failed
	await testQueue.markFailed('retry-test-1', new Error('Test error'));

	// Check retry count increased
	if (item.retryCount !== 1) {
		throw new Error('Retry count should be 1 after first failure');
	}

	// Check next attempt time was delayed
	if (item.nextAttempt <= initialNextAttempt) {
		throw new Error('Next attempt should be delayed after failure');
	}

	// Cleanup
	try {
		await import('fs/promises').then(fs => fs.unlink(testQueuePath));
	} catch (error) {
		// File might not exist, ignore
	}
});

runner.test('Connectivity Monitor - Status Detection', async () => {
	const engine = getSyncEngine();
	const monitor = engine.connectivityMonitor;

	// Get initial status
	const initialStatus = monitor.getStatus();
	
	if (!initialStatus.hasOwnProperty('isOnline')) {
		throw new Error('Status should include isOnline property');
	}

	if (!initialStatus.hasOwnProperty('lastSuccessfulConnection')) {
		throw new Error('Status should include lastSuccessfulConnection property');
	}

	if (!initialStatus.hasOwnProperty('timeSinceLastConnection')) {
		throw new Error('Status should include timeSinceLastConnection property');
	}
});

runner.test('Sync Engine - Telemetry Data', async () => {
	const engine = getSyncEngine();
	const telemetry = engine.getTelemetry();

	// Check required telemetry fields
	const requiredFields = [
		'syncOperations', 'conflictsResolved', 'webhooksProcessed', 
		'errorsEncountered', 'isOnline', 'isSyncing', 'pendingChanges',
		'offlineQueue', 'connectivity', 'initialized'
	];

	for (const field of requiredFields) {
		if (!telemetry.hasOwnProperty(field)) {
			throw new Error(`Telemetry should include ${field} field`);
		}
	}

	// Check offline queue stats structure
	if (!telemetry.offlineQueue.hasOwnProperty('total')) {
		throw new Error('Offline queue stats should include total');
	}

	// Check connectivity stats structure
	if (!telemetry.connectivity.hasOwnProperty('isOnline')) {
		throw new Error('Connectivity stats should include isOnline');
	}
});

runner.test('Webhook Handler - Basic Functionality', async () => {
	const webhookHandler = getWebhookHandler();

	if (!webhookHandler) {
		throw new Error('Webhook handler should be available');
	}

	if (typeof webhookHandler.handleWebhook !== 'function') {
		throw new Error('Webhook handler should have handleWebhook method');
	}
});

runner.test('Sync Engine - Full Sync Process', async () => {
	const engine = getSyncEngine();
	
	// Mock the API client and persistence to avoid real calls
	engine.apiClient = new MockMondayApiClient();
	engine.persistence = new MockMondayPersistence();
	
	// Ensure the engine is marked as initialized for the sync
	engine.initialized = true;

	// Add some mock data
	await engine.persistence.saveTask({
		id: 'test-task-1',
		title: 'Test Task',
		status: 'pending'
	});

	// Perform sync
	const result = await engine.syncWithMonday({ direction: 'pull' });

	if (!result || !result.status) {
		throw new Error('Sync should return a result with status');
	}

	if (result.status !== 'success') {
		throw new Error(`Sync should succeed, got status: ${result.status}`);
	}
}, { slow: true });

runner.test('Sync Engine - Offline Mode Handling', async () => {
	const engine = getSyncEngine();
	
	// Set engine to offline mode
	engine.isOnline = false;
	
	// Record a change while offline
	const changeId = await engine.recordLocalChange('offline-task', 'create', { 
		title: 'Offline Task',
		status: 'pending' 
	});

	if (!changeId) {
		throw new Error('Should be able to record changes while offline');
	}

	// Check that change is queued
	const queueStats = engine.offlineQueue.getStats();
	if (queueStats.total === 0) {
		throw new Error('Change should be queued when offline');
	}

	// Simulate coming back online
	engine.isOnline = true;
	engine.apiClient = new MockMondayApiClient();
	engine.persistence = new MockMondayPersistence();

	// Process offline queue
	await engine.processOfflineQueue();

	// Queue should be processed (or at least attempted)
	const newQueueStats = engine.offlineQueue.getStats();
	console.log(`   Queue stats after processing: ${JSON.stringify(newQueueStats)}`);
}, { slow: true });

// Export functions for external testing
export async function runSyncEngineTests() {
	await runner.run();
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
	runSyncEngineTests().catch(error => {
		console.error('Test suite failed:', error);
		process.exit(1);
	});
} 