/**
 * monday-sync-engine.js
 * Real-time Synchronization Engine for Monday.com Integration
 * 
 * This module handles real-time synchronization between local state and Monday.com,
 * implementing webhook support, offline operations, conflict resolution, change tracking,
 * and comprehensive telemetry for monitoring sync performance.
 */

import { log } from './utils.js';
import { MondayApiClient } from './monday-api-client.js';
import { MondayPersistence } from './monday-persistence.js';
import { 
	getMondayConfig, 
	getMondayAutoSync, 
	getMondaySyncInterval,
	getMondayEnabled,
	getMondayConflictResolution
} from './monday-config-manager.js';
import { 
	transformMondayItemToTask,
	transformTaskToMondayColumns,
	validateTransformedData
} from './monday-data-transformer.js';
import EventEmitter from 'events';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

/**
 * Change tracking system for incremental sync
 */
class ChangeTracker {
	constructor() {
		this.changes = new Map();
		this.lastSync = new Map();
		this.remoteHashes = new Map();
		this.localHashes = new Map();
	}

	/**
	 * Records a local change for sync tracking
	 */
	recordLocalChange(taskId, changeType, data) {
		const changeId = crypto.randomUUID();
		const change = {
			id: changeId,
			taskId,
			type: changeType, // 'create', 'update', 'delete', 'status_change'
			data,
			timestamp: Date.now(),
			synced: false,
			retryCount: 0
		};

		this.changes.set(changeId, change);
		this.updateLocalHash(taskId, data);
		
		log(`[Sync Engine] Recorded local change: ${changeType} for task ${taskId}`, 'debug');
		return changeId;
	}

	/**
	 * Records a remote change from webhook
	 */
	recordRemoteChange(taskId, mondayItemData) {
		const hash = this.calculateHash(mondayItemData);
		this.remoteHashes.set(taskId, { hash, timestamp: Date.now(), data: mondayItemData });
		log(`[Sync Engine] Recorded remote change for task ${taskId}`, 'debug');
	}

	/**
	 * Updates local hash for conflict detection
	 */
	updateLocalHash(taskId, data) {
		const hash = this.calculateHash(data);
		this.localHashes.set(taskId, { hash, timestamp: Date.now(), data });
	}

	/**
	 * Calculates hash for change detection
	 */
	calculateHash(data) {
		return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
	}

	/**
	 * Detects conflicts between local and remote changes
	 */
	detectConflicts() {
		const conflicts = [];
		
		for (const [taskId, remoteData] of this.remoteHashes) {
			const localData = this.localHashes.get(taskId);
			const lastSyncTime = this.lastSync.get(taskId) || 0;
			
			if (localData && remoteData.hash !== localData.hash) {
				// Check if both changes happened after last sync
				if (localData.timestamp > lastSyncTime && remoteData.timestamp > lastSyncTime) {
					conflicts.push({
						taskId,
						localData: localData.data,
						remoteData: remoteData.data,
						localTimestamp: localData.timestamp,
						remoteTimestamp: remoteData.timestamp
					});
				}
			}
		}

		return conflicts;
	}

	/**
	 * Gets pending changes for sync
	 */
	getPendingChanges() {
		return Array.from(this.changes.values()).filter(change => !change.synced);
	}

	/**
	 * Marks a change as synced
	 */
	markSynced(changeId) {
		const change = this.changes.get(changeId);
		if (change) {
			change.synced = true;
			this.lastSync.set(change.taskId, Date.now());
		}
	}

	/**
	 * Clears old synced changes (cleanup)
	 */
	cleanup(maxAge = 24 * 60 * 60 * 1000) { // 24 hours
		const cutoff = Date.now() - maxAge;
		for (const [id, change] of this.changes) {
			if (change.synced && change.timestamp < cutoff) {
				this.changes.delete(id);
			}
		}
	}
}

/**
 * Webhook server for receiving Monday.com events
 */
class WebhookHandler extends EventEmitter {
	constructor(syncEngine) {
		super();
		this.syncEngine = syncEngine;
		this.webhookSecrets = new Map();
		this.pendingChallenges = new Set();
	}

