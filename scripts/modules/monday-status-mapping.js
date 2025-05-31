/**
 * monday-status-mapping.js
 * Comprehensive Status Mapping System for Monday.com Integration
 * 
 * This module provides a centralized, configurable system for mapping status values
 * between Task Master and Monday.com, including validation, custom mappings, and
 * automatic synchronization capabilities.
 */

import { log } from './utils.js';
import { TASK_STATUS_OPTIONS } from '../../src/constants/task-status.js';

/**
 * Default status mapping configurations
 * These can be overridden via configuration or custom mappings
 */
export const DEFAULT_STATUS_MAPPINGS = {
  // Task Master -> Monday.com Status Column Values
  TASK_TO_MONDAY: {
    'pending': 'pending',
    'in-progress': 'working_on_it',
    'done': 'done',
    'review': 'review',
    'blocked': 'stuck',
    'deferred': 'stuck',
    'cancelled': 'cancelled'
  },
  
  // Monday.com -> Task Master Status Values
  MONDAY_TO_TASK: {
    'pending': 'pending',
    'working_on_it': 'in-progress',
    'done': 'done',
    'review': 'review',
    'stuck': 'blocked',
    'cancelled': 'cancelled',
    // Additional Monday.com status values that might exist
    'new': 'pending',
    'started': 'in-progress',
    'complete': 'done',
    'finished': 'done',
    'completed': 'done',
    'blocked': 'blocked',
    'hold': 'blocked',
    'on_hold': 'blocked',
    'waiting': 'blocked',
    'paused': 'deferred',
    'delayed': 'deferred'
  }
};

/**
 * Priority-based status mapping for color coding and visual representation
 */
export const STATUS_PRIORITY_MAPPING = {
  'pending': { priority: 1, color: 'gray', group: 'upcoming' },
  'in-progress': { priority: 2, color: 'blue', group: 'active' },
  'review': { priority: 3, color: 'orange', group: 'active' },
  'blocked': { priority: 4, color: 'red', group: 'blocked' },
  'deferred': { priority: 5, color: 'yellow', group: 'blocked' },
  'done': { priority: 6, color: 'green', group: 'complete' },
  'cancelled': { priority: 7, color: 'purple', group: 'complete' }
};

/**
 * Monday.com board group mappings for task organization
 */
export const GROUP_MAPPINGS = {
  DEFAULT: {
    'pending': 'topics',
    'in-progress': 'topics', 
    'review': 'topics',
    'done': 'done',
    'blocked': 'blocked',
    'deferred': 'blocked',
    'cancelled': 'cancelled'
  },
  
  // Alternative mapping for different board structures
  KANBAN: {
    'pending': 'backlog',
    'in-progress': 'in_progress',
    'review': 'review',
    'done': 'done',
    'blocked': 'blocked',
    'deferred': 'backlog',
    'cancelled': 'archived'
  },
  
  // Sprint-based mapping
  SPRINT: {
    'pending': 'sprint_backlog',
    'in-progress': 'in_progress',
    'review': 'review',
    'done': 'done',
    'blocked': 'blocked',
    'deferred': 'next_sprint',
    'cancelled': 'archived'
  }
};

/**
 * Status transition rules for validation
 */
export const TRANSITION_RULES = {
  'pending': {
    allowed: ['in-progress', 'blocked', 'cancelled'],
    automatic: [], // No automatic transitions from pending
    restricted: [] // No restricted transitions
  },
  'in-progress': {
    allowed: ['done', 'review', 'blocked', 'cancelled'],
    automatic: [], // Could auto-transition to review based on criteria
    restricted: ['pending'] // Usually can't go back to pending directly
  },
  'review': {
    allowed: ['done', 'in-progress', 'blocked'],
    automatic: [], // Could auto-transition to done after approval
    restricted: ['pending', 'cancelled'] // Review items shouldn't be cancelled directly
  },
  'done': {
    allowed: ['review'], // Allow reopening for fixes
    automatic: [],
    restricted: ['pending', 'in-progress', 'blocked', 'cancelled'] // Done tasks shouldn't regress
  },
  'blocked': {
    allowed: ['pending', 'in-progress', 'cancelled'],
    automatic: [], // Could auto-transition when unblocked
    restricted: ['done', 'review'] // Blocked tasks can't jump to completion
  },
  'deferred': {
    allowed: ['pending', 'cancelled'],
    automatic: [], // Could auto-transition back to pending on schedule
    restricted: ['in-progress', 'done', 'review'] // Deferred tasks need re-evaluation
  },
  'cancelled': {
    allowed: [], // Terminal state - no transitions allowed
    automatic: [],
    restricted: ['pending', 'in-progress', 'done', 'review', 'blocked', 'deferred']
  }
};

/**
 * Status Mapping Manager Class
 */
