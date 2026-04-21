/**
 * Azure OpenAI / AI Foundry HTTP transport.
 *
 * Owns the module-level `azureConfig` that every AI call depends on.
 * All other AI features (convertCobolToJava, fixJavaCode, compareRunOutputs,
 * analyzeConversionFailure, predictProgramOutput) import makeOpenAIRequest
 * from here — keeping transport in one place so endpoint-URL shaping, retry
 * behavior, and optional prompt-dump debugging stay consistent across every
 * prompt we send.
 *
 *   initializeAzure() → bool     reads env, populates azureConfig
 *   isAvailable()    → bool     did init find a key?
 *   getConfig()      → {…}|null safe view for /api/ai/provider
 *   makeOpenAIRequest(messages, { maxTokens? }) → chat-completions JSON
 *
 * Why AI Foundry detection? `services.ai.azure.com` endpoints expose the
 * OpenAI-compatible path under `/openai/deployments/<name>/chat/completions`
 * but often ship with a `/api/projects/...` suffix in the configured
 * endpoint. We strip that suffix and append the standard OpenAI path so
 * the same code works for both Azure OpenAI and AI Foundry deployments.
 *
 * Retry policy: up to 3 retries on 429 with exponential backoff (4/8/16s).
 * If the server returns a "retry after N seconds" hint, that wins. Any
 * other error is re-thrown immediately.
 *
 * DEBUG_PROMPTS env dumps every outbound prompt to disk (one JSON per call,
 * filename = timestamp + sha1(system_prompt)[0..8]) so a weird model
 * response can be replayed without re-running the whole conversion.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let azureConfig = null;

function initializeAzure() {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-05-01-preview';
    const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

    if (!endpoint || !apiKey) {
        console.warn('[warn]  Azure AI not configured. Azure AI features disabled.');
        console.warn('   Required: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY');
        return false;
    }

    const isAIFoundry = endpoint.includes('services.ai.azure.com');

    azureConfig = {
        endpoint: endpoint.replace(/\/$/, ''),
        apiKey,
        apiVersion,
        deploymentName,
        isAIFoundry
    };

    console.log('[ok] Azure AI Agent initialized successfully');
    console.log(`   Endpoint: ${endpoint}`);
    console.log(`   Platform: ${isAIFoundry ? 'Azure AI Foundry' : 'Azure OpenAI'}`);
    return true;
}

function isAvailable() {
    return azureConfig !== null;
}

function getConfig() {
    if (!azureConfig) return null;
    return {
        endpoint: azureConfig.endpoint,
        deployment: azureConfig.deploymentName,
        apiVersion: azureConfig.apiVersion,
        isAIFoundry: azureConfig.isAIFoundry
    };
}

async function makeOpenAIRequest(messages, options = {}) {
    if (!azureConfig) {
        throw new Error('Azure AI not initialized');
    }

    // AI Foundry endpoints sometimes carry a /api/projects/... suffix. Strip
    // it so the standard OpenAI path we append below resolves correctly.
    let url;
    let baseEndpoint = azureConfig.endpoint;
    if (baseEndpoint.includes('/api/projects/')) {
        baseEndpoint = baseEndpoint.split('/api/projects/')[0];
    }

    if (azureConfig.isAIFoundry) {
        url = `${baseEndpoint}/openai/deployments/${azureConfig.deploymentName}/chat/completions?api-version=${azureConfig.apiVersion}`;
    } else {
        url = `${azureConfig.endpoint}/openai/deployments/${azureConfig.deploymentName}/chat/completions?api-version=${azureConfig.apiVersion}`;
    }

    console.log(`   Calling: ${url}`);

    const body = {
        messages,
        max_completion_tokens: options.maxTokens || 4000
    };

    // DEBUG_PROMPTS=<dir> → dump every outbound call for offline replay.
    // Off by default — zero cost when unset.
    if (process.env.DEBUG_PROMPTS) {
        try {
            const dir = process.env.DEBUG_PROMPTS;
            fs.mkdirSync(dir, { recursive: true });
            const sys = (messages.find(m => m.role === 'system') || {}).content || '';
            const tag = crypto.createHash('sha1').update(sys).digest('hex').slice(0, 8);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const file = path.join(dir, `${stamp}.${tag}.json`);
            fs.writeFileSync(file, JSON.stringify({
                url,
                maxTokens: body.max_completion_tokens,
                messages
            }, null, 2));
        } catch (dumpErr) {
            console.warn('   [warn]  Prompt dump failed (non-fatal):', dumpErr.message);
        }
    }

    const maxRetries = 3;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'api-key': azureConfig.apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (response.ok) {
                return await response.json();
            }

            const errorText = await response.text();

            if (response.status === 429 && attempt < maxRetries) {
                // Prefer the server's own retry-after hint; fall back to
                // exponential backoff (4s / 8s / 16s).
                let waitTime = 15000;
                const retryMatch = errorText.match(/retry after (\d+) seconds/i);
                if (retryMatch) {
                    waitTime = (parseInt(retryMatch[1]) + 2) * 1000;
                } else {
                    waitTime = Math.pow(2, attempt + 2) * 1000;
                }
                console.log(`    Rate limited. Waiting ${waitTime / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            throw new Error(`Azure API error ${response.status}: ${errorText}`);
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries && error.message.includes('429')) {
                const waitTime = Math.pow(2, attempt + 2) * 1000;
                console.log(`    Rate limited (catch). Waiting ${waitTime / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }
            throw error;
        }
    }

    throw lastError || new Error('Max retries exceeded');
}

module.exports = {
    initializeAzure,
    isAvailable,
    getConfig,
    makeOpenAIRequest
};