	/**
	 * Handles incoming webhook requests
	 */
	async handleWebhook(req, res) {
		try {
			const body = req.body;
			
			// Handle challenge verification
			if (body.challenge) {
				log(`[Webhook] Challenge received: ${body.challenge}`, 'debug');
				this.pendingChallenges.add(body.challenge);
				res.status(200).json({ challenge: body.challenge });
				return;
			}

			// Verify webhook authenticity if JWT is present
			if (req.headers.authorization) {
				const isValid = this.verifyWebhookSignature(req);
				if (!isValid) {
					log(`[Webhook] Invalid signature received`, 'warn');
					res.status(401).json({ error: 'Invalid signature' });
					return;
				}
			}

			// Process the webhook event
			if (body.event) {
				await this.processWebhookEvent(body.event);
				res.status(200).json({ status: 'processed' });
			} else {
				log(`[Webhook] Invalid webhook payload received`, 'warn');
				res.status(400).json({ error: 'Invalid payload' });
			}

		} catch (error) {
			log(`[Webhook] Error processing webhook: ${error.message}`, 'error');
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * Processes incoming webhook events
	 */
	async processWebhookEvent(event) {
		const { type, boardId, pulseId, pulseName, columnId, value, previousValue } = event;
		
		log(`[Webhook] Processing event: ${type} for item ${pulseId} on board ${boardId}`, 'info');

		// Check if this is our monitored board
		const config = getMondayConfig();
		if (boardId.toString() !== config.boardId.toString()) {
			log(`[Webhook] Ignoring event from unmonitored board ${boardId}`, 'debug');
			return;
		}

		// Extract task ID from Monday.com item
		const taskId = await this.extractTaskId(pulseId, boardId);
		
		// Record the remote change
		this.syncEngine.changeTracker.recordRemoteChange(taskId, {
			mondayItemId: pulseId,
			type,
			columnId,
			value,
			previousValue,
			timestamp: Date.now()
		});

		// Emit sync event
		this.emit('remoteChange', {
			taskId,
			type,
			mondayItemId: pulseId,
			data: { columnId, value, previousValue }
		});

		// Trigger sync if auto-sync is enabled
		if (getMondayAutoSync()) {
			await this.syncEngine.syncWithMonday();
		}
	}

	/**
	 * Extracts task ID from Monday.com item
	 */
	async extractTaskId(mondayItemId, boardId) {
		try {
			// Try to get task from local cache first
			const persistence = new MondayPersistence();
			const tasksData = await persistence.loadTasks({ forceRefresh: false });
			
			// Find task by Monday item ID (stored in metadata or through transformation)
			for (const task of tasksData.tasks) {
				if (task.mondayItemId === mondayItemId.toString()) {
					return task.id;
				}
			}

			// If not found locally, query Monday.com API
			const apiClient = new MondayApiClient();
			const item = await apiClient.getItem(mondayItemId);
			
			// Extract task ID from the task_id column
			const taskIdColumn = item.column_values.find(cv => cv.id === 'task_id');
			if (taskIdColumn) {
				return taskIdColumn.text || taskIdColumn.value;
			}

			log(`[Webhook] Could not extract task ID for Monday item ${mondayItemId}`, 'warn');
			return mondayItemId; // Fallback to Monday item ID

		} catch (error) {
			log(`[Webhook] Error extracting task ID: ${error.message}`, 'error');
			return mondayItemId; // Fallback
		}
	}

	/**
	 * Verifies webhook signature (for integration apps)
	 */
	verifyWebhookSignature(req) {
		// Implementation would verify JWT signature against app signing secret
		// For now, we'll accept all authenticated requests
		return true;
	}
}

/**
 * Persistent offline queue for reliable offline-first operation
 */
class OfflineQueue {
	constructor(queueFilePath = '.sync-offline-queue.json') {
		this.queueFilePath = queueFilePath;
		this.queue = [];
		this.maxRetries = 5;
		this.baseRetryDelay = 1000; // 1 second base delay
	}

	/**
	 * Loads the offline queue from persistent storage
	 */
	async load() {
		try {
			const data = await fs.readFile(this.queueFilePath, 'utf8');
			this.queue = JSON.parse(data);
			log(`[Offline Queue] Loaded ${this.queue.length} items from storage`, 'debug');
		} catch (error) {
			if (error.code !== 'ENOENT') {
				log(`[Offline Queue] Error loading queue: ${error.message}`, 'warn');
			}
			this.queue = [];
		}
	}

	/**
	 * Saves the offline queue to persistent storage
	 */
	async save() {
		try {
			const data = JSON.stringify(this.queue, null, 2);
			await fs.writeFile(this.queueFilePath, data, 'utf8');
			log(`[Offline Queue] Saved ${this.queue.length} items to storage`, 'debug');
		} catch (error) {
			log(`[Offline Queue] Error saving queue: ${error.message}`, 'error');
		}
	}

	/**
	 * Adds a change to the offline queue
	 */
	async add(change) {
		const queueItem = {
			...change,
			queuedAt: Date.now(),
			retryCount: 0,
			lastAttempt: null,
			nextAttempt: Date.now()
		};

		this.queue.push(queueItem);
		await this.save();
		
		log(`[Offline Queue] Added change ${change.type} for task ${change.taskId}`, 'debug');
	}

	/**
	 * Gets items ready for processing (considering retry delays)
	 */
	getReadyItems() {
		const now = Date.now();
		return this.queue.filter(item => 
			item.retryCount < this.maxRetries && 
			item.nextAttempt <= now
		);
	}

	/**
	 * Marks an item as successfully processed
	 */
	async markProcessed(itemId) {
		this.queue = this.queue.filter(item => item.id !== itemId);
		await this.save();
	}

	/**
	 * Marks an item as failed and schedules retry with exponential backoff
	 */
	async markFailed(itemId, error) {
		const item = this.queue.find(q => q.id === itemId);
		if (!item) return;

		item.retryCount++;
		item.lastAttempt = Date.now();
		item.lastError = error.message;

		// Exponential backoff: 1s, 2s, 4s, 8s, 16s
		const delay = this.baseRetryDelay * Math.pow(2, item.retryCount - 1);
		item.nextAttempt = Date.now() + delay;

		if (item.retryCount >= this.maxRetries) {
			log(`[Offline Queue] Item ${itemId} exceeded max retries, removing`, 'error');
			await this.markProcessed(itemId);
		} else {
			log(`[Offline Queue] Item ${itemId} failed, retry ${item.retryCount}/${this.maxRetries} in ${delay}ms`, 'warn');
			await this.save();
		}
	}

	/**
	 * Gets queue statistics
	 */
	getStats() {
		const ready = this.getReadyItems().length;
		const pending = this.queue.filter(item => item.retryCount < this.maxRetries).length;
		const failed = this.queue.filter(item => item.retryCount >= this.maxRetries).length;

		return {
			total: this.queue.length,
			ready,
			pending,
			failed,
			oldestItem: this.queue.length > 0 ? Math.min(...this.queue.map(q => q.queuedAt)) : null
		};
	}

	/**
	 * Clears old failed items from the queue
	 */
	async cleanup(maxAge = 7 * 24 * 60 * 60 * 1000) { // 7 days
		const cutoff = Date.now() - maxAge;
		const originalLength = this.queue.length;
		
		this.queue = this.queue.filter(item => 
			item.queuedAt > cutoff && item.retryCount < this.maxRetries
		);

		if (this.queue.length !== originalLength) {
			await this.save();
			log(`[Offline Queue] Cleaned up ${originalLength - this.queue.length} old items`, 'info');
		}
	}
}

/**
 * Enhanced connectivity monitor with multiple detection methods
 */
class ConnectivityMonitor extends EventEmitter {
	constructor(syncEngine) {
		super();
		this.syncEngine = syncEngine;
		// Check if we're in a browser environment before accessing navigator
		this.isOnline = (typeof navigator !== 'undefined' && navigator?.onLine !== undefined) 
			? navigator.onLine 
			: true; // Default to online in Node.js
		this.lastSuccessfulConnection = Date.now();
		this.connectionCheckInterval = 30000; // 30 seconds
		this.fastCheckInterval = 5000; // 5 seconds when offline
		this.currentInterval = null;
		this.testUrls = [
			'https://api.monday.com/v2',
			'https://www.google.com',
			'https://1.1.1.1' // Cloudflare DNS
		];
	}

	/**
	 * Starts connectivity monitoring
	 */
	start() {
		// Browser-based connectivity detection if available
		if (typeof window !== 'undefined' && window.addEventListener) {
			window.addEventListener('online', this.handleOnline.bind(this));
			window.addEventListener('offline', this.handleOffline.bind(this));
		}

		// Start periodic connectivity checks
		this.startPeriodicChecks();
	}

	/**
	 * Starts periodic connectivity checks
	 */
	startPeriodicChecks() {
		const interval = this.isOnline ? this.connectionCheckInterval : this.fastCheckInterval;
		
		if (this.currentInterval) {
			clearInterval(this.currentInterval);
		}

		this.currentInterval = setInterval(async () => {
			const wasOnline = this.isOnline;
			await this.checkConnectivity();
			
			// If status changed, adjust check frequency
			if (wasOnline !== this.isOnline) {
				this.startPeriodicChecks();
			}
		}, interval);
	}

	/**
	 * Checks connectivity using multiple methods
	 */
	async checkConnectivity() {
		let isConnected = false;

		// Method 1: Test Monday.com API if available
		try {
			if (this.syncEngine.apiClient) {
				await this.syncEngine.apiClient.testConnection();
				isConnected = true;
				this.lastSuccessfulConnection = Date.now();
			}
		} catch (error) {
			// API test failed, try other methods
		}

		// Method 2: Test other endpoints if Monday.com failed
		if (!isConnected) {
			isConnected = await this.testConnectivityWithFallbacks();
		}

		// Update status if changed
		if (isConnected !== this.isOnline) {
			this.isOnline = isConnected;
			
			if (isConnected) {
				log(`[Connectivity] Connection restored`, 'info');
				this.emit('online');
			} else {
				log(`[Connectivity] Connection lost`, 'warn');
				this.emit('offline');
			}
		}

		return isConnected;
	}

	/**
	 * Tests connectivity with fallback URLs
	 */
	async testConnectivityWithFallbacks() {
		// Check if fetch is available (Node.js 18+ or browser)
		const fetchFn = typeof fetch !== 'undefined' ? fetch : null;
		
		if (!fetchFn) {
			// Fallback for older Node.js environments
			try {
				const https = await import('https');
				return await this.testConnectivityWithHttps(https);
			} catch (error) {
				log(`[Connectivity] No fetch or HTTPS available: ${error.message}`, 'warn');
				return false;
			}
		}

		for (const url of this.testUrls) {
			try {
				const response = await fetchFn(url, { 
					method: 'HEAD', 
					timeout: 5000,
					mode: 'no-cors' // Allow cross-origin requests
				});
				
				if (response.ok || response.type === 'opaque') {
					this.lastSuccessfulConnection = Date.now();
					return true;
				}
			} catch (error) {
				// Continue to next URL
			}
		}
		return false;
	}

	/**
	 * Fallback connectivity test using Node.js HTTPS module
	 */
	async testConnectivityWithHttps(https) {
		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(false), 5000);
			
			try {
				const req = https.get('https://www.google.com', (res) => {
					clearTimeout(timeout);
					this.lastSuccessfulConnection = Date.now();
					resolve(true);
				});

				req.on('error', () => {
					clearTimeout(timeout);
					resolve(false);
				});

				req.setTimeout(5000, () => {
					clearTimeout(timeout);
					req.destroy();
					resolve(false);
				});
			} catch (error) {
				clearTimeout(timeout);
				resolve(false);
			}
		});
	}

	/**
	 * Handles browser online event
	 */
	handleOnline() {
		log(`[Connectivity] Browser reported online`, 'debug');
		// Don't immediately trust browser, verify with our own check
		setTimeout(() => this.checkConnectivity(), 1000);
	}

	/**
	 * Handles browser offline event
	 */
	handleOffline() {
		log(`[Connectivity] Browser reported offline`, 'debug');
		this.isOnline = false;
		this.emit('offline');
	}

	/**
	 * Gets connectivity status
	 */
	getStatus() {
		return {
			isOnline: this.isOnline,
			lastSuccessfulConnection: this.lastSuccessfulConnection,
			timeSinceLastConnection: Date.now() - this.lastSuccessfulConnection
		};
	}

	/**
	 * Stops monitoring
	 */
	stop() {
		if (this.currentInterval) {
			clearInterval(this.currentInterval);
			this.currentInterval = null;
		}

		if (typeof window !== 'undefined' && window.removeEventListener) {
			window.removeEventListener('online', this.handleOnline.bind(this));
			window.removeEventListener('offline', this.handleOffline.bind(this));
		}
	}
}

