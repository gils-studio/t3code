import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  applyCorrections,
  correctTranscript,
  readVocabulary,
  vocabularyPath,
} from "../src/vocabulary.ts";

const corrections = {
  Pidohr: ["Pidor"],
  dialed: ["Dialed"],
  Gils: ["Giltz", "Gilds"],
  "Gils Admin": ["Gilds Admin"],
  Worktree: ["Work-Car"],
};

NodeTest.test("misheard names get their right spelling, whatever the case", () => {
  NodeAssert.equal(
    applyCorrections("Zum Beispiel Giltz oder PIDOR oder Dialed.", corrections),
    "Zum Beispiel Gils oder Pidohr oder dialed.",
  );
});

NodeTest.test("only whole words change, also inside hyphenated compounds", () => {
  NodeAssert.equal(applyCorrections("Die Pidor-App", corrections), "Die Pidohr-App");
  NodeAssert.equal(applyCorrections("Pidorama und Redialed", corrections), "Pidorama und Redialed");
  NodeAssert.equal(applyCorrections("Ändialed", corrections), "Ändialed");
});

NodeTest.test("the longest variant wins and regex characters stay literal", () => {
  NodeAssert.equal(applyCorrections("Im Gilds Admin", corrections), "Im Gils Admin");
  NodeAssert.equal(applyCorrections("den Work-Car", corrections), "den Worktree");
  NodeAssert.equal(applyCorrections("a+b a", { x: ["a+b"] }), "x a");
});

NodeTest.test("nothing to correct leaves the text alone", () => {
  NodeAssert.equal(applyCorrections("Pidor", {}), "Pidor");
});

NodeTest.test("the file is read per request and a broken one costs no recording", async (t) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-"));
  process.env.T3_VOICE_HOME = home;
  t.after(() => delete process.env.T3_VOICE_HOME);

  NodeAssert.deepEqual(readVocabulary(), { prompt: "", corrections: {} });

  await NodeFSP.writeFile(
    vocabularyPath(),
    JSON.stringify({ prompt: "Wir bauen Pidohr.", corrections: { Pidohr: ["Pidor"] } }),
  );
  NodeAssert.equal(readVocabulary().prompt, "Wir bauen Pidohr.");
  NodeAssert.equal(correctTranscript("Pidor"), "Pidohr");

  t.mock.method(console, "error", () => {});
  await NodeFSP.writeFile(vocabularyPath(), "{ not json");
  NodeAssert.equal(correctTranscript("Pidor"), "Pidor");
});
