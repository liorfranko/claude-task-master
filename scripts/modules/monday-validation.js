/**
 * monday-validation.js
 * Monday.com API Validation and Error Handling Module
 * 
 * This module provides comprehensive validation and error handling for Monday.com API constraints
 * including rate limits, data validation, complexity budget monitoring, and graceful degradation.
 */

import { log } from './utils.js';

/**
 * Monday.com API Error Types
 */
export const MONDAY_ERROR_TYPES = {
	// Rate Limiting
	COMPLEXITY_BUDGET_EXHAUSTED: 'COMPLEXITY_BUDGET_EXHAUSTED',
	DAILY_LIMIT_EXCEEDED: 'DAILY_LIMIT_EXCEEDED',
	RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
	
	// Data Validation
	INVALID_ITEM_NAME: 'INVALID_ITEM_NAME',
	BOARD_ITEM_LIMIT_EXCEEDED: 'BOARD_ITEM_LIMIT_EXCEEDED',
	INVALID_COLUMN_VALUE: 'INVALID_COLUMN_VALUE',
	INVALID_BOARD_ID: 'INVALID_BOARD_ID',
	INVALID_ITEM_ID: 'INVALID_ITEM_ID',
	INVALID_COLUMN_ID: 'INVALID_COLUMN_ID',
	
	// Permissions
	INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
	BOARD_ACCESS_DENIED: 'BOARD_ACCESS_DENIED',
	
	// Network
	NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
	CONNECTION_FAILED: 'CONNECTION_FAILED',
	SERVER_ERROR: 'SERVER_ERROR'
};

/**
 * Monday.com API Limits and Constants
 */
export const MONDAY_LIMITS = {
	// Rate Limits
	COMPLEXITY_POINTS_PER_QUERY: 5000000, // 5M points per query
	COMPLEXITY_POINTS_PER_MINUTE: 10000000, // 5-10M points per minute
	
	// Daily API Call Limits by Tier
	DAILY_LIMITS: {
		FREE: 200,
		TRIAL: 200,
		BASIC: 1000,
		STANDARD: 1000,
		PRO: 10000,
		ENTERPRISE: 25000
	},
	
	// Data Limits
	ITEM_NAME_MIN_LENGTH: 1,
	ITEM_NAME_MAX_LENGTH: 255,
	BOARD_ITEM_LIMIT: 10000,
	
	// Concurrency
	MAX_CONCURRENT_REQUESTS: 5,
	
	// Timeouts
	DEFAULT_TIMEOUT: 30000, // 30 seconds
	RETRY_DELAY_MIN: 1000,   // 1 second
	RETRY_DELAY_MAX: 30000,  // 30 seconds
	RATE_LIMIT_RETRY_DELAY: 60000 // 1 minute
};

/**
 * API Usage Tracker for Rate Limiting
 */
class ApiUsageTracker {
	constructor() {
		this.complexityPoints = 0;
		this.apiCallsToday = 0;
		this.concurrentRequests = 0;
		this.lastReset = new Date().toDateString();
		this.requestQueue = [];
		this.tier = 'BASIC'; // Default tier
	}

	/**
	 * Track complexity points for a query
	 */
	trackComplexity(points) {
		this.complexityPoints += points;
		this.resetIfNewDay();
	}

	/**
	 * Track an API call
	 */
	trackApiCall() {
		this.apiCallsToday += 1;
		this.resetIfNewDay();
	}

	/**
	 * Track concurrent request
	 */
	trackConcurrentRequest(increment = true) {
		if (increment) {
			this.concurrentRequests += 1;
		} else {
			this.concurrentRequests = Math.max(0, this.concurrentRequests - 1);
		}
	}