/**
 * Main sync engine class
 */
export class MondaySyncEngine extends EventEmitter {
	constructor() {
		super();
		this.changeTracker = new ChangeTracker();
		this.webhookHandler = new WebhookHandler(this);
		this.persistence = null;
		this.apiClient = null;
		this.syncInterval = null;
		this.isOnline = true;
		this.isSyncing = false;
		this.offlineQueue = new OfflineQueue();
		this.connectivityMonitor = new ConnectivityMonitor(this);
		this.telemetry = {
			syncOperations: 0,
			conflictsResolved: 0,
			webhooksProcessed: 0,
			errorsEncountered: 0,
			lastSync: null,
			averageSyncTime: 0,
			cacheHits: 0,
			cacheMisses: 0
		};
		this.initialized = false;
	}

	/**
	 * Initializes the sync engine
	 */
	async initialize() {
		try {
			if (!getMondayEnabled()) {
				throw new Error('Monday.com integration is not enabled');
			}

			// Initialize persistence layer
			this.persistence = new MondayPersistence();
			await this.persistence.initialize();

			// Initialize API client
			this.apiClient = new MondayApiClient();
			await this.apiClient.initialize();

			// Load offline queue from persistent storage
			await this.offlineQueue.load();

			// Set up webhook handler
			this.webhookHandler.on('remoteChange', this.handleRemoteChange.bind(this));

			// Set up connectivity monitoring with event handlers
			this.connectivityMonitor.on('online', this.handleConnectivityRestored.bind(this));
			this.connectivityMonitor.on('offline', this.handleConnectivityLost.bind(this));
			this.connectivityMonitor.start();

			// Start background sync if auto-sync is enabled
			if (getMondayAutoSync()) {
				this.startBackgroundSync();
			}

			this.initialized = true;
			log(`[Sync Engine] Initialized successfully`, 'info');

		} catch (error) {
			log(`[Sync Engine] Initialization failed: ${error.message}`, 'error');
			throw error;
		}
	}

