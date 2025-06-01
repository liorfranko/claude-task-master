#!/usr/bin/env node

/**
 * Test file for Monday.com Data Transformation Layer
 * 
 * This test validates all transformation functions including:
 * - Task to Monday.com transformations
 * - Monday.com to Task transformations  
 * - Batch transformations
 * - Data validation
 * - Round-trip transformation integrity
 */

import {
	transformTaskToMondayColumns,
	transformMondayItemToTask,
	transformMondayItemsToTasks,
	validateTransformedData,
	testRoundTripTransformation as performRoundTripTest,
	DATA_MAPPING_SCHEMA,
	STATUS_MAPPING,
	PRIORITY_MAPPING,
	TASK_TYPE_MAPPING
} from './scripts/modules/monday-data-transformer.js';

// Mock column mapping for testing
const mockColumnMapping = {
	task_id: 'task_id_col_123',
	name: 'name',
	description: 'desc_col_456',
	status: 'status_col_789',
	priority: 'priority_col_abc',
	dependencies: 'deps_col_def',
	parent_task: 'parent_col_ghi',
	details: 'details_col_jkl',
	test_strategy: 'test_col_mno',
	task_type: 'type_col_pqr',
	complexity_score: 'complex_col_stu',
	created_by: 'created_col_vwx',
	assigned_to: 'assigned_col_yz'
};

/**
 * Test data samples
 */
const sampleTasks = {
	basic: {
		id: 1,
		title: 'Basic Task',
		description: 'A simple task for testing',
		status: 'pending',
		dependencies: [],
		priority: 'medium',
		details: 'Basic implementation details',
		testStrategy: 'Unit test this functionality',
		subtasks: []
	},
	complex: {
		id: 2,
		title: 'Complex Task with Dependencies',
		description: 'A complex task with multiple dependencies and subtasks',
		status: 'in-progress',
		dependencies: [1, 3, 5],
		priority: 'high',
		details: 'Complex implementation with multiple components',
		testStrategy: 'Integration testing with mocked dependencies',
		subtasks: [
			{
				id: 1,
				title: 'Subtask 1',
				description: 'First subtask',
				status: 'done',
				dependencies: []
			},
			{
				id: 2,
				title: 'Subtask 2',
				description: 'Second subtask',
				status: 'pending',
				dependencies: [1]
			}
		],
		complexityScore: 8,
		taskType: 'feature'
	},
	subtask: {
		id: '2.1',
		title: 'Subtask Example',
		description: 'This is a subtask',
		status: 'review',
		dependencies: ['2'],
		priority: 'low',
		details: 'Subtask implementation',
		testStrategy: 'Test as part of parent task',
		parentTask: 2,
		taskType: 'subtask'
	},
	edgeCase: {
		id: 999,
		title: '',  // Empty title
		description: null,  // Null description
		status: 'unknown-status',  // Invalid status
		dependencies: 'invalid-deps',  // Invalid dependencies format
		priority: 'ultra-high',  // Invalid priority
		details: undefined,  // Undefined details
		testStrategy: '',
		subtasks: null  // Null subtasks
	}
};

const sampleMondayItems = {
	basic: {
		id: '123456789',
		name: 'Basic Monday Item',
		column_values: [
			{ id: 'task_id_col_123', value: '1', text: '1' },
			{ id: 'desc_col_456', value: 'Monday item description', text: 'Monday item description' },
			{ id: 'status_col_789', value: '1', text: 'Pending' },
			{ id: 'priority_col_abc', value: '2', text: 'Medium' },
			{ id: 'deps_col_def', value: '', text: '' },
			{ id: 'details_col_jkl', value: 'Monday implementation details', text: 'Monday implementation details' },
			{ id: 'test_col_mno', value: 'Monday test strategy', text: 'Monday test strategy' }
		]
	},
	complex: {
		id: '987654321',
		name: 'Complex Monday Item',
		column_values: [
			{ id: 'task_id_col_123', value: '5.2', text: '5.2' },
			{ id: 'desc_col_456', value: 'Complex Monday description', text: 'Complex Monday description' },
			{ id: 'status_col_789', value: '2', text: 'In Progress' },
			{ id: 'priority_col_abc', value: '3', text: 'High' },
			{ id: 'deps_col_def', value: '1,3,5', text: '1,3,5' },
			{ id: 'parent_col_ghi', value: '5', text: '5' },
			{ id: 'type_col_pqr', value: '1', text: 'Feature' },
			{ id: 'complex_col_stu', value: '7', text: '7' }
		]
	}
};

