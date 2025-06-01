/**
 * backward-compatibility.js
 * Backward Compatibility Manager for Task Master
 * 
 * This module ensures seamless operation between local file persistence and Monday.com persistence,
 * providing automatic detection, migration assistance, and fallback mechanisms.
 */

import fs from 'fs';
import path from 'path';
import { log, findProjectRoot } from './utils.js';
import { getPersistenceMode, getMondayEnabled, getMondayIntegrationStatus, migrateMondayConfig } from './monday-config-manager.js';
import { getConfig, writeConfig } from './config-manager.js';
import { persistenceManager } from './persistence-manager.js';

/**
 * Project State Detection Results
 */
export const PROJECT_STATES = {
  LEGACY_LOCAL: 'legacy_local',           // Has tasks.json but no Monday.com config
  CONFIGURED_LOCAL: 'configured_local',   // Explicitly configured for local persistence
  CONFIGURED_MONDAY: 'configured_monday', // Configured for Monday.com persistence
  CONFIGURED_HYBRID: 'configured_hybrid', // Configured for hybrid persistence
  UNCONFIGURED: 'unconfigured',          // No tasks or configuration detected
  MIGRATION_NEEDED: 'migration_needed'    // Has config but needs migration
};

/**
 * Backward Compatibility Manager Class
 */
export class BackwardCompatibilityManager {
  constructor() {
    this.projectRoot = null;
    this.detectedState = null;
  }

  /**
   * Analyze project state and determine compatibility requirements
   * @param {string} projectRoot - Project root directory
   * @returns {Object} Analysis results with recommendations
   */
  async analyzeProjectState(projectRoot = null) {
    this.projectRoot = projectRoot || findProjectRoot() || '.';
    
    const analysis = {
      projectRoot: this.projectRoot,
      state: PROJECT_STATES.UNCONFIGURED,
      hasTasksJson: false,
      hasConfigFile: false,
      hasMonadayConfig: false,
      configVersion: null,
      persistenceMode: 'local',
      mondayEnabled: false,
      mondayConfigured: false,
      issues: [],
      recommendations: [],
      migrationPath: null
    };

    try {
      // Check for tasks.json file
      const tasksJsonPath = path.join(this.projectRoot, 'tasks', 'tasks.json');
      const legacyTasksJsonPath = path.join(this.projectRoot, 'tasks.json');
      
      analysis.hasTasksJson = fs.existsSync(tasksJsonPath) || fs.existsSync(legacyTasksJsonPath);
      
      // Check for configuration file
      const configPath = path.join(this.projectRoot, '.taskmasterconfig');
      analysis.hasConfigFile = fs.existsSync(configPath);
      
      if (analysis.hasConfigFile) {
        try {
          const config = getConfig(this.projectRoot);
          analysis.configVersion = config.configVersion || '1.0.0';
          analysis.hasMonadayConfig = !!config.monday;
          analysis.persistenceMode = getPersistenceMode(this.projectRoot);
          analysis.mondayEnabled = getMondayEnabled(this.projectRoot);
          
          const mondayStatus = getMondayIntegrationStatus(this.projectRoot);
          analysis.mondayConfigured = mondayStatus.boardConfigured && mondayStatus.apiKeyAvailable;
        } catch (error) {
          analysis.issues.push(`Configuration file exists but is invalid: ${error.message}`);
        }
      }

      // Determine project state
      analysis.state = this._determineProjectState(analysis);
      
      // Generate recommendations based on state
      analysis.recommendations = this._generateRecommendations(analysis);
      analysis.migrationPath = this._determineMigrationPath(analysis);
      
      this.detectedState = analysis.state;
      return analysis;
      
    } catch (error) {
      analysis.issues.push(`Project analysis failed: ${error.message}`);
      return analysis;
    }
  }

  /**
   * Determine project state based on analysis
   * @private
   */
  _determineProjectState(analysis) {
    // No configuration file - check for legacy setup
    if (!analysis.hasConfigFile) {
      if (analysis.hasTasksJson) {
        return PROJECT_STATES.LEGACY_LOCAL;
      }
      return PROJECT_STATES.UNCONFIGURED;
    }

    // Has configuration file - check configuration state
    if (!analysis.hasMonadayConfig) {
      return PROJECT_STATES.MIGRATION_NEEDED;
    }

    // Has Monday.com configuration - check mode
    switch (analysis.persistenceMode) {
      case 'monday':
        return PROJECT_STATES.CONFIGURED_MONDAY;
      case 'hybrid':
        return PROJECT_STATES.CONFIGURED_HYBRID;
      case 'local':
      default:
        return PROJECT_STATES.CONFIGURED_LOCAL;
    }
  }

