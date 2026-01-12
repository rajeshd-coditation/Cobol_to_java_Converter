
---

# COBOL to Java Modernization Framework

## Overview

This project extends the **OpenSourceCobol4j** framework to provide a **modern Web UI** and an **AI-powered COBOL → Java conversion pipeline**.

The framework supports:

* Local COBOL → Java conversion using `cobj` compiler
* Advanced conversion using **Azure AI Foundry Agents**
* Automated output validation between native COBOL execution and generated Java output

**Goal:** Deliver a **repeatable, auditable, production-ready modernization workflow**.

---

## Base Framework

**OpenSourceCobol4j** is the core engine:

* **Repository:** [OpenSourceCobol4j](https://github.com/opensourcecobol/opensourcecobol4j.git)
* **Purpose:** Converts COBOL programs to Java using `cobj`

> All enhancements in this project are built on top of this base framework.

---

## Features

* 🌐 **Web-based UI** to scan and convert COBOL repositories
* 🔄 **Two conversion modes**:

  1. Local compiler-based conversion
  2. AI agent–assisted conversion
* ✅ **Automated output comparison** (COBOL vs Java)
* 📊 Visibility of converted, skipped, and validated programs

---

## Technology Stack

| Layer          | Technology                 |
| -------------- | -------------------------- |
| COBOL          | GnuCOBOL (`cobc`)          |
| Converter      | OpenSourceCobol4j (`cobj`) |
| Backend        | Node.js                    |
| Frontend       | HTML, CSS, JavaScript      |
| AI Integration | Azure AI Foundry Agents    |
| Target Runtime | Java 8+                    |

---

## Prerequisites

Make sure the following are installed:

```bash
# Node.js and npm
node -v
npm -v

# Java JDK 8 or higher
java -version

# GnuCOBOL
cobc -V

# OpenSourceCobol4j (cobj compiler)
cobj -v
```

---

## Installation

### 1. Navigate to Web UI

```bash
cd opensourcecobol4j/tools/web-ui
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Run the Application

```bash
npm start
```

Access the UI in your browser:

```
http://localhost:3000
```

---

## Conversion Modes

### 1️⃣ Standard Conversion (Local)

* Uses the local `cobj` compiler.

* **Workflow:**

  ```bash
  # Scan repository for COBOL files
  ./cobol_repo_scanner.sh /path/to/cobol/repo

  # Convert COBOL to Java
  cobj MyProgram.cbl

  # Compile Java
  javac MyProgram.java

  # Execute COBOL
  cobc -x MyProgram.cbl

  # Execute Java
  java MyProgram

  # Compare outputs
  ./compare_outputs.sh
  ```

* ✅ Fast, offline, deterministic

---

### 2️⃣ AI-Powered Conversion (Azure Agent)

* Uses **Azure AI Foundry Agents** for modern, production-ready Java.

* **Workflow:**

  ```bash
  # Clone repository
  git clone https://github.com/your/repo.git

  # Send COBOL files to Azure AI Agent
  node azureAgent.js /path/to/repo

  # Generated Java code with:
  # - Modern patterns
  # - Auto-fixed compilation issues
  # - Maven dependencies

  # Run validation
  ./compare_outputs.sh
  ```

---

## Azure AI Agent Setup

### Step 1: Create Azure OpenAI Resource

* Portal → Create Azure OpenAI resource

### Step 2: Deploy Model

* Azure AI Studio → Deploy model (e.g., `gpt-4o`, `gpt-35-turbo`)
* Save deployment name

### Step 3: Create Agent

* AI Foundry → Build → Agents → Create new agent

#### Agent Instructions

* Expert COBOL → Java modernization
* Data mapping:

| COBOL Type          | Java Type  |
| ------------------- | ---------- |
| PIC X/A             | String     |
| PIC 9(1-9)          | int        |
| PIC 9(10+)          | long       |
| COMP / COMP-3 / 9V9 | BigDecimal |

* Structure mapping:

| COBOL           | Java              |
| --------------- | ----------------- |
| WORKING-STORAGE | Class fields      |
| LINKAGE         | Method parameters |
| OCCURS          | Arrays / Lists    |
| PERFORM         | Methods / Loops   |
| IF / EVALUATE   | if / switch       |

* Conversion Rules:

  * Convert all COBOL programs
  * Convert copybooks to Java models
  * One Java class per COBOL program
  * Preserve business logic
  * Java 8+ compatible
  * Generate Maven `pom.xml` with resolved imports

### Step 4: Configure Environment

Create `.env` in `tools/web-ui/`:

```env
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_API_VERSION=2024-05-01-preview
AZURE_OPENAI_DEPLOYMENT_NAME=your-deployment-name
AZURE_AGENT_ID=your-agent-id
```

---

## Project Structure

```text
Cobol_to_java_Converter/
├── opensourcecobol4j/     # Base framework (extended)
│   └── tools/
│       ├── web-ui/
│       ├── cobol_repo_scanner.sh
│       └── azureAgent.js
├── server.js
└── README.md
```

---

## Quick Reminder

* Base engine: **OpenSourceCobol4j**
* Enhancements: **Web UI + automation + Azure AI conversion**
* Supports **two conversion paths**: Local & AI
* **Output validation** included

---