	/**
	 * Main synchronization function
	 */
	async syncWithMonday(options = {}) {
		const { forceFullSync = false, direction = 'bidirectional' } = options;

		if (!this.initialized) {
			await this.initialize();
		}

		if (this.isSyncing) {
			log(`[Sync Engine] Sync already in progress, skipping`, 'debug');
			return { status: 'already_syncing' };
		}

		this.isSyncing = true;
		const syncStartTime = Date.now();

		try {
			log(`[Sync Engine] Starting synchronization (${direction})`, 'info');
			this.telemetry.syncOperations++;

			// Step 1: Process offline queue if we're online
			if (this.isOnline) {
				await this.processOfflineQueue();
			}

			// Step 2: Detect conflicts
			const conflicts = this.changeTracker.detectConflicts();
			if (conflicts.length > 0) {
				log(`[Sync Engine] Detected ${conflicts.length} conflicts`, 'warn');
				await this.handleConflictResolution(conflicts);
			}

			// Step 3: Process pending local changes (if bidirectional or push)
			if (direction === 'bidirectional' || direction === 'push') {
				await this.pushLocalChanges();
			}

			// Step 4: Pull remote changes (if bidirectional or pull)
			if (direction === 'bidirectional' || direction === 'pull') {
				await this.pullRemoteChanges(forceFullSync);
			}

			// Step 5: Validate data integrity
			const integrityResults = await this.validateDataIntegrity();

			// Update telemetry
			const syncDuration = Date.now() - syncStartTime;
			this.telemetry.lastSync = new Date().toISOString();
			this.telemetry.averageSyncTime = (this.telemetry.averageSyncTime + syncDuration) / 2;

			log(`[Sync Engine] Synchronization completed in ${syncDuration}ms`, 'info');
			this.emit('syncCompleted', { 
				duration: syncDuration, 
				conflicts: conflicts.length,
				integrityResults
			});

			return {
				status: 'success',
				duration: syncDuration,
				conflictsResolved: conflicts.length,
				pendingChanges: this.changeTracker.getPendingChanges().length,
				offlineQueueStats: this.offlineQueue.getStats(),
				integrityResults
			};

		} catch (error) {
			this.telemetry.errorsEncountered++;
			log(`[Sync Engine] Synchronization failed: ${error.message}`, 'error');
			this.emit('syncError', error);
			throw error;
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Handles conflict resolution based on configured strategy
	 */
	async handleConflictResolution(conflicts) {
		const strategy = getMondayConflictResolution();
		
		for (const conflict of conflicts) {
			try {
				log(`[Sync Engine] Resolving conflict for task ${conflict.taskId} using strategy: ${strategy}`, 'info');

				let resolution;
				switch (strategy) {
					case 'local':
						resolution = conflict.localData;
						break;
					case 'monday':
						resolution = conflict.remoteData;
						break;
					case 'newest':
						resolution = conflict.remoteTimestamp > conflict.localTimestamp 
							? conflict.remoteData 
							: conflict.localData;
						break;
					case 'prompt':
						resolution = await this.promptUserForResolution(conflict);
						break;
					default:
						throw new Error(`Unknown conflict resolution strategy: ${strategy}`);
				}

				// Apply resolution
				await this.applyConflictResolution(conflict.taskId, resolution);
				this.telemetry.conflictsResolved++;

			} catch (error) {
				log(`[Sync Engine] Failed to resolve conflict for task ${conflict.taskId}: ${error.message}`, 'error');
				throw error;
			}
		}
	}

	/**
	 * Prompts user for conflict resolution (for interactive mode)
	 */
	async promptUserForResolution(conflict) {
		// In a real implementation, this would show a UI dialog or prompt
		// For now, we'll use a simple console-based approach
		
		log(`[Sync Engine] Conflict detected for task ${conflict.taskId}:`, 'warn');
		log(`Local data: ${JSON.stringify(conflict.localData, null, 2)}`, 'info');
		log(`Remote data: ${JSON.stringify(conflict.remoteData, null, 2)}`, 'info');
		
		// For automated environments, default to newest
		return conflict.remoteTimestamp > conflict.localTimestamp 
			? conflict.remoteData 
			: conflict.localData;
	}

	/**
	 * Applies conflict resolution
	 */
	async applyConflictResolution(taskId, resolutionData) {
		// Apply the resolved data both locally and remotely
		await this.persistence.saveTask(resolutionData);
		this.changeTracker.updateLocalHash(taskId, resolutionData);
		
		log(`[Sync Engine] Applied conflict resolution for task ${taskId}`, 'info');
	}

	/**
	 * Pushes local changes to Monday.com
	 */
	async pushLocalChanges() {
		const pendingChanges = this.changeTracker.getPendingChanges();
		
		if (pendingChanges.length === 0) {
			log(`[Sync Engine] No local changes to push`, 'debug');
			return;
		}

		log(`[Sync Engine] Pushing ${pendingChanges.length} local changes`, 'info');

		for (const change of pendingChanges) {
			try {
				await this.applyChangeToMonday(change);
				this.changeTracker.markSynced(change.id);
			} catch (error) {
				change.retryCount++;
				log(`[Sync Engine] Failed to push change ${change.id}: ${error.message}`, 'error');
				
				// Remove failed changes after max retries
				if (change.retryCount >= 3) {
					this.changeTracker.markSynced(change.id); // Remove from queue
				}
			}
		}
	}

	/**
	 * Applies a local change to Monday.com
	 */
	async applyChangeToMonday(change) {
		switch (change.type) {
			case 'create':
				await this.persistence.saveTask(change.data);
				break;
			case 'update':
				await this.persistence.saveTask(change.data);
				break;
			case 'delete':
				await this.persistence.deleteTask(change.taskId);
				break;
			case 'status_change':
				await this.persistence.updateTaskStatus(change.taskId, change.data.status);
				break;
			default:
				throw new Error(`Unknown change type: ${change.type}`);
		}
	}

	/**
	 * Pulls remote changes from Monday.com
	 */
	async pullRemoteChanges(forceFullSync = false) {
		try {
			log(`[Sync Engine] Pulling remote changes (full: ${forceFullSync})`, 'info');

			// For incremental sync, we could use Monday.com's activity logs
			// For now, we'll do a full comparison
			const remoteData = await this.persistence.loadTasks({ forceRefresh: true });
			
			// Compare with local state and identify changes
			// This is simplified - a real implementation would track timestamps
			
			this.emit('remoteDataPulled', { taskCount: remoteData.tasks.length });

		} catch (error) {
			log(`[Sync Engine] Failed to pull remote changes: ${error.message}`, 'error');
			throw error;
		}
	}

	/**
	 * Validates data integrity between local and remote
	 */
	async validateDataIntegrity() {
		try {
			log(`[Sync Engine] Validating data integrity`, 'debug');
			
			// Load data from both sources
			const localData = await this.persistence.loadTasks({ forceRefresh: false });
			const remoteData = await this.persistence.loadTasks({ forceRefresh: true });

			// Compare task counts
			if (localData.tasks.length !== remoteData.tasks.length) {
				log(`[Sync Engine] Task count mismatch: local=${localData.tasks.length}, remote=${remoteData.tasks.length}`, 'warn');
			}

			// Validate individual tasks
			let mismatches = 0;
			for (const localTask of localData.tasks) {
				const remoteTask = remoteData.tasks.find(t => t.id === localTask.id);
				if (!remoteTask) {
					mismatches++;
					continue;
				}

				// Compare key fields
				const fields = ['title', 'status', 'priority', 'description'];
				for (const field of fields) {
					if (localTask[field] !== remoteTask[field]) {
						mismatches++;
						break;
					}
				}
			}

			if (mismatches > 0) {
				log(`[Sync Engine] Data integrity check found ${mismatches} mismatches`, 'warn');
			} else {
				log(`[Sync Engine] Data integrity check passed`, 'debug');
			}

			return { mismatches, totalTasks: localData.tasks.length };

		} catch (error) {
			log(`[Sync Engine] Data integrity validation failed: ${error.message}`, 'error');
			throw error;
		}
	}

	/**
	 * Processes offline queue when connectivity is restored
	 */
	async processOfflineQueue() {
		const readyItems = this.offlineQueue.getReadyItems();
		if (readyItems.length === 0) {
			return;
		}

		log(`[Sync Engine] Processing ${readyItems.length} items from offline queue`, 'info');

		for (const item of readyItems) {
			try {
				await this.applyChangeToMonday(item);
				await this.offlineQueue.markProcessed(item.id);
			} catch (error) {
				await this.offlineQueue.markFailed(item.id, error);
			}
		}
	}

	/**
	 * Starts background synchronization
	 */
	startBackgroundSync() {
		const interval = getMondaySyncInterval() * 1000; // Convert to milliseconds
		
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
		}

		this.syncInterval = setInterval(async () => {
			try {
				await this.syncWithMonday();
			} catch (error) {
				log(`[Sync Engine] Background sync failed: ${error.message}`, 'error');
			}
		}, interval);

		log(`[Sync Engine] Background sync started with ${interval/1000}s interval`, 'info');
	}

	/**
	 * Stops background synchronization
	 */
	stopBackgroundSync() {
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
			this.syncInterval = null;
			log(`[Sync Engine] Background sync stopped`, 'info');
		}
	}

