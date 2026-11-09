const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const vm = require('node:vm');

const workflow = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', resolve(__dirname, '../Contents/document.wflow')], { encoding: 'utf8' }));
const source = workflow.actions[0].action.ActionParameters.source;
const event = JSON.stringify({ title: 'Réunion', start: '2026-12-01T18:00:00+01:00', end: '2026-12-01T20:00:00+01:00', confidence: 1 });

function harness() {
  const dialogs = [], logs = [], notifications = [], commands = [];
  const app = {
    displayNotification: (text) => notifications.push(text),
    displayDialog: (text) => { dialogs.push(text); return { buttonReturned: 'Retry with ChatGPT' }; },
    doShellScript: (cmd) => { commands.push(cmd); return '{"ok":true}\n200'; },
  };
  const context = vm.createContext({
    ObjC: { import() {}, unwrap: x => x },
    $: {
      NSTimeZone: { systemTimeZone: { name: 'Europe/Brussels' } },
      NSProcessInfo: { processInfo: { environment: { objectForKey: () => 'test' } } },
      NSHomeDirectory: () => '/tmp',
    },
    Application: { currentApplication: () => app },
  });
  vm.runInContext(source, context);
  context.logToFile = (path, text) => logs.push(JSON.parse(text));
  context.getSelectedMailText = () => 'Subject: Test\nRéunion le 1 décembre à 18h';
  return { context, app, dialogs, logs, notifications, commands };
}

test('HTTP success preserves Unicode and captures status without logging credentials', () => {
  const h = harness();
  h.app.doShellScript = (cmd, options) => {
    h.commands.push(cmd);
    const response = '{"text":"Réunion d’équipe"}\n200';
    // Standard Additions converts LF to CR unless explicitly disabled.
    return options?.alteringLineEndings === false ? response : response.replace(/\n/g, '\r');
  };
  assert.equal(h.context.httpPostJson('http://localhost:32000/test', { text: "l'équipe" }, { Authorization: 'Bearer TEST_SECRET' }).text, 'Réunion d’équipe');
  assert.match(h.commands[0], /--show-error/);
  assert.match(h.commands[0], /--connect-timeout/);
  assert.match(h.commands[0], /--max-time/);
  assert.equal(h.logs[0].http_status, 200);
  assert.ok(!JSON.stringify(h.logs).includes('TEST_SECRET'));
});

test('connection failure includes endpoint and curl diagnostic', () => {
  const h = harness();
  h.app.doShellScript = () => { throw new Error('curl: (7) Failed to connect to localhost port 32000'); };
  assert.throws(() => h.context.httpPostJson('http://localhost:32000/test', {}, {}), /Request to http:\/\/localhost:32000\/test failed.*curl: \(7\)/);
});

for (const status of [401, 429, 503]) {
  test(`HTTP ${status} surfaces the API error body`, () => {
    const h = harness();
    h.app.doShellScript = () => '{"error":"test API failure"}\n' + status;
    assert.throws(() => h.context.httpPostJson('http://test/api', {}, {}), new RegExp(`HTTP ${status}.*test/api:[\\s\\S]*test API failure`));
  });
}

test('non-JSON success identifies endpoint and response', () => {
  const h = harness();
  h.app.doShellScript = () => '<html>Bad proxy</html>\n200';
  assert.throws(() => h.context.httpPostJson('http://test/api', {}, {}), /Non-JSON HTTP response from http:\/\/test\/api:[\s\S]*Bad proxy/);
});

test('logs preserve message even when JXA stack contains only function names', () => {
  const h = harness();
  const data = JSON.parse(h.context.buildLogPayload({ error: { toString: () => 'Error: connection refused', stack: 'httpPostJson@\nrun@', errorNumber: 7 } }));
  assert.equal(data.error, 'Error: connection refused');
  assert.equal(data.errorNumber, 7);
  assert.equal(data.stack, 'httpPostJson@\nrun@');
});

test('local outage can retry with OpenAI and produce the calendar draft', () => {
  const h = harness();
  let calls = 0, ics;
  vm.runInContext('CONFIG.provider = "mlx"', h.context);
  h.context.callMLX = () => { throw new Error('Connection refused'); };
  h.context.callOpenAI = () => { calls++; return event; };
  h.context.createIcsAndHandle = events => { ics = h.context.buildIcs(events); return '/tmp/test.ics'; };
  h.context.run();
  assert.equal(calls, 1);
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0], /local model request failed/);
  assert.match(h.dialogs[0], /sends the selected email to OpenAI/);
  assert.match(ics, /DTSTART:20261201T170000Z/);
  assert.match(ics, /SUMMARY:Réunion/);
  assert.match(h.logs[0].error, /Connection refused/);
});

test('declining retry never calls OpenAI', () => {
  const h = harness();
  vm.runInContext('CONFIG.provider = "mlx"', h.context);
  h.context.callMLX = () => { throw new Error('Connection refused'); };
  h.app.displayDialog = () => { throw new Error('User canceled'); };
  h.context.callOpenAI = () => assert.fail('Unrequested OpenAI call');
  assert.throws(() => h.context.run(), /Connection refused/);
});

