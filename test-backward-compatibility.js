#!/usr/bin/env node

/**
 * test-backward-compatibility.js
 * Comprehensive Backward Compatibility Test Suite
 * 
 * Tests the backward compatibility manager and persistence manager
 * to ensure seamless operation between local and Monday.com persistence modes.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';

// Import modules to test
import { 
  BackwardCompatibilityManager, 
  PROJECT_STATES, 
  checkBackwardCompatibility, 
  ensureBackwardCompatibility 
} from './scripts/modules/backward-compatibility.js';
import { persistenceManager } from './scripts/modules/persistence-manager.js';
import { log } from './scripts/modules/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test configuration
const TEST_ROOT = path.join(__dirname, 'test-compat-projects');
const CLEANUP_ON_SUCCESS = true;

/**
 * Test runner class
 */
class BackwardCompatibilityTestRunner {
  constructor() {
    this.testResults = [];
    this.totalTests = 0;
    this.passedTests = 0;
  }

  /**
   * Run a single test case
   */
  async runTest(testName, testFunction) {
    this.totalTests++;
    console.log(chalk.blue(`\n🧪 Running: ${testName}`));
    
    try {
      const result = await testFunction();
      if (result.success) {
        this.passedTests++;
        console.log(chalk.green(`   ✅ PASSED: ${result.message || 'Test completed successfully'}`));
        if (result.details) {
          console.log(chalk.gray(`      ${result.details}`));
        }
      } else {
        console.log(chalk.red(`   ❌ FAILED: ${result.message || 'Test failed'}`));
        if (result.error) {
          console.log(chalk.gray(`      Error: ${result.error}`));
        }
      }
      
      this.testResults.push({ name: testName, ...result });
      return result;
    } catch (error) {
      console.log(chalk.red(`   ❌ FAILED: ${testName} threw an exception`));
      console.log(chalk.gray(`      Error: ${error.message}`));
      this.testResults.push({ 
        name: testName, 
        success: false, 
        message: 'Exception thrown', 
        error: error.message 
      });
      return { success: false, message: 'Exception thrown', error: error.message };
    }
  }

  /**
   * Create a test project directory with specific state
   */
  createTestProject(projectName, state) {
    const projectPath = path.join(TEST_ROOT, projectName);
    
    // Clean up if exists
    if (fs.existsSync(projectPath)) {
      fs.rmSync(projectPath, { recursive: true });
    }
    
    fs.mkdirSync(projectPath, { recursive: true });

    switch (state) {
      case PROJECT_STATES.LEGACY_LOCAL:
        // Create legacy tasks.json without config
        fs.writeFileSync(path.join(projectPath, 'tasks.json'), JSON.stringify({
          tasks: [
            { id: 1, title: 'Legacy Task', description: 'A legacy task', status: 'pending' }
          ]
        }, null, 2));
        break;

      case PROJECT_STATES.MIGRATION_NEEDED:
        // Create config without Monday.com settings
        fs.writeFileSync(path.join(projectPath, '.taskmasterconfig'), JSON.stringify({
          projectName: 'Migration Test',
          models: { main: { provider: 'anthropic' } },
          global: { logLevel: 'info' }
        }, null, 2));
        
        // Create modern tasks structure
        fs.mkdirSync(path.join(projectPath, 'tasks'));
        fs.writeFileSync(path.join(projectPath, 'tasks', 'tasks.json'), JSON.stringify({
          tasks: [
            { id: 1, title: 'Modern Task', description: 'A modern task', status: 'pending' }
          ]
        }, null, 2));
        break;

      case PROJECT_STATES.CONFIGURED_LOCAL:
        // Create complete configuration with local mode
        fs.writeFileSync(path.join(projectPath, '.taskmasterconfig'), JSON.stringify({
          projectName: 'Local Test',
          configVersion: '2.0.0',
          models: { main: { provider: 'anthropic' } },
          global: { logLevel: 'info' },
          monday: {
            enabled: false,
            persistenceMode: 'local',
            boardId: null
          }
        }, null, 2));
        
        fs.mkdirSync(path.join(projectPath, 'tasks'));
        fs.writeFileSync(path.join(projectPath, 'tasks', 'tasks.json'), JSON.stringify({
          tasks: [
            { id: 1, title: 'Configured Task', description: 'A properly configured task', status: 'pending' }
          ]
        }, null, 2));
        break;

      case PROJECT_STATES.UNCONFIGURED:
        // Empty directory
        break;
    }

    return projectPath;
  }