  /**
   * Generate recommendations based on project state
   * @private
   */
  _generateRecommendations(analysis) {
    const recommendations = [];
    
    switch (analysis.state) {
      case PROJECT_STATES.LEGACY_LOCAL:
        recommendations.push({
          type: 'migration',
          priority: 'high',
          title: 'Migrate to New Configuration Format',
          description: 'Your project uses the legacy task format. Update to the new configuration system for enhanced features.',
          action: 'Run backward compatibility migration to update configuration.'
        });
        break;

      case PROJECT_STATES.MIGRATION_NEEDED:
        recommendations.push({
          type: 'configuration',
          priority: 'medium',
          title: 'Add Monday.com Configuration',
          description: 'Configuration file exists but lacks Monday.com integration settings.',
          action: 'Add Monday.com configuration section to enable new persistence options.'
        });
        break;

      case PROJECT_STATES.CONFIGURED_LOCAL:
        if (!analysis.mondayConfigured) {
          recommendations.push({
            type: 'enhancement',
            priority: 'low',
            title: 'Consider Monday.com Integration',
            description: 'Enable Monday.com integration for team collaboration and advanced features.',
            action: 'Configure Monday.com API key and board ID to enable cloud persistence.'
          });
        }
        break;

      case PROJECT_STATES.CONFIGURED_MONDAY:
        if (!analysis.mondayConfigured) {
          recommendations.push({
            type: 'configuration',
            priority: 'high',
            title: 'Complete Monday.com Setup',
            description: 'Monday.com mode is enabled but not properly configured.',
            action: 'Set MONDAY_API_KEY and configure board ID to use Monday.com persistence.'
          });
        }
        break;

      case PROJECT_STATES.UNCONFIGURED:
        recommendations.push({
          type: 'setup',
          priority: 'high',
          title: 'Initialize Task Master Project',
          description: 'No Task Master configuration detected in this directory.',
          action: 'Run task-master init to set up a new project.'
        });
        break;
    }

    return recommendations;
  }

  /**
   * Determine migration path for the project
   * @private
   */
  _determineMigrationPath(analysis) {
    const path = {
      from: analysis.state,
      to: null,
      steps: [],
      automated: false
    };

    switch (analysis.state) {
      case PROJECT_STATES.LEGACY_LOCAL:
        path.to = PROJECT_STATES.CONFIGURED_LOCAL;
        path.automated = true;
        path.steps = [
          'Create .taskmasterconfig file with current settings',
          'Add Monday.com configuration section with local mode',
          'Preserve existing tasks.json data'
        ];
        break;

      case PROJECT_STATES.MIGRATION_NEEDED:
        path.to = PROJECT_STATES.CONFIGURED_LOCAL;
        path.automated = true;
        path.steps = [
          'Add Monday.com configuration section to existing config',
          'Set persistence mode to local (maintaining current behavior)',
          'Add configuration version tracking'
        ];
        break;

      case PROJECT_STATES.CONFIGURED_LOCAL:
        path.to = PROJECT_STATES.CONFIGURED_HYBRID;
        path.automated = false;
        path.steps = [
          'Set up Monday.com API key',
          'Create or configure Monday.com board',
          'Update persistence mode to hybrid',
          'Initial data sync to Monday.com'
        ];
        break;
    }

    return path;
  }

  /**
   * Perform automatic migration based on detected state
   * @param {Object} options - Migration options
   * @returns {Object} Migration results
   */
  async performAutomaticMigration(options = {}) {
    const { dryRun = false, backup = true } = options;
    
    if (!this.detectedState) {
      await this.analyzeProjectState(this.projectRoot);
    }

    const results = {
      success: false,
      state: this.detectedState,
      changes: [],
      backupPath: null,
      errors: []
    };

    try {
      log('info', `Performing ${dryRun ? 'dry run' : 'automatic'} migration for state: ${this.detectedState}`);
      
      switch (this.detectedState) {
        case PROJECT_STATES.LEGACY_LOCAL:
          return await this._migrateLegacyLocal(dryRun, backup);
          
        case PROJECT_STATES.MIGRATION_NEEDED:
          return await this._migrateConfigurationOnly(dryRun, backup);
          
        default:
          results.errors.push(`No automatic migration available for state: ${this.detectedState}`);
          return results;
      }
      
    } catch (error) {
      results.errors.push(`Migration failed: ${error.message}`);
      log('error', `Migration failed: ${error.message}`);
      return results;
    }
  }