	/**
	 * Check if operation would exceed limits
	 */
	canMakeRequest(estimatedComplexity = 1000) {
		const today = new Date().toDateString();
		if (today !== this.lastReset) {
			this.reset();
		}

		// Check daily limit
		const dailyLimit = MONDAY_LIMITS.DAILY_LIMITS[this.tier] || MONDAY_LIMITS.DAILY_LIMITS.BASIC;
		if (this.apiCallsToday >= dailyLimit) {
			return { allowed: false, reason: 'DAILY_LIMIT_EXCEEDED', resetTime: this.getNextResetTime() };
		}

		// Check complexity budget
		if (this.complexityPoints + estimatedComplexity > MONDAY_LIMITS.COMPLEXITY_POINTS_PER_MINUTE) {
			return { allowed: false, reason: 'COMPLEXITY_BUDGET_EXHAUSTED', resetTime: this.getNextMinuteReset() };
		}

		// Check concurrency
		if (this.concurrentRequests >= MONDAY_LIMITS.MAX_CONCURRENT_REQUESTS) {
			return { allowed: false, reason: 'CONCURRENT_LIMIT_EXCEEDED', waitTime: 5000 };
		}

		return { allowed: true };
	}

	/**
	 * Reset daily counters
	 */
	reset() {
		this.apiCallsToday = 0;
		this.complexityPoints = 0;
		this.lastReset = new Date().toDateString();
	}

	/**
	 * Reset if new day
	 */
	resetIfNewDay() {
		const today = new Date().toDateString();
		if (today !== this.lastReset) {
			this.reset();
		}
	}

	/**
	 * Get next reset time for daily limits
	 */
	getNextResetTime() {
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		tomorrow.setHours(0, 0, 0, 0);
		return tomorrow;
	}

	/**
	 * Get next minute reset for complexity budget
	 */
	getNextMinuteReset() {
		const nextMinute = new Date();
		nextMinute.setSeconds(0, 0);
		nextMinute.setMinutes(nextMinute.getMinutes() + 1);
		return nextMinute;
	}

	/**
	 * Set account tier for appropriate limits
	 */
	setTier(tier) {
		if (MONDAY_LIMITS.DAILY_LIMITS[tier]) {
			this.tier = tier;
		}
	}

	/**
	 * Get usage statistics
	 */
	getUsage() {
		return {
			complexityPoints: this.complexityPoints,
			apiCallsToday: this.apiCallsToday,
			concurrentRequests: this.concurrentRequests,
			tier: this.tier,
			dailyLimit: MONDAY_LIMITS.DAILY_LIMITS[this.tier],
			lastReset: this.lastReset
		};
	}
}

// Global usage tracker instance
const usageTracker = new ApiUsageTracker();

/**
 * Monday.com Validation Class
 */