/**
 * Test Results tracking
 */
let testResults = {
	total: 0,
	passed: 0,
	failed: 0,
	errors: []
};

/**
 * Test runner utility
 */
function runTest(testName, testFunction) {
	testResults.total++;
	console.log(`\n🧪 Running: ${testName}`);
	
	try {
		const result = testFunction();
		if (result === true) {
			testResults.passed++;
			console.log(`✅ PASSED: ${testName}`);
			return true;
		} else {
			testResults.failed++;
			console.log(`❌ FAILED: ${testName}`);
			if (typeof result === 'string') {
				console.log(`   Reason: ${result}`);
				testResults.errors.push({ test: testName, reason: result });
			}
			return false;
		}
	} catch (error) {
		testResults.failed++;
		console.log(`❌ ERROR: ${testName}`);
		console.log(`   Error: ${error.message}`);
		testResults.errors.push({ test: testName, error: error.message });
		return false;
	}
}

/**
 * Test 1: Data Mapping Schema Validation
 */
function testDataMappingSchema() {
	console.log('\n📋 Testing Data Mapping Schema...');
	
	// Check that all required fields are present
	const requiredFields = ['id', 'title', 'description', 'status', 'priority', 'dependencies'];
	for (const field of requiredFields) {
		if (!DATA_MAPPING_SCHEMA[field]) {
			return `Missing required field '${field}' in DATA_MAPPING_SCHEMA`;
		}
	}
	
	// Check that all mapping entries have required properties
	for (const [field, mapping] of Object.entries(DATA_MAPPING_SCHEMA)) {
		if (!mapping.mondayColumn || !mapping.mondayType || !mapping.transform || !mapping.reverse) {
			return `Field '${field}' missing required mapping properties`;
		}
	}
	
	// Check status mappings
	if (Object.keys(STATUS_MAPPING.toMonday).length !== Object.keys(STATUS_MAPPING.fromMonday).length) {
		return 'Status mapping mismatch between toMonday and fromMonday';
	}
	
	return true;
}

/**
 * Test 2: Basic Task to Monday.com Transformation
 */
function testBasicTaskTransformation() {
	console.log('\n🔄 Testing Basic Task to Monday.com Transformation...');
	
	const result = transformTaskToMondayColumns(sampleTasks.basic, mockColumnMapping);
	
	if (!result.success) {
		return `Transformation failed: ${result.error}`;
	}
	
	// Check that required columns are present
	if (!result.columns['task_id_col_123'] || result.columns['task_id_col_123'] !== '1') {
		return 'Task ID not properly transformed';
	}
	
	if (result.metadata.itemName !== 'Basic Task') {
		return 'Item name not properly set in metadata';
	}
	
	if (result.metadata.group !== 'pending') {
		return 'Group not properly assigned based on status';
	}
	
	return true;
}

/**
 * Test 3: Complex Task Transformation
 */
function testComplexTaskTransformation() {
	console.log('\n🔧 Testing Complex Task Transformation...');
	
	const result = transformTaskToMondayColumns(sampleTasks.complex, mockColumnMapping);
	
	if (!result.success) {
		return `Transformation failed: ${result.error}`;
	}
	
	// Check dependencies transformation
	if (result.columns['deps_col_def'] !== '1,3,5') {
		return `Dependencies not properly transformed: ${result.columns['deps_col_def']}`;
	}
	
	// Check status transformation
	if (result.columns['status_col_789'] !== '2') {  // 'in-progress' -> '2'
		return `Status not properly transformed: ${result.columns['status_col_789']}`;
	}
	
	// Check priority transformation
	if (result.columns['priority_col_abc'] !== '3') {  // 'high' -> '3'
		return `Priority not properly transformed: ${result.columns['priority_col_abc']}`;
	}
	
	return true;
}

/**
 * Test 4: Subtask Transformation
 */
function testSubtaskTransformation() {
	console.log('\n👶 Testing Subtask Transformation...');
	
	const result = transformTaskToMondayColumns(sampleTasks.subtask, mockColumnMapping);
	
	if (!result.success) {
		return `Transformation failed: ${result.error}`;
	}
	
	// Check subtask ID handling
	if (result.columns['task_id_col_123'] !== '2.1') {
		return `Subtask ID not properly preserved: ${result.columns['task_id_col_123']}`;
	}
	
	// Check parent task reference
	if (result.columns['parent_col_ghi'] !== '2') {
		return `Parent task not properly set: ${result.columns['parent_col_ghi']}`;
	}
	
	return true;
}

