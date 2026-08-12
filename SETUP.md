# Setup — Docker

Run the COBOL → Java Modernization Workbench with Docker Compose. No local Node.js, Java, or GnuCOBOL install required — everything is built into the image.

## Prerequisites

- Docker + Docker Compose (Docker Desktop on Mac/Windows, or `docker-compose-plugin` on Linux)
- An Azure OpenAI / Azure AI Foundry deployment, if you want to use AI-powered conversion (optional — local `cobj` conversion works without it)

## 1. Clone the repo

```bash
git clone <this-repo-url> cobol-to-java-converter
cd cobol-to-java-converter
```

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your Azure credentials if you plan to use AI conversion:

```env
AI_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=https://<your-resource>.services.ai.azure.com/api/projects/<project>
AZURE_OPENAI_API_KEY=<your-api-key>
AZURE_OPENAI_API_VERSION=2024-05-01-preview
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4.1-mini
```

You can skip this step if you only intend to use local (`cobj`-based) conversion — just leave `.env` as the copied template.

## 3. Build and start the container

```bash
docker compose build
docker compose up -d
```

(`docker-compose build` / `docker-compose up -d` if you're on the older standalone `docker-compose` CLI.)

The first build compiles `cobj` from source and installs GnuCOBOL + Node deps — it can take several minutes. Subsequent builds are cached and much faster.

## 4. Open the app

```
http://localhost:3001
```

The container listens on `3000` internally; `docker-compose.yml` maps it to host port `3001`.

## What's mounted

| Host path | Container path | Purpose |
|---|---|---|
| `./opensourcecobol4j/carddemo-app` | `/cobol-source/carddemo` | Sample AWS CardDemo COBOL app (read-only), pick this as a source repo in the UI |
| `./conversion-data` | `/app/conversion-data` | Conversion outputs + checkpoints — persists across rebuilds/restarts |
| `./opensourcecobol4j/tools/web-ui/{public,src,server.js,azureAgent.js}` | matching `/app/tools/web-ui/...` paths | Live-reload mounts — edit locally, changes apply without rebuilding |

To convert your own COBOL repo, either paste a Git URL in the UI (it's cloned inside the container), or mount your local path by adding another volume line to `docker-compose.yml`, e.g.:

```yaml
    volumes:
      - /path/to/your/cobol/repo:/cobol-source/myapp:ro
```

then rebuild/restart.

## Everyday commands

```bash
docker compose up -d          # start (detached)
docker compose logs -f        # tail logs
docker compose restart        # apply changes to mounted public/src/server.js files
docker compose down           # stop and remove the container
docker compose build --no-cache   # full rebuild (e.g. after changing the Dockerfile or opensourcecobol4j itself)
```

## Notes

- Edits under `opensourcecobol4j/tools/web-ui/public`, `src`, `server.js`, or `azureAgent.js` take effect after `docker compose restart` — no rebuild needed, since those paths are bind-mounted.
- Anything else (Dockerfile changes, `opensourcecobol4j` core/build changes, new npm dependencies) requires `docker compose build` again.
- `conversion-data/` on the host accumulates conversion runs and checkpoints over time; safe to delete between runs if you want a clean slate (the container recreates it).
- `.env` is read via `env_file` in `docker-compose.yml` and is gitignored — never commit it.
