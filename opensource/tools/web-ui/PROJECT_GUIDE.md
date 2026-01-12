# COBOL to Java Modernization Project

## Project Overview
This project is built upon the [OpenSourceCobol4j](https://github.com/opensourcecobol/opensourcecobol4j.git) repository as its foundation. We have enhanced the core conversion capabilities by adding a modern Web UI to provide a user-friendly interface for scanning, converting, and validating COBOL repositories.

### Key Enhancements:
- **Web UI:** A responsive dashboard for managing conversions.
- **Dual Conversion Paths:** 
  - Standard conversion using the local `cobj` compiler.
  - Enhanced conversion using **Azure AI Foundry Agents**.
- **Automated Validation:** Automatic comparison of native COBOL output vs. generated Java output.

---

---

## Quick Start: Clone & Setup

Follow these steps to get the project running on your local machine:

### 1. Clone the Repository
```bash
git clone https://github.com/saip-coditation/Cobol_to_java_Converter.git
cd Cobol_to_java_Converter
```

### 2. Prerequisites
Ensure you have the following installed:
- **Node.js**: Version 14 or higher.
- **Java JDK**: Version 8 or higher.
- **GnuCOBOL (cobc)**: Required for original COBOL execution comparison.
- **OpenSourceCobol4j (cobj)**: Required for standard local conversion.

### 3. Installation
Navigate to the web UI directory and install dependencies:
```bash
cd opensource/tools/web-ui
npm install
```

### 3. Usage
Start the application:
```bash
npm start
```
Access the UI at `http://localhost:3000`.

---

## Conversion Process

### Method 1: Standard Conversion (No Azure Agent)
This method uses the local `cobj` compiler to transform COBOL files into Java. It is fast and runs entirely locally.

**How it works:**
1. Scans the repository for `.cbl` and `.cob` files.
2. Runs `cobj` to generate Java source code.
3. Compiles the Java code using `javac`.
4. Executes both native (if `cobc` is present) and Java versions to compare outputs.

### Method 2: AI-Powered Conversion (With Azure Agent)
This method leverages **Azure AI Foundry Agents** to perform high-quality COBOL to Java conversion. It produces production-ready code with intelligent error handling and modern Java patterns.

**Commands & Workflow:**
The UI triggers the `/api/convert-azure` endpoint which:
1. Clones the target repository.
2. Sends COBOL source code to the Azure AI Agent.
3. Receives optimized Java code.
4. Auto-fixes common compilation issues and adds modern unit test patterns.

---

## Creating an Azure Agent in AI Foundry

To use the AI-powered conversion, you need to set up an agent in Azure AI Foundry.

### Step-by-Step Guide:
1. **Create Azure OpenAI Resource:**
   - Go to the [Azure Portal](https://portal.azure.com).
   - Create a new "Azure OpenAI" resource.
2. **Deploy a Model:**
   - Open **Azure AI Studio** (AI Foundry).
   - Go to **Deployments** and deploy a model (e.g., `gpt-4o` or `gpt-35-turbo`).
   - Note down your **Deployment Name**.
3. **Create an Agent:**
   - In AI Foundry, navigate to **Build** → **Agents**.
   - Click **Create Agent**.
   - Give it a name and select your deployment.
   - (Optional) Provide instructions to the agent. Below are the exact instructions used to train and configure the agent for this project:
     
     > [!IMPORTANT]
     > **Azure Agent Professional Instructions:**
     > 
     > You are an expert COBOL to Java modernization agent. Convert COBOL programs to clean, compilable Java 8+ code. 
     > 
     > **Data Type Mapping:**
     > - PIC X/A → String
     > - PIC 9(1-9) → int
     > - PIC 9(10+) → long
     > - COMP/COMP-3/9V9 → BigDecimal
     > 
     > **Structure & Control:**
     > - WORKING-STORAGE → class fields
     > - LINKAGE → method params
     > - OCCURS → arrays / lists
     > - PERFORM → methods / loops
     > - IF / EVALUATE → if / switch
     > 
     > **I/O & Workflow:**
     > - DISPLAY → System.out.println() / logging
     > - ACCEPT → Scanner (replace with hardcoded test values in final output)
     > - FILE SECTION → Java I/O (BufferedReader/Writer)
     > 
     > **Process:**
     > 1. Clone the given GitHub repository
     > 2. Scan the entire repo
     > 3. Identify only COBOL-related files (.cbl, .cob, .cpy, .jcl if referenced)
     > 4. Skip all non-COBOL files
     > 
     > **Conversion Rules:**
     > - Convert ALL identified COBOL programs to Java
     > - Convert copybooks → reusable Java models
     > - One Java class per COBOL program
     > - Preserve business logic exactly
     > - Java 8+ compatible, clean & compilable
     > 
     > **Dependency Handling (MANDATORY):**
     > - Auto-add all required dependencies
     > - Create / update Maven pom.xml
     > - Resolve all missing imports & runtime issues
     > - Add as needed: Apache Commons, SLF4J + Logback, Jackson, JUnit, COBOL runtime replacements
     > 
     > **Output (STRICT):**
     > - Structured Java project
     > - Converted Java files must be visible in the UI
     > - Show program output in the UI
     > - No explanations or summaries
     > 
     > **Goal:**
     > - Zero unresolved dependencies
     > - Java code must also output
     > - Project must compile and run successfully
     > - Scan whole project and mark skipped files for display in UI.
4. **Retrieve Agent ID:**
   - Once created, click on the agent to see its details.
   - Copy the **Agent ID** (it starts with `asst_`).
5. **Configure Environment:**
   - Update your `.env` file in `tools/web-ui/`:
     ```env
     AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
     AZURE_OPENAI_API_KEY=your-key
     AZURE_OPENAI_API_VERSION=2024-05-01-preview
     AZURE_OPENAI_DEPLOYMENT_NAME=your-deployment-name
     AZURE_AGENT_ID=your-agent-id
     ```

---

## Technical Details

### Key Files
- `server.js`: Main Node.js backend.
- `cobol_repo_scanner.sh`: Core script for repository scanning and local conversion.
- `azureAgent.js`: Service for interacting with Azure AI Foundry.
- `public/`: Frontend assets (HTML, CSS, JS).
