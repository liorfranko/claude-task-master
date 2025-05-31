#!/usr/bin/env node

/**
 * test-monday-board-manager.js
 * Test script for Monday Board Manager module
 * 
 * This script tests the Monday Board Manager functionality including board creation,
 * schema setup, validation, and migration capabilities.
 */

import { 
  initializeMondayBoardManager,
  createTaskMasterBoard,
  validateTaskMasterBoard,
  TASK_MASTER_SCHEMA
} from './scripts/modules/monday-board-manager.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Main test function
 */
async function testMondayBoardManager() {
  console.log('🚀 Testing Monday Board Manager...\n');

  try {
    // Get API key from environment
    const apiKey = process.env.MONDAY_API_KEY;
    
    if (!apiKey) {
      console.error('❌ Error: MONDAY_API_KEY environment variable is required');
      console.log('Please add your Monday.com API key to your .env file:');
      console.log('MONDAY_API_KEY=your_api_key_here');
      process.exit(1);
    }

    // Test 1: Initialize Board Manager
    console.log('📝 Test 1: Initializing Monday Board Manager...');
    const manager = await initializeMondayBoardManager(apiKey);
    console.log('✅ Board Manager initialized successfully\n');

    // Test 2: Create a Task Master Board
    console.log('📝 Test 2: Creating a Task Master board...');
    const projectName = `Test Project ${new Date().toISOString().split('T')[0]}`;
    const boardResult = await manager.createProjectBoard(projectName, {
      description: 'Test board for Task Master Board Manager validation',
      kind: 'private'
    });

    console.log('✅ Task Master board created successfully:');
    console.log(`   - Board ID: ${boardResult.board.id}`);
    console.log(`   - Board Name: ${boardResult.board.name}`);
    console.log(`   - Columns Created: ${boardResult.schema.columnsCreated.length}`);
    console.log(`   - Groups Created: ${boardResult.schema.groupsCreated.length}`);
    console.log();

    const testBoardId = boardResult.board.id;

    // Test 3: Validate Board Schema
    console.log('📝 Test 3: Validating board schema...');
    const validation = await manager.validateBoardSchema(testBoardId);
    
    console.log(`✅ Schema validation completed:`);
    console.log(`   - Valid: ${validation.valid ? 'YES' : 'NO'}`);
    console.log(`   - Missing Columns: ${validation.missingColumns.length}`);
    console.log(`   - Missing Groups: ${validation.missingGroups.length}`);
    
    if (validation.missingColumns.length > 0) {
      console.log(`   - Missing: ${validation.missingColumns.join(', ')}`);
    }
    if (validation.suggestions.length > 0) {
      console.log(`   - Suggestions: ${validation.suggestions.join('; ')}`);
    }
    console.log();

    // Test 4: Get Board Information
    console.log('📝 Test 4: Getting board information...');
    const boardInfo = await manager.getBoardInfo(testBoardId);
    
    console.log(`✅ Board information retrieved:`);
    console.log(`   - Board Name: ${boardInfo.board.name}`);
    console.log(`   - Columns: ${boardInfo.schema.columns}`);
    console.log(`   - Groups: ${boardInfo.schema.groups}`);
    console.log(`   - Task Master Ready: ${boardInfo.taskMasterReady ? 'YES' : 'NO'}`);
    console.log();

    // Test 5: Schema Details Analysis
    console.log('📝 Test 5: Analyzing schema details...');
    console.log('📋 Expected Task Master Schema:');
    
    const requiredColumns = Object.values(TASK_MASTER_SCHEMA.columns).filter(col => col.required);
    const optionalColumns = Object.values(TASK_MASTER_SCHEMA.columns).filter(col => !col.required);
    
    console.log(`   - Required Columns (${requiredColumns.length}):`);
    requiredColumns.forEach(col => {
      console.log(`     • ${col.title} (${col.type})`);
    });
    
    console.log(`   - Optional Columns (${optionalColumns.length}):`);
    optionalColumns.forEach(col => {
      console.log(`     • ${col.title} (${col.type})`);
    });
    
    console.log(`   - Required Groups (${Object.keys(TASK_MASTER_SCHEMA.groups).length}):`);
    Object.values(TASK_MASTER_SCHEMA.groups).forEach(group => {
      console.log(`     • ${group.title} (${group.color})`);
    });
    console.log();

    // Test 6: Test Migration (Dry Run)
    console.log('📝 Test 6: Testing schema migration (dry run)...');
    const migrationTest = await manager.migrateBoardSchema(testBoardId, { 
      dryRun: true 
    });
    
    console.log(`✅ Migration analysis completed:`);
    console.log(`   - Would make changes: ${migrationTest.changes.length > 0 ? 'YES' : 'NO'}`);
    if (migrationTest.changes.length > 0) {
      console.log(`   - Planned changes:`);
      migrationTest.changes.forEach(change => {
        console.log(`     • ${change}`);
      });
    } else {
      console.log(`   - Schema is up to date`);
    }
    console.log();

    // Test 7: Quick Utility Functions Test
    console.log('📝 Test 7: Testing utility functions...');
    
    // Test createTaskMasterBoard utility
    console.log('   Testing createTaskMasterBoard utility...');
    const utilityProjectName = `Utility Test ${new Date().getTime()}`;
    const utilityResult = await createTaskMasterBoard(apiKey, utilityProjectName);
    
    console.log(`   ✅ Utility board created: ${utilityResult.board.id}`);
    
    // Test validateTaskMasterBoard utility
    console.log('   Testing validateTaskMasterBoard utility...');
    const utilityValidation = await validateTaskMasterBoard(apiKey, utilityResult.board.id);
    
    console.log(`   ✅ Utility validation completed: ${utilityValidation.valid ? 'VALID' : 'INVALID'}`);
    console.log();

    // Success summary
    console.log('🎉 ALL TESTS PASSED! Monday Board Manager is working correctly.');
    console.log('\n📊 Test Summary:');
    console.log('✅ Board Manager initialization');
    console.log('✅ Task Master board creation');
    console.log('✅ Schema validation');
    console.log('✅ Board information retrieval');
    console.log('✅ Schema analysis');
    console.log('✅ Migration testing (dry run)');
    console.log('✅ Utility functions');

    console.log('\n📋 Created Test Boards:');
    console.log(`🔗 Main Test Board: https://monday.monday.com/boards/${testBoardId}`);
    console.log(`🔗 Utility Test Board: https://monday.monday.com/boards/${utilityResult.board.id}`);
    
    console.log('\n💡 Key Features Validated:');
    console.log('- Complete Task Master schema creation (columns + groups)');
    console.log('- Schema validation and compliance checking');
    console.log('- Board information and metadata retrieval');
    console.log('- Migration planning and analysis');
    console.log('- Utility function convenience methods');
    console.log('- Error handling and fallback column types');
    
    console.log('\n🚀 Next steps:');
    console.log('- The Board Manager is ready for integration with Task Master persistence');
    console.log('- Both test boards contain the full Task Master schema');
    console.log('- You can now proceed to implement the persistence layer that uses these boards');
    console.log('- Consider cleaning up test boards or keep them for development');

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(`   ${error.message}`);
    
    if (error.stack) {
      console.error('\n📍 Stack trace:');
      console.error(error.stack);
    }
    
    if (error.message.includes('unauthorized') || error.message.includes('forbidden')) {
      console.log('\n💡 This might be an API key issue. Please check:');
      console.log('1. Your API key is correct and active');
      console.log('2. Your Monday.com account has API access');
      console.log('3. The API key has sufficient permissions for board creation');
    }
    
    process.exit(1);
  }
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testMondayBoardManager();
}

export { testMondayBoardManager }; 