export class StatusMappingManager {
  constructor(customMappings = {}) {
    this.taskToMondayMapping = { ...DEFAULT_STATUS_MAPPINGS.TASK_TO_MONDAY, ...customMappings.taskToMonday };
    this.mondayToTaskMapping = { ...DEFAULT_STATUS_MAPPINGS.MONDAY_TO_TASK, ...customMappings.mondayToTask };
    this.groupMapping = customMappings.groupMapping || GROUP_MAPPINGS.DEFAULT;
    this.transitionRules = { ...TRANSITION_RULES, ...customMappings.transitionRules };
    this.priorityMapping = { ...STATUS_PRIORITY_MAPPING, ...customMappings.priorityMapping };
    
    this.telemetry = {
      mappingsApplied: 0,
      validationChecks: 0,
      invalidMappings: 0,
      customMappingsUsed: Object.keys(customMappings).length > 0
    };
  }

  /**
   * Map Task Master status to Monday.com status
   * @param {string} taskStatus - Task Master status value
   * @param {Object} options - Mapping options
   * @returns {Object} Mapping result with Monday.com status and metadata
   */
  mapTaskStatusToMonday(taskStatus, options = {}) {
    const { validateInput = true, allowFallback = true } = options;

    try {
      // Validate input if requested
      if (validateInput && !this.isValidTaskStatus(taskStatus)) {
        throw new Error(`Invalid Task Master status: ${taskStatus}`);
      }

      // Apply mapping
      let mondayStatus = this.taskToMondayMapping[taskStatus];
      
      // Handle fallback
      if (!mondayStatus && allowFallback) {
        mondayStatus = taskStatus; // Use original value as fallback
        log('warn', `No mapping found for Task Master status '${taskStatus}', using fallback`);
      }

      if (!mondayStatus) {
        this.telemetry.invalidMappings++;
        throw new Error(`No Monday.com mapping found for Task Master status: ${taskStatus}`);
      }

      this.telemetry.mappingsApplied++;

      return {
        success: true,
        taskStatus,
        mondayStatus,
        priority: this.priorityMapping[taskStatus],
        group: this.groupMapping[taskStatus],
        isFallback: mondayStatus === taskStatus
      };

    } catch (error) {
      this.telemetry.invalidMappings++;
      return {
        success: false,
        taskStatus,
        mondayStatus: null,
        error: error.message
      };
    }
  }

  /**
   * Map Monday.com status to Task Master status
   * @param {string} mondayStatus - Monday.com status value
   * @param {Object} options - Mapping options
   * @returns {Object} Mapping result with Task Master status and metadata
   */
  mapMondayStatusToTask(mondayStatus, options = {}) {
    const { allowFallback = true, preferredFallback = 'pending' } = options;

    try {
      // Apply mapping (case-insensitive)
      const normalizedStatus = mondayStatus?.toLowerCase().replace(/\s+/g, '_');
      let taskStatus = this.mondayToTaskMapping[normalizedStatus];
      
      // Handle fallback
      if (!taskStatus && allowFallback) {
        // Try original value if it's a valid Task Master status
        if (this.isValidTaskStatus(mondayStatus)) {
          taskStatus = mondayStatus;
        } else {
          taskStatus = preferredFallback;
          log('warn', `No mapping found for Monday.com status '${mondayStatus}', using fallback: ${preferredFallback}`);
        }
      }

      if (!taskStatus) {
        this.telemetry.invalidMappings++;
        throw new Error(`No Task Master mapping found for Monday.com status: ${mondayStatus}`);
      }

      this.telemetry.mappingsApplied++;

      return {
        success: true,
        mondayStatus,
        taskStatus,
        priority: this.priorityMapping[taskStatus],
        group: this.groupMapping[taskStatus],
        isFallback: taskStatus === preferredFallback && taskStatus !== mondayStatus
      };

    } catch (error) {
      this.telemetry.invalidMappings++;
      return {
        success: false,
        mondayStatus,
        taskStatus: null,
        error: error.message
      };
    }
  }

  /**
   * Validate status transition
   * @param {string} currentStatus - Current Task Master status
   * @param {string} newStatus - Proposed new status
   * @param {Object} options - Validation options
   * @returns {Object} Validation result
   */
  validateStatusTransition(currentStatus, newStatus, options = {}) {
    const { strict = true, allowAutomatic = false } = options;

    this.telemetry.validationChecks++;

    try {
      // Validate status values
      if (!this.isValidTaskStatus(currentStatus)) {
        throw new Error(`Invalid current status: ${currentStatus}`);
      }
      if (!this.isValidTaskStatus(newStatus)) {
        throw new Error(`Invalid new status: ${newStatus}`);
      }

      // No transition needed
      if (currentStatus === newStatus) {
        return {
          valid: true,
          transition: 'none',
          reason: 'No change required'
        };
      }

      const rules = this.transitionRules[currentStatus];
      if (!rules) {
        return {
          valid: !strict,
          transition: 'unknown',
          reason: strict ? `No transition rules defined for status: ${currentStatus}` : 'Allowing transition (non-strict mode)'
        };
      }

      // Check if transition is explicitly allowed
      if (rules.allowed.includes(newStatus)) {
        return {
          valid: true,
          transition: 'allowed',
          reason: 'Transition is explicitly allowed'
        };
      }

      // Check if transition is automatic (if enabled)
      if (allowAutomatic && rules.automatic.includes(newStatus)) {
        return {
          valid: true,
          transition: 'automatic',
          reason: 'Transition is automatically triggered'
        };
      }

      // Check if transition is restricted
      if (rules.restricted.includes(newStatus)) {
        return {
          valid: false,
          transition: 'restricted',
          reason: `Transition from ${currentStatus} to ${newStatus} is explicitly restricted`
        };
      }

      // Default behavior based on strict mode
      return {
        valid: !strict,
        transition: strict ? 'disallowed' : 'permitted',
        reason: strict 
          ? `Transition from ${currentStatus} to ${newStatus} is not in allowed list: [${rules.allowed.join(', ')}]`
          : 'Allowing transition (non-strict mode)'
      };

    } catch (error) {
      return {
        valid: false,
        transition: 'error',
        reason: error.message
      };
    }
  }