  /**
   * Test project state detection
   */
  async testProjectStateDetection() {
    const compatManager = new BackwardCompatibilityManager();
    const testCases = [
      { state: PROJECT_STATES.LEGACY_LOCAL, name: 'legacy-local' },
      { state: PROJECT_STATES.MIGRATION_NEEDED, name: 'migration-needed' },
      { state: PROJECT_STATES.CONFIGURED_LOCAL, name: 'configured-local' },
      { state: PROJECT_STATES.UNCONFIGURED, name: 'unconfigured' }
    ];

    let allPassed = true;
    const results = [];

    for (const testCase of testCases) {
      const projectPath = this.createTestProject(testCase.name, testCase.state);
      const analysis = await compatManager.analyzeProjectState(projectPath);
      
      const passed = analysis.state === testCase.state;
      allPassed = allPassed && passed;
      
      results.push({
        expected: testCase.state,
        actual: analysis.state,
        passed,
        recommendations: analysis.recommendations.length
      });
    }

    return {
      success: allPassed,
      message: allPassed ? 'All project states detected correctly' : 'Some project states incorrectly detected',
      details: `Tested ${testCases.length} project states with ${results.filter(r => r.passed).length} correct detections`
    };
  }

  /**
   * Test automatic migration functionality
   */
  async testAutomaticMigration() {
    const compatManager = new BackwardCompatibilityManager();
    
    // Test legacy local migration
    const legacyProject = this.createTestProject('migration-legacy', PROJECT_STATES.LEGACY_LOCAL);
    const legacyResult = await compatManager.performAutomaticMigration();
    
    if (!legacyResult.success) {
      return {
        success: false,
        message: 'Legacy project migration failed',
        error: legacyResult.errors.join(', ')
      };
    }

    // Verify migration result
    const configPath = path.join(legacyProject, '.taskmasterconfig');
    if (!fs.existsSync(configPath)) {
      return {
        success: false,
        message: 'Migration did not create configuration file'
      };
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!config.monday || config.monday.persistenceMode !== 'local') {
      return {
        success: false,
        message: 'Migration did not configure Monday.com settings correctly'
      };
    }

    return {
      success: true,
      message: 'Automatic migration completed successfully',
      details: `Migrated legacy project with ${legacyResult.changes.length} changes`
    };
  }

  /**
   * Test persistence manager initialization and fallback
   */
  async testPersistenceManagerFallback() {
    // Test with a configured local project
    const localProject = this.createTestProject('persistence-local', PROJECT_STATES.CONFIGURED_LOCAL);
    
    const initResult = await persistenceManager.initialize(localProject);
    
    if (!initResult.success || initResult.mode !== 'local') {
      return {
        success: false,
        message: 'Persistence manager failed to initialize in local mode',
        error: initResult.error
      };
    }

    // Test read operation
    const tasksPath = path.join(localProject, 'tasks', 'tasks.json');
    const readResult = await persistenceManager.readTasks(tasksPath, { projectRoot: localProject });
    
    if (!readResult || !readResult.tasks) {
      return {
        success: false,
        message: 'Failed to read tasks using persistence manager'
      };
    }

    // Test write operation
    const testData = {
      tasks: [
        { id: 1, title: 'Test Task', description: 'Test', status: 'pending' },
        { id: 2, title: 'Another Task', description: 'Another test', status: 'done' }
      ]
    };
    
    const writeResult = await persistenceManager.writeTasks(tasksPath, testData, { projectRoot: localProject });
    
    if (!writeResult) {
      return {
        success: false,
        message: 'Failed to write tasks using persistence manager'
      };
    }

    return {
      success: true,
      message: 'Persistence manager operations completed successfully',
      details: `Mode: ${initResult.mode}, Fallback: ${initResult.fallbackActive ? 'Active' : 'Inactive'}`
    };
  }

  /**
   * Test legacy file location compatibility
   */
  async testLegacyFileCompatibility() {
    // Create a project with legacy tasks.json location
    const legacyProject = this.createTestProject('legacy-file', PROJECT_STATES.LEGACY_LOCAL);
    
    // Initialize persistence manager
    await persistenceManager.initialize(legacyProject);
    
    // Try to read from modern path (should fallback to legacy)
    const modernPath = path.join(legacyProject, 'tasks', 'tasks.json');
    const readResult = await persistenceManager.readTasks(modernPath, { projectRoot: legacyProject });
    
    if (!readResult || !readResult.tasks || readResult.tasks.length === 0) {
      return {
        success: false,
        message: 'Failed to read legacy tasks.json from modern path'
      };
    }

    return {
      success: true,
      message: 'Legacy file location compatibility working correctly',
      details: `Successfully read ${readResult.tasks.length} tasks from legacy location`
    };
  }

