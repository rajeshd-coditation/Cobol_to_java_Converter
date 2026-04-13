================================================================================
                     AZURE AI FOUNDRY AGENT INTEGRATION GUIDE
================================================================================

This guide explains how to get the required endpoints and credentials from your
Azure account to integrate your Microsoft AI Foundry Agent.

================================================================================
REQUIRED ENVIRONMENT VARIABLES
================================================================================

Add these to your .env file:

    # Azure AI Agent Configuration
    AZURE_OPENAI_ENDPOINT=https://your-resource-name.openai.azure.com
    AZURE_OPENAI_API_KEY=your-azure-api-key
    AZURE_OPENAI_API_VERSION=2024-05-01-preview
    AZURE_OPENAI_DEPLOYMENT_NAME=your-deployment-name
    AZURE_AGENT_ID=your-agent-id (if using AI Foundry Agents)

================================================================================
WHERE TO FIND EACH VALUE IN AZURE PORTAL
================================================================================

1. AZURE_OPENAI_ENDPOINT
   ----------------------
   Location: Azure Portal → Your Azure OpenAI Resource → Overview
   Format: https://<resource-name>.openai.azure.com
   
   Steps:
   a) Go to https://portal.azure.com
   b) Navigate to "Azure OpenAI" resource
   c) Click on your resource name
   d) Copy the "Endpoint" URL from the Overview page

2. AZURE_OPENAI_API_KEY
   ---------------------
   Location: Azure Portal → Your Azure OpenAI Resource → Keys and Endpoint
   
   Steps:
   a) Go to your Azure OpenAI resource
   b) Click "Keys and Endpoint" in the left sidebar
   c) Copy "KEY 1" or "KEY 2" (either works)

3. AZURE_OPENAI_API_VERSION
   -------------------------
   Use one of these supported versions:
   - 2024-05-01-preview (recommended for agents)
   - 2024-02-15-preview
   - 2023-12-01-preview
   
   Note: For AI Foundry Agents, use the preview versions.

4. AZURE_OPENAI_DEPLOYMENT_NAME
   -----------------------------
   Location: Azure Portal → Your Azure OpenAI Resource → Model deployments
   
   Steps:
   a) Go to your Azure OpenAI resource
   b) Click "Model deployments" in the left sidebar
   c) Your deployment name is listed there (e.g., "gpt-4o", "gpt-4-turbo")
   
   Alternative: Azure AI Studio → Deployments → Your deployment name

5. AZURE_AGENT_ID (for AI Foundry Agents)
   ---------------------------------------
   Location: Azure AI Foundry Portal → Agents → Your Agent
   
   Steps:
   a) Go to https://ai.azure.com
   b) Select your project
   c) Navigate to "Build" → "Agents"
   d) Click on your agent
   e) Copy the Agent ID from the agent details page
   
   Format: asst_xxxxxxxxxxxxxxxxxxxxx

================================================================================
AZURE AI FOUNDRY AGENTS - SPECIFIC ENDPOINTS
================================================================================

If using AI Foundry Agents (Assistants API), you need these endpoints:

Base URL:
---------
https://<your-resource>.openai.azure.com/openai

Endpoints:
----------
1. Create Thread:
   POST {base}/threads?api-version={version}

2. Add Message to Thread:
   POST {base}/threads/{thread_id}/messages?api-version={version}

3. Run Agent on Thread:
   POST {base}/threads/{thread_id}/runs?api-version={version}
   Body: { "assistant_id": "{agent_id}" }

4. Get Run Status:
   GET {base}/threads/{thread_id}/runs/{run_id}?api-version={version}

5. Get Messages:
   GET {base}/threads/{thread_id}/messages?api-version={version}

Headers Required:
-----------------
- api-key: {your-api-key}
- Content-Type: application/json

================================================================================
AZURE OPENAI CHAT COMPLETIONS - SIMPLE ENDPOINT
================================================================================

If using regular Chat Completions (simpler, no agent state):

Endpoint:
---------
POST https://<your-resource>.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}

Headers:
--------
- api-key: {your-api-key}
- Content-Type: application/json

Body:
-----
{
  "messages": [
    { "role": "system", "content": "Your system prompt..." },
    { "role": "user", "content": "COBOL code to convert..." }
  ],
  "temperature": 0.2,
  "max_tokens": 4000
}

================================================================================
COMPARISON: CHAT COMPLETIONS VS AGENTS
================================================================================

+----------------------+------------------------+---------------------------+
| Feature              | Chat Completions       | AI Foundry Agents         |
+----------------------+------------------------+---------------------------+
| Complexity           | Simple                 | More setup required       |
| State/Memory         | Stateless              | Maintains conversation    |
| Code Interpreter     | No                     | Yes (optional)            |
| File Search          | No                     | Yes (optional)            |
| Best For             | Single conversions     | Multi-step workflows      |
| API Calls            | 1 per conversion       | 3-5 per conversion        |
+----------------------+------------------------+---------------------------+

Recommendation: For COBOL to Java conversion, Chat Completions is usually
sufficient and simpler. Use Agents if you need file uploads or multi-turn
conversations.

================================================================================
QUICK START CHECKLIST
================================================================================

[ ] 1. Create Azure OpenAI resource in Azure Portal
[ ] 2. Deploy a model (gpt-4o or gpt-4-turbo recommended)
[ ] 3. Get your endpoint URL
[ ] 4. Get your API key
[ ] 5. Note your deployment name
[ ] 6. (Optional) Create an Agent in AI Foundry and get Agent ID
[ ] 7. Add all values to your .env file
[ ] 8. Restart your server

================================================================================
TESTING YOUR SETUP
================================================================================

You can test your Azure connection with this curl command:

curl -X POST "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT/chat/completions?api-version=2024-05-01-preview" \
  -H "api-key: YOUR-API-KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'

Expected response: JSON with a "choices" array containing the AI response.

================================================================================
                              END OF GUIDE
================================================================================
