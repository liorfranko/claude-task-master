import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import pkg from '@aws-sdk/client-bedrock';
const { BedrockClient, ListFoundationModelsCommand } = pkg;
import { BaseAIProvider } from './base-provider.js';
import crypto from 'crypto';

// Polyfill for crypto in ESM environments
if (typeof globalThis.crypto === 'undefined') {
	globalThis.crypto = crypto;
}

export class BedrockAIProvider extends BaseAIProvider {
	constructor() {
		super();
		this.name = 'Bedrock';
	}

	/**
	 * Override auth validation - Bedrock uses AWS credentials instead of API keys
	 * @param {object} params - Parameters to validate
	 */
	validateAuth(params) {
		// Skip API key validation for Bedrock
		console.log('[DEBUG] Bedrock auth validation: Using AWS credentials (skipped API key check)');
		return true;
	}

	/**
	 * Get Bedrock client - now synchronous to match BaseAIProvider expectations
	 * @param {object} params - Parameters for client creation
	 */
	getClient(params) {
		try {
			const {
				profile = process.env.AWS_PROFILE || 'default',
				region = process.env.AWS_DEFAULT_REGION || 'us-east-1',
				modelId = params?.modelId || 'anthropic.claude-3-5-sonnet-20240620-v1:0'
			} = params || {};

			console.log(`[DEBUG] Creating Bedrock client for region: ${region}, profile: ${profile}`);
			console.log(`[DEBUG] Target model: ${modelId}`);

			// Create credential provider (this is sync)
			const credentialProvider = fromNodeProviderChain({ profile });

			// Create the AI SDK client (this is sync)
			console.log('[DEBUG] 🔧 Creating AI SDK Bedrock client...');
			const client = createAmazonBedrock({
				region,
				credentials: credentialProvider
			});

			console.log('[DEBUG] ✅ Bedrock client created successfully');
			console.log(`[DEBUG] Client type: ${typeof client}`);
			console.log(`[DEBUG] Client is function: ${typeof client === 'function'}`);

			if (typeof client !== 'function') {
				console.log('[ERROR] ❌ Client is not a function - this is unexpected');
				console.log(`[ERROR] Client constructor: ${client?.constructor?.name}`);
				console.log(`[ERROR] Client methods: ${Object.getOwnPropertyNames(client)}`);
				throw new Error('Bedrock client is not a function - unexpected AI SDK response');
			}

			return client;

		} catch (error) {
			console.log(`[ERROR] ❌ Bedrock client creation failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Optional: Validate AWS credentials and model availability
	 * This is separate from getClient to avoid blocking synchronous client creation
	 * @param {object} params - Parameters for validation
	 */
	async validateAwsSetup(params) {
		try {
			const {
				profile = process.env.AWS_PROFILE || 'default',
				region = process.env.AWS_DEFAULT_REGION || 'us-east-1',
				modelId = params?.modelId || 'anthropic.claude-3-5-sonnet-20240620-v1:0'
			} = params || {};

			// Test AWS credentials
			const credentialProvider = fromNodeProviderChain({ profile });
			let credentials;
			try {
				credentials = await credentialProvider();
				console.log(`[DEBUG] ✅ AWS credentials resolved successfully`);
				console.log(`[DEBUG] Access Key ID: ${credentials.accessKeyId?.substring(0, 8)}...`);
			} catch (credError) {
				console.log('[ERROR] ❌ Failed to resolve AWS credentials:');
				console.log(`[ERROR] Credential error: ${credError.message}`);
				console.log('[ERROR] Please check:');
				console.log('[ERROR] 1. AWS CLI is configured: aws configure');
				console.log('[ERROR] 2. AWS_PROFILE environment variable is set correctly');
				console.log('[ERROR] 3. AWS credentials file exists: ~/.aws/credentials');
				throw new Error(`AWS credential error: ${credError.message}`);
			}

			// Check if model is available in this region
			const bedrockClient = new BedrockClient({
				region,
				credentials: credentialProvider
			});

			try {
				console.log(`[DEBUG] 🔍 Checking if model ${modelId} is available in region ${region}...`);
				const listModelsCommand = new ListFoundationModelsCommand({});
				const modelsResponse = await bedrockClient.send(listModelsCommand);
				
				const availableModels = modelsResponse.modelSummaries || [];
				const targetModel = availableModels.find(model => model.modelId === modelId);
				
				if (!targetModel) {
					console.log(`[ERROR] ❌ Model ${modelId} not found in region ${region}`);
					console.log(`[ERROR] Available Anthropic models in ${region}:`);
					const anthropicModels = availableModels
						.filter(model => model.providerName === 'Anthropic')
						.map(model => `  - ${model.modelId} (${model.modelName}) - ${model.modelLifecycle?.status || 'UNKNOWN'}`);
					
					if (anthropicModels.length > 0) {
						anthropicModels.forEach(model => console.log(`[ERROR] ${model}`));
					} else {
						console.log('[ERROR] No Anthropic models found in this region');
					}
					
					throw new Error(`Model ${modelId} not available in region ${region}. Check available models above.`);
				}

				console.log(`[DEBUG] ✅ Model ${modelId} found and available`);
				console.log(`[DEBUG] Model details: ${targetModel.modelName} - Status: ${targetModel.modelLifecycle?.status}`);
				console.log(`[DEBUG] Supported inference types: ${targetModel.inferenceTypesSupported?.join(', ')}`);

				// Check if model requires special access
				if (targetModel.inferenceTypesSupported?.includes('INFERENCE_PROFILE') && 
				    !targetModel.inferenceTypesSupported?.includes('ON_DEMAND')) {
					console.log(`[WARN] ⚠️  Model ${modelId} requires INFERENCE_PROFILE access`);
					console.log(`[WARN] This may require special model access approval in your AWS account`);
					console.log(`[WARN] Consider using a model that supports ON_DEMAND access`);
				}

				return true;

			} catch (listError) {
				console.log(`[ERROR] ❌ Failed to list foundation models: ${listError.message}`);
				console.log('[ERROR] This might indicate:');
				console.log('[ERROR] 1. Insufficient IAM permissions for bedrock:ListFoundationModels');
				console.log('[ERROR] 2. Bedrock service not available in this region');
				console.log('[ERROR] 3. Network connectivity issues');
				throw new Error(`Failed to validate model availability: ${listError.message}`);
			}

		} catch (error) {
			console.log(`[ERROR] ❌ AWS setup validation failed: ${error.message}`);
			throw error;
		}
	}
}