export class MondayValidation {
	/**
	 * Validate item name according to Monday.com constraints
	 */
	static validateItemName(name) {
		if (!name || typeof name !== 'string') {
			return {
				valid: false,
				error: MONDAY_ERROR_TYPES.INVALID_ITEM_NAME,
				message: 'Item name must be a non-empty string'
			};
		}

		const trimmedName = name.trim();
		
		if (trimmedName.length < MONDAY_LIMITS.ITEM_NAME_MIN_LENGTH) {
			return {
				valid: false,
				error: MONDAY_ERROR_TYPES.INVALID_ITEM_NAME,
				message: `Item name must be at least ${MONDAY_LIMITS.ITEM_NAME_MIN_LENGTH} character long`
			};
		}

		if (trimmedName.length > MONDAY_LIMITS.ITEM_NAME_MAX_LENGTH) {
			return {
				valid: false,
				error: MONDAY_ERROR_TYPES.INVALID_ITEM_NAME,
				message: `Item name must not exceed ${MONDAY_LIMITS.ITEM_NAME_MAX_LENGTH} characters`
			};
		}

		// Check for invalid characters that might break GraphQL
		const invalidChars = /["\\\n\r\t]/;
		if (invalidChars.test(trimmedName)) {
			return {
				valid: false,
				error: MONDAY_ERROR_TYPES.INVALID_ITEM_NAME,
				message: 'Item name contains invalid characters (quotes, backslashes, or control characters)'
			};
		}

		return { valid: true, sanitized: trimmedName };
	}

	/**
	 * Validate board item count
	 */
	static validateBoardItemCount(currentCount, additionalItems = 1) {
		const newTotal = currentCount + additionalItems;
		
		if (newTotal > MONDAY_LIMITS.BOARD_ITEM_LIMIT) {
			return {
				valid: false,
				error: MONDAY_ERROR_TYPES.BOARD_ITEM_LIMIT_EXCEEDED,
				message: `Adding ${additionalItems} item(s) would exceed board limit of ${MONDAY_LIMITS.BOARD_ITEM_LIMIT} items`,
				currentCount,
				limit: MONDAY_LIMITS.BOARD_ITEM_LIMIT
			};
		}

		return { valid: true, newTotal };
	}

	/**
	 * Validate column value format
	 */
	static validateColumnValue(columnType, value) {
		if (value === null || value === undefined) {
			return { valid: true, sanitized: null };
		}

		switch (columnType) {
			case 'text':
				if (typeof value !== 'string') {
					return {
						valid: false,
						error: MONDAY_ERROR_TYPES.INVALID_COLUMN_VALUE,
						message: 'Text column value must be a string'
					};
				}
				return { valid: true, sanitized: value };

			case 'status':
				if (typeof value !== 'string') {
					return {
						valid: false,
						error: MONDAY_ERROR_TYPES.INVALID_COLUMN_VALUE,
						message: 'Status column value must be a string'
					};
				}
				return { valid: true, sanitized: value };

			case 'date':
				// Accept ISO date strings or Date objects
				try {
					const date = new Date(value);
					if (isNaN(date.getTime())) {
						throw new Error('Invalid date');
					}
					return { valid: true, sanitized: date.toISOString().split('T')[0] };
				} catch (error) {
					return {
						valid: false,
						error: MONDAY_ERROR_TYPES.INVALID_COLUMN_VALUE,
						message: 'Date column value must be a valid date'
					};
				}

			case 'numbers':
				const num = Number(value);
				if (isNaN(num)) {
					return {
						valid: false,
						error: MONDAY_ERROR_TYPES.INVALID_COLUMN_VALUE,
						message: 'Numbers column value must be a valid number'
					};
				}
				return { valid: true, sanitized: num };

			case 'rating':
				const rating = Number(value);
				if (isNaN(rating) || rating < 1 || rating > 5) {
					return {
						valid: false,
						error: MONDAY_ERROR_TYPES.INVALID_COLUMN_VALUE,
						message: 'Rating column value must be a number between 1 and 5'
					};
				}
				return { valid: true, sanitized: Math.round(rating) };

			default:
				// For unknown column types, accept as-is but log warning
				log('warn', `Unknown column type "${columnType}", accepting value as-is`);
				return { valid: true, sanitized: value };
		}
	}

	/**
	 * Validate ID format (board, item, column)
	 */
	static validateId(id, type = 'item') {
		if (!id) {
			return {
				valid: false,
				error: MONDAY_ERROR_TYPES[`INVALID_${type.toUpperCase()}_ID`],
				message: `${type} ID is required`
			};
		}

		// Monday.com IDs are typically numeric strings or numbers
		const numericId = Number(id);
		if (isNaN(numericId) || numericId <= 0) {
			return {
				valid: false,
				error: MONDAY_ERROR_TYPES[`INVALID_${type.toUpperCase()}_ID`],
				message: `${type} ID must be a positive number`
			};
		}

		return { valid: true, sanitized: String(Math.floor(numericId)) };
	}

	/**
	 * Validate task data structure
	 */
	static validateTaskData(task) {
		const errors = [];

		// Validate required fields
		if (!task.title) {
			errors.push('Task title is required');
		} else {
			const nameValidation = this.validateItemName(task.title);
			if (!nameValidation.valid) {
				errors.push(`Task title validation failed: ${nameValidation.message}`);
			}
		}

		// Validate optional fields
		if (task.id) {
			const idValidation = this.validateId(task.id, 'item');
			if (!idValidation.valid) {
				errors.push(`Task ID validation failed: ${idValidation.message}`);
			}
		}

		if (task.dependencies && Array.isArray(task.dependencies)) {
			task.dependencies.forEach((depId, index) => {
				const depValidation = this.validateId(depId, 'item');
				if (!depValidation.valid) {
					errors.push(`Dependency ${index + 1} validation failed: ${depValidation.message}`);
				}
			});
		}

		return {
			valid: errors.length === 0,
			errors,
			message: errors.length > 0 ? errors.join('; ') : 'Task data is valid'
		};
	}
}

/**
 * Monday.com Error Handler Class
 */
export class MondayErrorHandler {
	/**
	 * Parse Monday.com API error and classify it
	 */
	static parseError(error, context = {}) {
		const errorMessage = error.message || error.toString();
		const lowerMessage = errorMessage.toLowerCase();

		// Classify error type
		let errorType = null;
		let shouldRetry = false;
		let retryAfter = null;

		if (lowerMessage.includes('rate limit') || lowerMessage.includes('429')) {
			errorType = MONDAY_ERROR_TYPES.RATE_LIMIT_EXCEEDED;
			shouldRetry = true;
			retryAfter = MONDAY_LIMITS.RATE_LIMIT_RETRY_DELAY;
		} else if (lowerMessage.includes('complexity') || lowerMessage.includes('budget')) {
			errorType = MONDAY_ERROR_TYPES.COMPLEXITY_BUDGET_EXHAUSTED;
			shouldRetry = true;
			retryAfter = 60000; // 1 minute
		} else if (lowerMessage.includes('daily limit') || lowerMessage.includes('quota')) {
			errorType = MONDAY_ERROR_TYPES.DAILY_LIMIT_EXCEEDED;
			shouldRetry = false; // Don't retry until tomorrow
		} else if (lowerMessage.includes('unauthorized') || lowerMessage.includes('forbidden')) {
			errorType = MONDAY_ERROR_TYPES.INSUFFICIENT_PERMISSIONS;
			shouldRetry = false;
		} else if (lowerMessage.includes('not found') || lowerMessage.includes('404')) {
			if (context.resourceType === 'board') {
				errorType = MONDAY_ERROR_TYPES.INVALID_BOARD_ID;
			} else {
				errorType = MONDAY_ERROR_TYPES.INVALID_ITEM_ID;
			}
			shouldRetry = false;
		} else if (lowerMessage.includes('timeout') || lowerMessage.includes('network')) {
			errorType = MONDAY_ERROR_TYPES.NETWORK_TIMEOUT;
			shouldRetry = true;
			retryAfter = MONDAY_LIMITS.RETRY_DELAY_MIN;
		} else if (lowerMessage.includes('server error') || lowerMessage.includes('500')) {
			errorType = MONDAY_ERROR_TYPES.SERVER_ERROR;
			shouldRetry = true;
			retryAfter = MONDAY_LIMITS.RETRY_DELAY_MIN * 2;
		}

		return {
			type: errorType,
			originalError: error,
			message: errorMessage,
			shouldRetry,
			retryAfter,
			context,
			timestamp: new Date().toISOString()
		};
	}