	/**
	 * Handles remote changes from webhooks
	 */
	async handleRemoteChange(changeData) {
		log(`[Sync Engine] Handling remote change for task ${changeData.taskId}`, 'debug');
		
		// If we're online and not in a sync operation, apply immediately
		if (this.isOnline && !this.isSyncing) {
			try {
				// Trigger a targeted sync for this specific change
				await this.syncWithMonday({ direction: 'pull' });
			} catch (error) {
				log(`[Sync Engine] Failed to handle remote change: ${error.message}`, 'error');
			}
		}
	}

	/**
	 * Handles connectivity restored event
	 */
	async handleConnectivityRestored() {
		log(`[Sync Engine] Connectivity restored`, 'info');
		this.isOnline = true;
	}

	/**
	 * Handles connectivity lost event
	 */
	handleConnectivityLost() {
		log(`[Sync Engine] Connectivity lost`, 'warn');
		this.isOnline = false;
	}

	/**
	 * Records a local change for tracking
	 */
	async recordLocalChange(taskId, changeType, data) {
		const changeId = this.changeTracker.recordLocalChange(taskId, changeType, data);
		
		// Always add to offline queue for persistence and retry capability
		// Even when online, this provides reliability against temporary failures
		const change = {
			id: changeId,
			taskId,
			type: changeType,
			data,
			timestamp: Date.now()
		};

		await this.offlineQueue.add(change);

		// If online, attempt immediate processing
		if (this.isOnline && !this.isSyncing) {
			try {
				await this.applyChangeToMonday(change);
				await this.offlineQueue.markProcessed(changeId);
			} catch (error) {
				// Let it stay in queue for retry
				await this.offlineQueue.markFailed(changeId, error);
			}
		}

		return changeId;
	}

