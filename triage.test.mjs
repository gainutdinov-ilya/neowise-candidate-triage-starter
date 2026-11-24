import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { runInNewContext } from "node:vm";

const previousPort = process.env.PORT;
process.env.PORT = "0";
const { server } = await import("./server.mjs");
if (previousPort === undefined) delete process.env.PORT;
else process.env.PORT = previousPort;
if (!server.listening) await once(server, "listening");
after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

async function triage(body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { code: response.status, body: await response.json() };
}

test("returns a supported topic and a non-empty draft", async () => {
  const { code, body } = await triage(JSON.stringify({ text: "Когда будет доставка?" }));
  assert.equal(code, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.equal(typeof body.draft, "string");
  assert.ok(body.draft.trim());
});

test("rejects malformed JSON and invalid text", async () => {
  for (const input of ["", "{", "null", "{}", '{"text":42}', '{"text":""}', '{"text":"  \\n"}']) {
    assert.deepEqual(await triage(input), { code: 400, body: { status: "invalid_input" } });
  }
});

for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]", "[timeout]"]) {
  test(`returns manual review for ${marker}`, async () => {
    const start = performance.now();
    assert.deepEqual(await triage(JSON.stringify({ text: marker })), {
      code: 200,
      body: { status: "manual_review", topic: null, draft: null },
    });
    if (marker === "[timeout]") {
      // Allow scheduling overhead but distinguish cancellation from the mock's 1.2 s delay.
      assert.ok(performance.now() - start < 1_000);
    }
  });
}

test("replaces a previous draft with manual review after a provider failure", async () => {
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const result = { textContent: "" };
  const message = { value: "Когда будет доставка?" };
  const button = { disabled: false };
  let submit;
  const form = {
    querySelector: () => button,
    addEventListener: (_, handler) => { submit = handler; },
  };
  const elements = { form, "#result": result, "#message": message };
  runInNewContext(html.match(/<script type="module">([\s\S]*?)<\/script>/)[1], {
    document: { querySelector: (selector) => elements[selector] },
    fetch: (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options),
  });

  const event = { preventDefault() {} };
  await submit(event);
  assert.match(result.textContent, /Черновик ответа:\nСпасибо/);

  message.value = "[error]";
  const pending = submit(event);
  assert.equal(result.textContent, "Готовим черновик…");
  assert.equal(button.disabled, true);
  await pending;
  assert.equal(result.textContent, "Не удалось подготовить черновик. Разберите заявку вручную.");
  assert.equal(button.disabled, false);
});
