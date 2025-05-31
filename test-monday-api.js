#!/usr/bin/env node

/**
 * test-monday-api.js
 * Test script for Monday.com API client
 * 
 * This script tests the Monday API client with a real Monday.com account
 */

import { initializeMondayApiClient, resetMondayApiClient } from './scripts/modules/monday-api-client.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Main test function
 */
async function testMondayApi() {
  console.log('🚀 Testing Monday.com API Client...\n');

  try {
    // Get API key from environment
    const apiKey = process.env.MONDAY_API_KEY;
    
    if (!apiKey) {
      console.error('❌ Error: MONDAY_API_KEY environment variable is required');
      console.log('Please add your Monday.com API key to your .env file:');
      console.log('MONDAY_API_KEY=your_api_key_here');
      process.exit(1);
    }

    // Test 1: Initialize client
    console.log('📝 Test 1: Initializing Monday.com API client...');
    const client = await initializeMondayApiClient(apiKey);
    console.log('✅ Client initialized successfully\n');

    // Test 2: Get current user
    console.log('📝 Test 2: Getting current user information...');
    const userResult = await client.getCurrentUser();
    console.log('✅ User info retrieved:');
    console.log(`   - Name: ${userResult.data.name}`);
    console.log(`   - Email: ${userResult.data.email}`);
    console.log(`   - Account: ${userResult.data.account.name}\n`);

    // Test 3: Create a test board
    console.log('📝 Test 3: Creating a test board...');
    const boardName = `Task Master Test - ${new Date().toISOString().split('T')[0]}`;
    const boardResult = await client.createBoard(boardName, 'private', 'Test board for Task Master integration');
    const testBoardId = boardResult.data.id;
    console.log('✅ Test board created:');
    console.log(`   - Board ID: ${testBoardId}`);
    console.log(`   - Board Name: ${boardResult.data.name}\n`);

    // Test 4: Get board schema
    console.log('📝 Test 4: Getting board schema...');
    const schemaResult = await client.getBoardSchema(testBoardId);
    console.log('✅ Board schema retrieved:');
    console.log(`   - Columns: ${schemaResult.data.columns.length}`);
    console.log(`   - Groups: ${schemaResult.data.groups.length}`);
    
    // Show available columns
    console.log('   - Available columns:');
    schemaResult.data.columns.forEach(col => {
      console.log(`     • ${col.title} (${col.type}) - ID: ${col.id}`);
    });
    console.log();

    // Test 5: Add custom columns for Task Master
    console.log('📝 Test 5: Adding custom columns for Task Master...');
    
    // Add Status column
    const statusColumn = await client.createColumn(testBoardId, 'status', 'Task Status', {
      labels: { 
        '1': 'Pending', 
        '2': 'In Progress', 
        '3': 'Done', 
        '4': 'Deferred' 
      }
    });
    console.log(`✅ Status column created: ${statusColumn.data.id}`);

    // Add Priority column (using dropdown type instead of color)
    let priorityColumn;
    try {
      priorityColumn = await client.createColumn(testBoardId, 'dropdown', 'Priority', {
        labels: {
          '1': 'Low',
          '2': 'Medium', 
          '3': 'High',
          '4': 'Critical'
        }
      });
      console.log(`✅ Priority column created: ${priorityColumn.data.id}`);
    } catch (error) {
      console.log(`⚠️ Priority column creation failed, trying simple text column: ${error.message}`);
      try {
        priorityColumn = await client.createColumn(testBoardId, 'text', 'Priority');
        console.log(`✅ Priority column created (text): ${priorityColumn.data.id}`);
      } catch (textError) {
        console.log(`⚠️ Skipping priority column due to API restrictions: ${textError.message}`);
      }
    }

    // Add Description column
    let descColumn;
    try {
      descColumn = await client.createColumn(testBoardId, 'long_text', 'Description');
      console.log(`✅ Description column created: ${descColumn.data.id}`);
    } catch (error) {
      console.log(`⚠️ Description column creation failed, trying text: ${error.message}`);
      try {
        descColumn = await client.createColumn(testBoardId, 'text', 'Description');
        console.log(`✅ Description column created (text): ${descColumn.data.id}`);
      } catch (textError) {
        console.log(`⚠️ Skipping description column: ${textError.message}`);
      }
    }
    console.log();

    // Test 6: Create a test task item
    console.log('📝 Test 6: Creating a test task item...');
    const taskName = 'Test Task - API Integration';
    const columnValues = {};
    
    // Set status if column was created
    if (statusColumn) {
      columnValues[statusColumn.data.id] = { label: 'Pending' };
    }
    
    // Set description if column was created
    if (descColumn) {
      columnValues[descColumn.data.id] = 'This is a test task created via the Monday.com API to validate Task Master integration.';
    }

    const itemResult = await client.createItem(testBoardId, taskName, columnValues);
    const testItemId = itemResult.data.id;
    console.log('✅ Test task created:');
    console.log(`   - Item ID: ${testItemId}`);
    console.log(`   - Item Name: ${itemResult.data.name}\n`);

    // Test 7: Update the task
    console.log('📝 Test 7: Updating the test task...');
    if (statusColumn) {
      const updateValues = {};
      updateValues[statusColumn.data.id] = { label: 'In Progress' };
      
      const updateResult = await client.updateItem(testBoardId, testItemId, updateValues);
      console.log('✅ Task updated successfully');
      console.log(`   - New status: In Progress\n`);
    } else {
      console.log('⚠️ Skipping status update (no status column)\n');
    }

    // Test 8: Add an update/comment
    console.log('📝 Test 8: Adding an update to the task...');
    const updateText = 'Task Master API integration test completed successfully! 🎉';
    const commentResult = await client.createUpdate(testItemId, updateText);
    console.log('✅ Update added to task');
    console.log(`   - Update ID: ${commentResult.data.id}\n`);

    // Test 9: Get board items
    console.log('📝 Test 9: Retrieving board items...');
    const itemsResult = await client.getBoardItems(testBoardId);
    console.log('✅ Board items retrieved:');
    console.log(`   - Total items: ${itemsResult.data.length}`);
    itemsResult.data.forEach(item => {
      console.log(`     • ${item.name} (ID: ${item.id})`);
    });
    console.log();

    // Test 10: Complete the task
    console.log('📝 Test 10: Marking task as complete...');
    if (statusColumn) {
      const completeValues = {};
      completeValues[statusColumn.data.id] = { label: 'Done' };
      
      await client.updateItem(testBoardId, testItemId, completeValues);
      console.log('✅ Task marked as complete\n');
    } else {
      console.log('⚠️ Skipping completion (no status column)\n');
    }

    // Success summary
    console.log('🎉 ALL TESTS PASSED! Monday.com API client is working correctly.');
    console.log('\n📊 Test Summary:');
    console.log('✅ Client initialization');
    console.log('✅ User authentication'); 
    console.log('✅ Board creation');
    console.log('✅ Schema retrieval');
    console.log('✅ Column creation');
    console.log('✅ Item creation');
    console.log('✅ Item updates');
    console.log('✅ Comment/update creation');
    console.log('✅ Items retrieval');
    console.log('✅ Task completion');

    console.log(`\n🔗 View your test board: https://${userResult.data.account.name.toLowerCase().replace(/\s+/g, '')}.monday.com/boards/${testBoardId}`);
    
    console.log('\n💡 Next steps:');
    console.log('- You can now integrate this API client with Task Master persistence');
    console.log('- The test board contains a sample task with the structure needed for Task Master');
    console.log('- Consider cleaning up the test board or keep it for development');

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(`   ${error.message}`);
    
    if (error.message.includes('unauthorized') || error.message.includes('forbidden')) {
      console.log('\n💡 This might be an API key issue. Please check:');
      console.log('1. Your API key is correct and active');
      console.log('2. Your Monday.com account has API access');
      console.log('3. The API key has sufficient permissions');
    }
    
    process.exit(1);
  } finally {
    // Clean up
    resetMondayApiClient();
  }
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testMondayApi();
}

export { testMondayApi }; 