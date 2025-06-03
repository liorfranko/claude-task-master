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

			// Create credential provider (this is sync)
			const credentialProvider = fromNodeProviderChain({ profile });

			// Create the AI SDK client (this is sync)
			const client = createAmazonBedrock({
				region,
				credentials: credentialProvider
			});

			if (typeof client !== 'function') {
				throw new Error('Bedrock client is not a function - unexpected AI SDK response');
			}

			return client;

		} catch (error) {
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
			} catch (credError) {
				throw new Error(`AWS credential error: ${credError.message}`);
			}

			// Check if model is available in this region
			const bedrockClient = new BedrockClient({
				region,
				credentials: credentialProvider
			});

			try {
				const listModelsCommand = new ListFoundationModelsCommand({});
				const modelsResponse = await bedrockClient.send(listModelsCommand);
				
				const availableModels = modelsResponse.modelSummaries || [];
				const targetModel = availableModels.find(model => model.modelId === modelId);
				
				if (!targetModel) {
					const anthropicModels = availableModels
						.filter(model => model.providerName === 'Anthropic')
						.map(model => `  - ${model.modelId} (${model.modelName}) - ${model.modelLifecycle?.status || 'UNKNOWN'}`);
					
					throw new Error(`Model ${modelId} not available in region ${region}. Check available models above.`);
				}

				// Check if model requires special access - no logging, just return
				if (targetModel.inferenceTypesSupported?.includes('INFERENCE_PROFILE') && 
				    !targetModel.inferenceTypesSupported?.includes('ON_DEMAND')) {
					// Model requires special access but we'll continue silently
				}

				return true;

			} catch (listError) {
				throw new Error(`Failed to validate model availability: ${listError.message}`);
			}

		} catch (error) {
			throw error;
		}
	}
}