	/**
	 * Handle error with appropriate response
	 */
	static async handleError(error, context = {}) {
		const parsedError = this.parseError(error, context);
		
		// Log error with appropriate level
		const logLevel = parsedError.shouldRetry ? 'warn' : 'error';
		log(logLevel, `Monday.com API Error [${parsedError.type}]: ${parsedError.message}`, context);

		// Return standardized error response
		return {
			success: false,
			error: {
				type: parsedError.type,
				message: this.getUserFriendlyMessage(parsedError),
				shouldRetry: parsedError.shouldRetry,
				retryAfter: parsedError.retryAfter,
				originalMessage: parsedError.message
			},
			fallbackToLocal: this.shouldFallbackToLocal(parsedError),
			timestamp: parsedError.timestamp
		};
	}

	/**
	 * Generate user-friendly error messages
	 */
	static getUserFriendlyMessage(parsedError) {
		switch (parsedError.type) {
			case MONDAY_ERROR_TYPES.RATE_LIMIT_EXCEEDED:
				return 'Monday.com rate limit exceeded. Please wait a moment before trying again.';
			
			case MONDAY_ERROR_TYPES.COMPLEXITY_BUDGET_EXHAUSTED:
				return 'Monday.com API complexity budget exceeded. Reducing request complexity and retrying.';
			
			case MONDAY_ERROR_TYPES.DAILY_LIMIT_EXCEEDED:
				return 'Daily API limit reached for your Monday.com account. Please try again tomorrow or upgrade your plan.';
			
			case MONDAY_ERROR_TYPES.INSUFFICIENT_PERMISSIONS:
				return 'Insufficient permissions to access Monday.com resource. Please check your API key and board permissions.';
			
			case MONDAY_ERROR_TYPES.INVALID_BOARD_ID:
				return 'The specified Monday.com board was not found or is not accessible.';
			
			case MONDAY_ERROR_TYPES.INVALID_ITEM_ID:
				return 'The specified Monday.com item was not found or is not accessible.';
			
			case MONDAY_ERROR_TYPES.NETWORK_TIMEOUT:
				return 'Network timeout while connecting to Monday.com. Please check your internet connection.';
			
			case MONDAY_ERROR_TYPES.SERVER_ERROR:
				return 'Monday.com server error. Please try again in a moment.';
			
			default:
				return parsedError.message || 'An unexpected error occurred with Monday.com API.';
		}
	}