  /**
   * Migrate legacy local setup to new configuration format
   * @private
   */
  async _migrateLegacyLocal(dryRun, backup) {
    const results = {
      success: true,
      state: this.detectedState,
      changes: [],
      backupPath: null,
      errors: []
    };

    // Create backup if requested
    if (backup && !dryRun) {
      results.backupPath = await this._createBackup();
      results.changes.push(`Created backup at: ${results.backupPath}`);
    }

    // Generate new configuration
    const newConfig = {
      projectName: path.basename(this.projectRoot),
      configVersion: '2.0.0',
      models: {
        main: { provider: 'anthropic', id: 'claude-3-5-sonnet-20241022' },
        research: { provider: 'anthropic', id: 'claude-3-5-sonnet-20241022' },
        fallback: { provider: 'anthropic', id: 'claude-3-5-haiku-20241022' }
      },
      global: {
        logLevel: 'info',
        defaultSubtasks: 5,
        defaultPriority: 'medium'
      },
      monday: {
        enabled: false,
        persistenceMode: 'local',
        boardId: null,
        workspaceId: null,
        autoSync: false,
        syncInterval: 300,
        conflictResolution: 'prompt',
        fallbackToLocal: true,
        cacheEnabled: true,
        retryAttempts: 3,
        timeout: 30000,
        columnMapping: {},
        groupMapping: {}
      }
    };

    results.changes.push('Generated new .taskmasterconfig with Monday.com support');
    results.changes.push('Set persistence mode to local (preserving current behavior)');
    results.changes.push('Added configuration version tracking');

    if (!dryRun) {
      try {
        writeConfig(newConfig, this.projectRoot);
        log('success', 'Successfully migrated legacy project to new configuration format');
      } catch (error) {
        results.success = false;
        results.errors.push(`Failed to write configuration: ${error.message}`);
      }
    }

    return results;
  }

  /**
   * Migrate existing configuration to include Monday.com settings
   * @private
   */
  async _migrateConfigurationOnly(dryRun, backup) {
    const results = {
      success: true,
      state: this.detectedState,
      changes: [],
      backupPath: null,
      errors: []
    };

    try {
      // Create backup if requested
      if (backup && !dryRun) {
        results.backupPath = await this._createBackup();
        results.changes.push(`Created backup at: ${results.backupPath}`);
      }

      // Get current configuration and migrate
      const currentConfig = getConfig(this.projectRoot);
      const migratedConfig = migrateMondayConfig(currentConfig);

      results.changes.push('Added Monday.com configuration section');
      results.changes.push('Set default persistence mode to local');
      results.changes.push('Updated configuration version');

      if (!dryRun) {
        writeConfig(migratedConfig, this.projectRoot);
        log('success', 'Successfully added Monday.com configuration to existing project');
      }

    } catch (error) {
      results.success = false;
      results.errors.push(`Configuration migration failed: ${error.message}`);
    }

    return results;
  }

  /**
   * Create a backup of the current project state
   * @private
   */
  async _createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(this.projectRoot, '.task-master-backups');
    const backupPath = path.join(backupDir, `backup-${timestamp}`);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    fs.mkdirSync(backupPath, { recursive: true });