	/**
	 * Gets webhook handler for HTTP server integration
	 */
	getWebhookHandler() {
		return this.webhookHandler;
	}

	/**
	 * Gets telemetry data
	 */
	getTelemetry() {
		const connectivityStatus = this.connectivityMonitor.getStatus();
		const queueStats = this.offlineQueue.getStats();

		return {
			...this.telemetry,
			isOnline: connectivityStatus.isOnline,
			isSyncing: this.isSyncing,
			pendingChanges: this.changeTracker.getPendingChanges().length,
			offlineQueue: queueStats,
			connectivity: connectivityStatus,
			initialized: this.initialized
		};
	}

	/**
	 * Cleanup method
	 */
	cleanup() {
		this.stopBackgroundSync();
		this.changeTracker.cleanup();
		this.connectivityMonitor.stop();
		this.removeAllListeners();
	}
}

// Export singleton instance and factory functions
let syncEngineInstance = null;

/**
 * Gets or creates the sync engine singleton
 */
export function getSyncEngine() {
	if (!syncEngineInstance) {
		syncEngineInstance = new MondaySyncEngine();
	}
	return syncEngineInstance;
}

/**
 * Exported functions for direct use (matching PRD specification)
 */

/**
 * Main synchronization function
 */
export async function syncWithMonday(options = {}) {
	const engine = getSyncEngine();
	return await engine.syncWithMonday(options);
}

