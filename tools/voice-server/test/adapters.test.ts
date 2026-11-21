import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { spawnArgs } from "../src/adapters.ts";

const onlyWindows = { skip: NodeOS.platform() !== "win32" && "cmd.exe only exists on Windows" };

NodeTest.test("a .cmd shim keeps cmd metacharacters inert", onlyWindows, async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-cmd "));
  const shim = NodePath.join(directory, "echo args.cmd");
  await NodeFSP.writeFile(shim, "@echo off\r\necho %1 %2\r\n");
  const spawned = spawnArgs(shim, ["a & echo injected", "b|c^d"]);
  const output = NodeChildProcess.execFileSync(spawned.file, spawned.args, {
    windowsVerbatimArguments: spawned.verbatim,
    encoding: "utf8",
  });
  NodeAssert.equal(output.trim(), `"a & echo injected" "b|c^d"`);
});

NodeTest.test("arguments that quotes cannot protect from cmd.exe are refused", () => {
  for (const value of ['say "hi"', "%PATH%", "line\nbreak"]) {
    NodeAssert.throws(() => spawnArgs("t3.cmd", [value], "win32"));
  }
  NodeAssert.deepEqual(spawnArgs("t3", ['say "hi"'], "linux").args, ['say "hi"']);
});