test('OpenAI request failures do not create a retry loop', () => {
  const h = harness();
  vm.runInContext('CONFIG.provider = "openai"', h.context);
  h.context.callOpenAI = () => { throw new Error('HTTP 401'); };
  assert.throws(() => h.context.run(), /HTTP 401/);
  assert.equal(h.dialogs.length, 0);
});

test('invalid local JSON retains the existing OpenAI retry path', () => {
  const h = harness();
  vm.runInContext('CONFIG.provider = "mlx"', h.context);
  h.context.callMLX = () => 'invalid';
  h.context.callOpenAI = () => event;
  h.context.createIcsAndHandle = () => '/tmp/test.ics';
  h.context.run();
  assert.match(h.dialogs[0], /invalid calendar data/);
});

test('MLX gets room for reasoning and final JSON with low reasoning effort', () => {
  const h = harness();
  let payload;
  h.context.httpPostJson = (url, data) => { payload = data; return { choices: [{ finish_reason: 'stop', message: { content: event } }] }; };
  assert.equal(h.context.callMLX('Test prompt'), event);
  assert.equal(payload.max_tokens, 4096);
  assert.equal(payload.chat_template_kwargs.reasoning_effort, 'low');
});

for (const content of ['', event]) {
  test(`MLX truncation is explicit even with ${content ? 'parseable partial results' : 'no final JSON'}`, () => {
    const h = harness();
    const budgets = [];
    h.context.httpPostJson = (url, payload) => {
      budgets.push(payload.max_tokens);
      return { choices: [{ finish_reason: 'length', message: { content } }], usage: { completion_tokens: payload.max_tokens } };
    };
    assert.throws(() => h.context.callMLX('Test prompt'), /truncated.*8192 tokens, including reasoning/);
    assert.deepEqual(budgets, [4096, 8192]);
  });
}

test('generation metadata stays in logs even if raw response exceeds log limit', () => {
  const h = harness();
  h.app.doShellScript = () => JSON.stringify({ choices: [{ message: { content: 'x'.repeat(9000) }, finish_reason: 'length' }], usage: { completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 997 } } }) + '\n200';
  h.context.httpPostJson('http://test/api', {}, {});
  assert.equal(h.logs[0].debug_finish_reason, 'length');
  assert.equal(h.logs[0].debug_usage.completion_tokens_details.reasoning_tokens, 997);
  assert.equal(h.logs[0].debug_raw_response.length, 8000);
});


test('truncated MLX output retries the same prompt locally once, then resets the budget', () => {
  const h = harness();
  const requests = [];
  h.context.httpPostJson = (url, payload, headers, timeout) => {
    requests.push({ url, payload: JSON.parse(JSON.stringify(payload)), timeout });
    return { choices: [{ finish_reason: requests.length === 1 ? 'length' : 'stop', message: { content: requests.length === 1 ? '[{"title":' : event } }] };
  };
  assert.equal(h.context.callMLX('Test prompt'), event);
  assert.equal(h.context.callMLX('Next analysis'), event);
  assert.deepEqual(requests.map(r => r.payload.max_tokens), [4096, 8192, 4096]);
  assert.deepEqual(requests.map(r => r.timeout), [180, 360, 180]);
  assert.deepEqual(requests[0].payload.messages, requests[1].payload.messages);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[1].payload.chat_template_kwargs.reasoning_effort, 'low');
  assert.equal(h.dialogs.length, 0);
});

test('MLX transport failures do not trigger a larger-budget retry', () => {
  const h = harness();
  let calls = 0;
  h.context.httpPostJson = () => { calls++; throw new Error('HTTP 503'); };
  assert.throws(() => h.context.callMLX('Test prompt'), /HTTP 503/);
  assert.equal(calls, 1);
});

test('two truncated local attempts offer OpenAI only after the larger budget fails', () => {
  const h = harness();
  const budgets = [];
  let openaiCalls = 0, previewProvider;
  vm.runInContext('CONFIG.provider = "mlx"', h.context);
  h.context.httpPostJson = (url, payload) => {
    budgets.push(payload.max_tokens);
    return { choices: [{ finish_reason: 'length', message: { content: '' } }] };
  };
  h.context.callOpenAI = () => { openaiCalls++; return event; };
  h.context.createIcsAndHandle = (events, allowRetry, provider) => { previewProvider = provider; return '/tmp/test.ics'; };
  h.context.run();
  assert.deepEqual(budgets, [4096, 8192]);
  assert.equal(openaiCalls, 1);
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0], /8192 tokens/);
  assert.equal(previewProvider, 'openai');
});

test('larger HTTP timeout is sent to curl', () => {
  const h = harness();
  h.context.httpPostJson('http://test/api', {model: 'local-model', max_tokens: 8192}, {}, 360);
  assert.match(h.commands[0], /'--max-time' '360'/);
  assert.equal(h.logs[0].debug_max_tokens, 8192);
  assert.equal(h.logs[0].debug_model, 'local-model');
});