/**
 * Handles conflict resolution
 */
export async function handleConflictResolution(conflicts, strategy = null) {
	const engine = getSyncEngine();
	
	// Override strategy if provided
	if (strategy) {
		// Temporarily override the config
		const originalStrategy = getMondayConflictResolution();
		// Note: In a real implementation, we'd need a way to temporarily set the strategy
	}
	
	return await engine.handleConflictResolution(conflicts);
}

/**
 * Validates data integrity
 */
export async function validateDataIntegrity() {
	const engine = getSyncEngine();
	return await engine.validateDataIntegrity();
}

/**
 * Records a local change for tracking
 */
export async function recordLocalChange(taskId, changeType, data) {
	const engine = getSyncEngine();
	return await engine.recordLocalChange(taskId, changeType, data);
}

/**
 * Gets sync engine telemetry
 */
export function getSyncTelemetry() {
	const engine = getSyncEngine();
	return engine.getTelemetry();
}

/**
 * Initializes sync engine
 */
export async function initializeSyncEngine() {
	const engine = getSyncEngine();
	return await engine.initialize();
}

/**
 * Gets webhook handler for HTTP server setup
 */
export function getWebhookHandler() {
	const engine = getSyncEngine();
	return engine.getWebhookHandler();
}

// Export internal classes for testing
export { OfflineQueue, ChangeTracker, WebhookHandler, ConnectivityMonitor };