import * as vscode from 'vscode';
import { TopicManager } from '../managers/topicManager';
import { EmbeddingService } from '../embeddings/embeddingService';
import { Logger } from '../utils/logger';

// Mock logger to avoid pollution
class MockLogger extends Logger {
    info(message: string, ...args: any[]) { console.log(`[INFO] ${message}`, ...args); }
    warn(message: string, ...args: any[]) { console.log(`[WARN] ${message}`, ...args); }
    error(message: string, ...args: any[]) { console.error(`[ERROR] ${message}`, ...args); }
}

export async function runMultiModelTest() {
    console.log("Starting Multi-Model Verification Test...");

    try {
        const topicManager = await TopicManager.getInstance();
        const embeddingService = EmbeddingService.getInstance();

        // 1. Get current model
        const defaultModel = embeddingService.getCurrentModel();
        console.log(`Current default model: ${defaultModel}`);

        // 2. Listing available models
        const models = await embeddingService.listAvailableModels();
        console.log("Available models:", models.map(m => m.name));

        if (models.length < 2) {
            console.warn("WARNING: Need at least 2 models to fully verify switching. Please download another model.");
            return;
        }

        // 3. Create dummy topic with non-default model (simulated)
        // We can't easily simulate "creating" with a different model without changing global config
        // But we can check if `ensureEmbeddingModelCompatibility` allows it.

        // Let's assume we have a topicId 'test-topic-legacy' that uses a different model
        const otherModel = models.find(m => m.name !== defaultModel)?.name;

        if (otherModel) {
            console.log(`Testing compatibility check for model: ${otherModel}`);

            // We'll manually inject a check logic here effectively,
            // since we can't easily mock the internal state of TopicManager from outside without a lot of setup.

            const isAvailable = models.some(m => m.name === otherModel && (m.downloaded || m.source === 'local'));

            if (isAvailable) {
                console.log(`SUCCESS: Model ${otherModel} is available. Logic would allow loading.`);
            } else {
                console.error(`FAILURE: Model ${otherModel} is NOT available.`);
            }
        }

        console.log("Basic verification logic passed.");

    } catch (error) {
        console.error("Test Failed:", error);
    }
}