	/**
	 * Determine if operation should fallback to local storage
	 */
	static shouldFallbackToLocal(parsedError) {
		const fallbackTypes = [
			MONDAY_ERROR_TYPES.DAILY_LIMIT_EXCEEDED,
			MONDAY_ERROR_TYPES.NETWORK_TIMEOUT,
			MONDAY_ERROR_TYPES.CONNECTION_FAILED,
			MONDAY_ERROR_TYPES.SERVER_ERROR
		];

		return fallbackTypes.includes(parsedError.type);
	}
}

/**
 * Rate Limiting and Request Management
 */
export class MondayRateLimiter {
	/**
	 * Check if request can be made
	 */
	static async canMakeRequest(estimatedComplexity = 1000) {
		return usageTracker.canMakeRequest(estimatedComplexity);
	}

	/**
	 * Track API usage
	 */
	static trackRequest(complexityPoints = 1000) {
		usageTracker.trackApiCall();
		usageTracker.trackComplexity(complexityPoints);
	}

	/**
	 * Track concurrent request
	 */
	static trackConcurrentRequest(increment = true) {
		usageTracker.trackConcurrentRequest(increment);
	}

	/**
	 * Wait for rate limit to reset
	 */
	static async waitForRateLimit(retryAfter = MONDAY_LIMITS.RATE_LIMIT_RETRY_DELAY) {
		log('info', `Waiting ${retryAfter}ms for rate limit to reset...`);
		await new Promise(resolve => setTimeout(resolve, retryAfter));
	}

	/**
	 * Set account tier for proper rate limiting
	 */
	static setAccountTier(tier) {
		usageTracker.setTier(tier);
	}

	/**
	 * Get current usage statistics
	 */
	static getUsageStats() {
		return usageTracker.getUsage();
	}

	/**
	 * Reset usage counters (for testing)
	 */
	static reset() {
		usageTracker.reset();
	}
}

/**
 * Batch Operation Optimizer
 */
export class MondayBatchOptimizer {
	/**
	 * Optimize multiple operations into batch requests
	 */
	static optimizeBatch(operations) {
		// Group operations by type
		const groups = {
			create: [],
			update: [],
			delete: [],
			read: []
		};

		operations.forEach(op => {
			if (groups[op.type]) {
				groups[op.type].push(op);
			}
		});

		// Return optimized batch plan
		return {
			batches: Object.entries(groups)
				.filter(([type, ops]) => ops.length > 0)
				.map(([type, ops]) => ({
					type,
					operations: ops,
					estimatedComplexity: this.estimateComplexity(type, ops.length)
				})),
			totalComplexity: this.calculateTotalComplexity(groups)
		};
	}

	/**
	 * Estimate complexity points for operation batch
	 */
	static estimateComplexity(operationType, count) {
		const baseComplexity = {
			create: 500,
			update: 300,
			delete: 200,
			read: 100
		};

		return (baseComplexity[operationType] || 300) * count;
	}

	/**
	 * Calculate total complexity for all operation groups
	 */
	static calculateTotalComplexity(groups) {
		return Object.entries(groups)
			.reduce((total, [type, ops]) => 
				total + this.estimateComplexity(type, ops.length), 0);
	}
}

// Export singleton instances
export const mondayValidation = MondayValidation;
export const mondayErrorHandler = MondayErrorHandler;
export const mondayRateLimiter = MondayRateLimiter;
export const mondayBatchOptimizer = MondayBatchOptimizer;

// Export usage tracker for advanced use cases
export { usageTracker }; 