/**
 * Test 5: Edge Case Handling
 */
function testEdgeCaseHandling() {
	console.log('\n⚠️ Testing Edge Case Handling...');
	
	const result = transformTaskToMondayColumns(sampleTasks.edgeCase, mockColumnMapping);
	
	if (!result.success) {
		return `Edge case transformation failed: ${result.error}`;
	}
	
	// Check that empty title gets default value
	if (result.metadata.itemName !== 'Untitled Task') {
		return `Empty title not handled properly: ${result.metadata.itemName}`;
	}
	
	// Check that invalid status gets mapped to default
	if (result.columns['status_col_789'] !== '1') {  // Should default to 'pending' -> '1'
		return `Invalid status not handled properly: ${result.columns['status_col_789']}`;
	}
	
	return true;
}

/**
 * Test 6: Monday.com to Task Transformation
 */
function testMondayToTaskTransformation() {
	console.log('\n🔄 Testing Monday.com to Task Transformation...');
	
	const result = transformMondayItemToTask(sampleMondayItems.basic, null, mockColumnMapping);
	
	if (!result.success) {
		return `Transformation failed: ${result.error}`;
	}
	
	const task = result.task;
	
	// Check basic properties
	if (task.id !== 1) {
		return `ID not properly transformed: ${task.id}`;
	}
	
	if (task.title !== 'Basic Monday Item') {
		return `Title not properly transformed: ${task.title}`;
	}
	
	if (task.status !== 'pending') {
		return `Status not properly transformed: ${task.status}`;
	}
	
	if (task.priority !== 'medium') {
		return `Priority not properly transformed: ${task.priority}`;
	}
	
	return true;
}

/**
 * Test 7: Complex Monday.com Item Transformation
 */
function testComplexMondayTransformation() {
	console.log('\n🔧 Testing Complex Monday.com Item Transformation...');
	
	const result = transformMondayItemToTask(sampleMondayItems.complex, null, mockColumnMapping);
	
	if (!result.success) {
		return `Transformation failed: ${result.error}`;
	}
	
	const task = result.task;
	
	// Check subtask ID handling
	if (task.id !== '5.2') {
		return `Subtask ID not properly preserved: ${task.id}`;
	}
	
	// Check dependencies array
	if (!Array.isArray(task.dependencies) || task.dependencies.length !== 3) {
		return `Dependencies not properly transformed: ${JSON.stringify(task.dependencies)}`;
	}
	
	if (task.dependencies[0] !== 1 || task.dependencies[1] !== 3 || task.dependencies[2] !== 5) {
		return `Dependencies values incorrect: ${JSON.stringify(task.dependencies)}`;
	}
	
	return true;
}

/**
 * Test 8: Batch Transformation
 */
function testBatchTransformation() {
	console.log('\n📦 Testing Batch Transformation...');
	
	const items = [sampleMondayItems.basic, sampleMondayItems.complex];
	const result = transformMondayItemsToTasks(items, null, mockColumnMapping);
	
	if (!result.success) {
		return `Batch transformation failed with errors: ${JSON.stringify(result.errors)}`;
	}
	
	if (result.tasks.length !== 2) {
		return `Expected 2 tasks, got ${result.tasks.length}`;
	}
	
	if (result.successfulTransformations !== 2) {
		return `Expected 2 successful transformations, got ${result.successfulTransformations}`;
	}
	
	// Check sorting (tasks should be sorted by ID)
	if (result.tasks[0].id !== 1 || result.tasks[1].id !== '5.2') {
		return `Tasks not properly sorted by ID`;
	}
	
	return true;
}

/**
 * Test 9: Data Validation
 */
