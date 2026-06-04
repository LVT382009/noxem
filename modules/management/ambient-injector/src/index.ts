#!/usr/bin/env node
import { spawn } from "child_process";
import { startServer, runLibMode } from "./server/index.js";
import { startVisualizeServer } from "./server/visualize.js";

const args = process.argv.slice(2);

if (args.includes("-lib")) {
  runLibMode().catch((error: Error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
} else if (args.includes("-vis")) {
  const portIdx = args.indexOf("-p");
  const port = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : undefined;

  if (!args.includes("--fg")) {
    const serverArgs = [process.argv[1], "-vis", "--fg"];
    if (port) { serverArgs.push("-p", String(port)); }

    const child = spawn(process.execPath, serverArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    console.error(``);
    console.error(`  Lemma Visualizer started in background (PID ${child.pid})`);
    console.error(`  http://localhost:${port || 3456}`);
    console.error(`  Stop: kill ${child.pid}`);
    console.error(``);
    process.exit(0);
  } else {
    startVisualizeServer(port).catch((error: Error) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
  }
} else {
  startServer().catch((error: Error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