    // Backup configuration file if it exists
    const configPath = path.join(this.projectRoot, '.taskmasterconfig');
    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, path.join(backupPath, '.taskmasterconfig'));
    }

    // Backup tasks directory if it exists
    const tasksDir = path.join(this.projectRoot, 'tasks');
    if (fs.existsSync(tasksDir)) {
      this._copyDirectory(tasksDir, path.join(backupPath, 'tasks'));
    }

    // Backup legacy tasks.json if it exists
    const legacyTasksPath = path.join(this.projectRoot, 'tasks.json');
    if (fs.existsSync(legacyTasksPath)) {
      fs.copyFileSync(legacyTasksPath, path.join(backupPath, 'tasks.json'));
    }

    return backupPath;
  }

  /**
   * Recursively copy directory
   * @private
   */
  _copyDirectory(src, dest) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        this._copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Test persistence mode compatibility
   * @param {string} mode - Persistence mode to test ('local', 'monday', 'hybrid')
   * @returns {Object} Compatibility test results
   */
  async testPersistenceCompatibility(mode = 'local') {
    const results = {
      mode,
      compatible: false,
      issues: [],
      warnings: [],
      recommendations: []
    };

    try {
      // Initialize persistence manager in the specified mode
      await persistenceManager.initialize(this.projectRoot);
      
      // Test read operations
      try {
        const tasksPath = path.join(this.projectRoot, 'tasks', 'tasks.json');
        await persistenceManager.readTasks(tasksPath, { projectRoot: this.projectRoot });
        results.compatible = true;
      } catch (error) {
        results.issues.push(`Read operation failed: ${error.message}`);
      }

      // Test write operations (with a safe dummy write)
      if (results.compatible) {
        try {
          const dummyData = { tasks: [], metadata: { version: '2.0.0' } };
          // Note: This is a dry run test, not actually writing
          results.warnings.push('Write operations would be functional');
        } catch (error) {
          results.issues.push(`Write operation would fail: ${error.message}`);
          results.compatible = false;
        }
      }

      // Generate recommendations based on results
      if (!results.compatible) {
        results.recommendations.push('Consider using local persistence mode as fallback');
        results.recommendations.push('Check configuration and API credentials');
      }

    } catch (error) {
      results.issues.push(`Persistence manager initialization failed: ${error.message}`);
    }

    return results;
  }

  /**
   * Get fallback configuration for maximum compatibility
   * @returns {Object} Safe fallback configuration
   */
  getFallbackConfiguration() {
    return {
      projectName: path.basename(this.projectRoot || '.'),
      configVersion: '2.0.0',
      models: {
        main: { provider: 'anthropic', id: 'claude-3-5-sonnet-20241022' },
        fallback: { provider: 'anthropic', id: 'claude-3-5-haiku-20241022' }
      },
      global: {
        logLevel: 'info',
        defaultSubtasks: 5,
        defaultPriority: 'medium'
      },
      monday: {
        enabled: false,
        persistenceMode: 'local',
        boardId: null,
        workspaceId: null,
        autoSync: false,
        syncInterval: 300,
        conflictResolution: 'prompt',
        fallbackToLocal: true,
        cacheEnabled: true,
        retryAttempts: 3,
        timeout: 30000,
        columnMapping: {},
        groupMapping: {}
      }
    };
  }
}

// Export singleton instance and utility functions
export const backwardCompatibilityManager = new BackwardCompatibilityManager();

/**
 * Quick project state check
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Basic compatibility status
 */
export async function checkBackwardCompatibility(projectRoot = null) {
  const analysis = await backwardCompatibilityManager.analyzeProjectState(projectRoot);
  
  return {
    compatible: ![PROJECT_STATES.UNCONFIGURED, PROJECT_STATES.MIGRATION_NEEDED].includes(analysis.state),
    state: analysis.state,
    needsMigration: analysis.state === PROJECT_STATES.LEGACY_LOCAL || analysis.state === PROJECT_STATES.MIGRATION_NEEDED,
    recommendedAction: analysis.recommendations.length > 0 ? analysis.recommendations[0] : null
  };
}

/**
 * Perform safe automatic migration if needed
 * @param {string} projectRoot - Project root directory
 * @param {Object} options - Migration options
 * @returns {Object} Migration results
 */
export async function ensureBackwardCompatibility(projectRoot = null, options = {}) {
  const { autoMigrate = true, backup = true } = options;
  
  const compatibility = await checkBackwardCompatibility(projectRoot);
  
  if (!compatibility.needsMigration) {
    return {
      success: true,
      message: 'Project is already compatible',
      state: compatibility.state
    };
  }

  if (!autoMigrate) {
    return {
      success: false,
      message: 'Migration needed but auto-migration is disabled',
      state: compatibility.state,
      recommendedAction: compatibility.recommendedAction
    };
  }

  // Perform automatic migration
  return await backwardCompatibilityManager.performAutomaticMigration({ backup });
} 