function testDataValidation() {
	console.log('\n✅ Testing Data Validation...');
	
	// Test task to Monday validation
	const taskTransform = transformTaskToMondayColumns(sampleTasks.basic, mockColumnMapping);
	const validation1 = validateTransformedData(sampleTasks.basic, taskTransform, 'toMonday');
	
	if (!validation1.valid) {
		return `Task to Monday validation failed: ${JSON.stringify(validation1.errors)}`;
	}
	
	// Test Monday to task validation
	const mondayTransform = transformMondayItemToTask(sampleMondayItems.basic, null, mockColumnMapping);
	const validation2 = validateTransformedData(sampleMondayItems.basic, mondayTransform, 'toTask');
	
	if (!validation2.valid) {
		return `Monday to task validation failed: ${JSON.stringify(validation2.errors)}`;
	}
	
	return true;
}

/**
 * Test 10: Round-trip Transformation
 */
function testRoundTripTransformationFeature() {
	console.log('\n🔄 Testing Round-trip Transformation...');
	
	const result = performRoundTripTest(sampleTasks.basic, mockColumnMapping);
	
	if (!result.success) {
		return `Round-trip transformation failed: ${result.error}`;
	}
	
	// Check that essential data is preserved
	const original = result.originalTask;
	const final = result.transformedTask;
	
	if (original.id !== final.id) {
		return `ID not preserved: ${original.id} -> ${final.id}`;
	}
	
	if (original.title !== final.title) {
		return `Title not preserved: ${original.title} -> ${final.title}`;
	}
	
	if (original.status !== final.status) {
		return `Status not preserved: ${original.status} -> ${final.status}`;
	}
	
	return true;
}

/**
 * Test 11: Invalid Input Handling
 */
function testInvalidInputHandling() {
	console.log('\n🚫 Testing Invalid Input Handling...');
	
	// Test null task
	try {
		const result1 = transformTaskToMondayColumns(null, mockColumnMapping);
		if (result1.success) {
			return 'Should have failed with null task input';
		}
	} catch (error) {
		// Expected behavior
	}
	
	// Test invalid Monday item
	try {
		const result2 = transformMondayItemToTask(null, null, mockColumnMapping);
		if (result2.success) {
			return 'Should have failed with null Monday item input';
		}
	} catch (error) {
		// Expected behavior
	}
	
	// Test invalid batch input
	try {
		const result3 = transformMondayItemsToTasks('not-an-array', null, mockColumnMapping);
		if (result3.success) {
			return 'Should have failed with non-array batch input';
		}
	} catch (error) {
		// Expected behavior
	}
	
	return true;
}

/**
 * Run all tests
 */
async function runAllTests() {
	console.log('🚀 Starting Monday.com Data Transformation Layer Tests...\n');
	
	// Run all tests
	runTest('Data Mapping Schema Validation', testDataMappingSchema);
	runTest('Basic Task to Monday.com Transformation', testBasicTaskTransformation);
	runTest('Complex Task Transformation', testComplexTaskTransformation);
	runTest('Subtask Transformation', testSubtaskTransformation);
	runTest('Edge Case Handling', testEdgeCaseHandling);
	runTest('Monday.com to Task Transformation', testMondayToTaskTransformation);
	runTest('Complex Monday.com Item Transformation', testComplexMondayTransformation);
	runTest('Batch Transformation', testBatchTransformation);
	runTest('Data Validation', testDataValidation);
	runTest('Round-trip Transformation', testRoundTripTransformationFeature);
	runTest('Invalid Input Handling', testInvalidInputHandling);
	
	// Display results
	console.log('\n' + '='.repeat(50));
	console.log('📊 TEST RESULTS SUMMARY');
	console.log('='.repeat(50));
	console.log(`Total Tests: ${testResults.total}`);
	console.log(`✅ Passed: ${testResults.passed}`);
	console.log(`❌ Failed: ${testResults.failed}`);
	console.log(`📈 Success Rate: ${((testResults.passed / testResults.total) * 100).toFixed(1)}%`);
	
	if (testResults.failed > 0) {
		console.log('\n❌ FAILED TESTS:');
		testResults.errors.forEach((error, index) => {
			console.log(`${index + 1}. ${error.test}`);
			if (error.reason) console.log(`   Reason: ${error.reason}`);
			if (error.error) console.log(`   Error: ${error.error}`);
		});
	}
	
	if (testResults.passed === testResults.total) {
		console.log('\n🎉 All tests passed! Data transformation layer is working correctly.');
		process.exit(0);
	} else {
		console.log('\n⚠️ Some tests failed. Please review the implementation.');
		process.exit(1);
	}
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
	runAllTests().catch(error => {
		console.error('❌ Test execution failed:', error);
		process.exit(1);
	});
} 