  /**
   * Get group mapping for a status
   * @param {string} taskStatus - Task Master status
   * @returns {string} Monday.com group name
   */
  getGroupForStatus(taskStatus) {
    return this.groupMapping[taskStatus] || 'topics';
  }

  /**
   * Get priority information for a status
   * @param {string} taskStatus - Task Master status
   * @returns {Object} Priority information
   */
  getPriorityForStatus(taskStatus) {
    return this.priorityMapping[taskStatus] || { priority: 0, color: 'gray', group: 'unknown' };
  }

  /**
   * Validate if a status is a valid Task Master status
   * @param {string} status - Status to validate
   * @returns {boolean} True if valid
   */
  isValidTaskStatus(status) {
    return TASK_STATUS_OPTIONS.includes(status);
  }

  /**
   * Get all available mappings
   * @returns {Object} All mapping configurations
   */
  getAllMappings() {
    return {
      taskToMonday: this.taskToMondayMapping,
      mondayToTask: this.mondayToTaskMapping,
      groups: this.groupMapping,
      priorities: this.priorityMapping,
      transitionRules: this.transitionRules
    };
  }

  /**
   * Update custom mappings
   * @param {Object} newMappings - New mapping configurations
   */
  updateMappings(newMappings) {
    if (newMappings.taskToMonday) {
      this.taskToMondayMapping = { ...this.taskToMondayMapping, ...newMappings.taskToMonday };
    }
    if (newMappings.mondayToTask) {
      this.mondayToTaskMapping = { ...this.mondayToTaskMapping, ...newMappings.mondayToTask };
    }
    if (newMappings.groups) {
      this.groupMapping = { ...this.groupMapping, ...newMappings.groups };
    }
    if (newMappings.priorities) {
      this.priorityMapping = { ...this.priorityMapping, ...newMappings.priorities };
    }
    if (newMappings.transitionRules) {
      this.transitionRules = { ...this.transitionRules, ...newMappings.transitionRules };
    }
    
    this.telemetry.customMappingsUsed = true;
    log('info', 'Status mappings updated successfully');
  }

  /**
   * Get mapping telemetry
   * @returns {Object} Telemetry data
   */
  getTelemetry() {
    return {
      ...this.telemetry,
      totalMappingsAvailable: {
        taskToMonday: Object.keys(this.taskToMondayMapping).length,
        mondayToTask: Object.keys(this.mondayToTaskMapping).length,
        groups: Object.keys(this.groupMapping).length,
        priorities: Object.keys(this.priorityMapping).length
      }
    };
  }

  /**
   * Reset telemetry counters
   */
  resetTelemetry() {
    this.telemetry.mappingsApplied = 0;
    this.telemetry.validationChecks = 0;
    this.telemetry.invalidMappings = 0;
  }
}

// Export singleton instance with default mappings
export const statusMappingManager = new StatusMappingManager();

// Export convenient wrapper functions
export function mapTaskStatusToMonday(taskStatus, options = {}) {
  return statusMappingManager.mapTaskStatusToMonday(taskStatus, options);
}

export function mapMondayStatusToTask(mondayStatus, options = {}) {
  return statusMappingManager.mapMondayStatusToTask(mondayStatus, options);
}

export function validateStatusTransition(currentStatus, newStatus, options = {}) {
  return statusMappingManager.validateStatusTransition(currentStatus, newStatus, options);
}

export function getGroupForStatus(taskStatus) {
  return statusMappingManager.getGroupForStatus(taskStatus);
}

export function getPriorityForStatus(taskStatus) {
  return statusMappingManager.getPriorityForStatus(taskStatus);
}

export function getMappingTelemetry() {
  return statusMappingManager.getTelemetry();
}

// Export all constants for external use
export {
  TASK_STATUS_OPTIONS,
  DEFAULT_STATUS_MAPPINGS,
  STATUS_PRIORITY_MAPPING,
  GROUP_MAPPINGS,
  TRANSITION_RULES
}; 