  /**
   * Test configuration compatibility utility functions
   */
  async testCompatibilityUtilities() {
    const legacyProject = this.createTestProject('utility-test', PROJECT_STATES.LEGACY_LOCAL);
    
    // Test checkBackwardCompatibility
    const compatCheck = await checkBackwardCompatibility(legacyProject);
    
    if (!compatCheck.needsMigration || compatCheck.state !== PROJECT_STATES.LEGACY_LOCAL) {
      return {
        success: false,
        message: 'checkBackwardCompatibility failed to detect migration need'
      };
    }

    // Test ensureBackwardCompatibility
    const ensureResult = await ensureBackwardCompatibility(legacyProject, { autoMigrate: true });
    
    if (!ensureResult.success) {
      return {
        success: false,
        message: 'ensureBackwardCompatibility failed',
        error: ensureResult.message
      };
    }

    // Verify migration was applied
    const postCheck = await checkBackwardCompatibility(legacyProject);
    
    if (postCheck.needsMigration) {
      return {
        success: false,
        message: 'Migration was applied but compatibility check still shows migration needed'
      };
    }

    return {
      success: true,
      message: 'Compatibility utility functions working correctly',
      details: `State transition: ${compatCheck.state} → ${postCheck.state}`
    };
  }

  /**
   * Test error handling and recovery
   */
  async testErrorHandling() {
    // Create a project with corrupted configuration
    const corruptProject = this.createTestProject('corrupt-test', PROJECT_STATES.CONFIGURED_LOCAL);
    const configPath = path.join(corruptProject, '.taskmasterconfig');
    
    // Corrupt the configuration file
    fs.writeFileSync(configPath, '{ invalid json content');
    
    // Test that persistence manager handles corruption gracefully
    const initResult = await persistenceManager.initialize(corruptProject);
    
    if (!initResult.success && !initResult.fallbackActive) {
      return {
        success: false,
        message: 'Persistence manager did not handle corrupted config gracefully'
      };
    }

    // Should have fallen back to local mode
    if (initResult.mode !== 'local') {
      return {
        success: false,
        message: 'Failed to fallback to local mode with corrupted config'
      };
    }

    return {
      success: true,
      message: 'Error handling and recovery working correctly',
      details: `Recovered to ${initResult.mode} mode with fallback active`
    };
  }

  /**
   * Clean up test artifacts
   */
  cleanup() {
    if (fs.existsSync(TEST_ROOT)) {
      fs.rmSync(TEST_ROOT, { recursive: true });
    }
  }

  /**
   * Display final test results
   */
  displayResults() {
    console.log(chalk.blue.bold('\n📊 BACKWARD COMPATIBILITY TEST RESULTS'));
    console.log(chalk.blue('=' .repeat(50)));
    
    const successRate = ((this.passedTests / this.totalTests) * 100).toFixed(1);
    
    console.log(chalk.white(`Total Tests: ${this.totalTests}`));
    console.log(chalk.green(`Passed: ${this.passedTests}`));
    console.log(chalk.red(`Failed: ${this.totalTests - this.passedTests}`));
    console.log(chalk.white(`Success Rate: ${successRate}%`));
    
    if (this.passedTests === this.totalTests) {
      console.log(chalk.green.bold('\n🎉 ALL TESTS PASSED! Backward compatibility is working correctly.'));
    } else {
      console.log(chalk.red.bold('\n⚠️  SOME TESTS FAILED. Please review the failures above.'));
    }

    return this.passedTests === this.totalTests;
  }

  /**
   * Run all backward compatibility tests
   */
  async runAllTests() {
    console.log(chalk.blue.bold('🚀 STARTING BACKWARD COMPATIBILITY TEST SUITE'));
    console.log(chalk.blue('Testing seamless operation between local and Monday.com persistence modes\n'));

    // Setup test environment
    if (fs.existsSync(TEST_ROOT)) {
      fs.rmSync(TEST_ROOT, { recursive: true });
    }
    fs.mkdirSync(TEST_ROOT, { recursive: true });

    try {
      // Run all test cases
      await this.runTest('Project State Detection', () => this.testProjectStateDetection());
      await this.runTest('Automatic Migration', () => this.testAutomaticMigration());
      await this.runTest('Persistence Manager Fallback', () => this.testPersistenceManagerFallback());
      await this.runTest('Legacy File Location Compatibility', () => this.testLegacyFileCompatibility());
      await this.runTest('Compatibility Utility Functions', () => this.testCompatibilityUtilities());
      await this.runTest('Error Handling and Recovery', () => this.testErrorHandling());

    } catch (error) {
      console.log(chalk.red(`\n💥 Test suite encountered an error: ${error.message}`));
      console.log(chalk.gray(error.stack));
    } finally {
      // Display results
      const allPassed = this.displayResults();
      
      // Cleanup
      if (CLEANUP_ON_SUCCESS && allPassed) {
        this.cleanup();
        console.log(chalk.gray('\n🧹 Test artifacts cleaned up.'));
      } else {
        console.log(chalk.yellow(`\n📁 Test artifacts preserved at: ${TEST_ROOT}`));
      }

      return allPassed;
    }
  }
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const testRunner = new BackwardCompatibilityTestRunner();
  
  testRunner.runAllTests()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error(chalk.red('Test suite failed to run:'), error);
      process.exit(1);
    });
}

export { BackwardCompatibilityTestRunner }; 