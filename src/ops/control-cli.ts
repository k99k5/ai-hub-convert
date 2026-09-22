import { requestDrainControl } from "./drain-control.js";

const operation = process.argv[2];
try {
  if (operation !== "status" && operation !== "drain" && operation !== "resume")
    throw new Error("Usage: node dist/ops/control-cli.js status|drain|resume");
  console.log(JSON.stringify(await requestDrainControl(operation)));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Gateway control failed");
  process.exitCode = 1;
}
