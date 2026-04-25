import { once } from "node:events";
import net from "node:net";
import { spawn } from "node:child_process";

const requestedPort = process.env.SUPEROBJECTIVE_WRANGLER_DEV_PORT;
const port = requestedPort == null ? await findOpenPort() : Number.parseInt(requestedPort, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid SUPEROBJECTIVE_WRANGLER_DEV_PORT value: ${requestedPort}`);
}

const baseUrl = `http://127.0.0.1:${port}`;
const useRemote = process.env.SUPEROBJECTIVE_WRANGLER_DEV_REMOTE === "1";
const readyTimeoutMs = Number.parseInt(
  process.env.SUPEROBJECTIVE_WRANGLER_DEV_READY_TIMEOUT_MS ?? "120000",
  10,
);
const wranglerConfigPath = process.env.SUPEROBJECTIVE_WRANGLER_DEV_CONFIG ?? "wrangler.jsonc";

const wranglerArgs = [
  "exec",
  "wrangler",
  "dev",
  "--config",
  wranglerConfigPath,
  "--ip",
  "127.0.0.1",
  "--port",
  String(port),
  "--show-interactive-dev-session=false",
  ...(useRemote ? ["--remote"] : []),
];

console.log(`Starting Wrangler dev at ${baseUrl} (${useRemote ? "remote" : "local"} bindings).`);
const wrangler = spawn("pnpm", wranglerArgs, {
  env: {
    ...process.env,
    NO_COLOR: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let wranglerOutput = "";
wrangler.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  wranglerOutput += text;
  process.stdout.write(text);
});
wrangler.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  wranglerOutput += text;
  process.stderr.write(text);
});

let exitCode = 1;
try {
  await waitForReady(baseUrl, readyTimeoutMs);
  console.log(`Wrangler dev is ready at ${baseUrl}; running Cloudflare live tests.`);

  const test = spawn("pnpm", ["test:cloudflare-live"], {
    env: {
      ...process.env,
      SUPEROBJECTIVE_LIVE_BASE_URL: baseUrl,
    },
    stdio: "inherit",
  });
  const [code, signal] = await once(test, "exit");
  if (signal != null) {
    throw new Error(`Cloudflare dev live tests exited with signal ${signal}.`);
  }
  exitCode = typeof code === "number" ? code : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (wranglerOutput.length > 0) {
    console.error("\nRecent Wrangler output:");
    console.error(tail(wranglerOutput, 80));
  }
  exitCode = 1;
} finally {
  wrangler.kill("SIGTERM");
  await Promise.race([
    once(wrangler, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (wrangler.exitCode == null && wrangler.signalCode == null) {
    wrangler.kill("SIGKILL");
  }
}

process.exit(exitCode);

async function waitForReady(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    if (wrangler.exitCode != null) {
      throw new Error(`Wrangler dev exited before becoming ready with code ${wrangler.exitCode}.`);
    }

    try {
      const response = await fetch(`${url}/manifest`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
      lastError = new Error(`Readiness probe returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const detail =
    lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for Wrangler dev at ${url}.${detail}`);
}

async function findOpenPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local port for Wrangler dev.");
  }

  return address.port;
}

function tail(value, lines) {
  return value.split(/\r?\n/).slice(-lines).join("\n");
}
