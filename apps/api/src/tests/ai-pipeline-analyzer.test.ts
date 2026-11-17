import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { OpenAiCompatibleService } from '../infrastructure/ai-provider/openai-compatible.service';
import {
  AiPipelineAnalyzer,
  type AiPipelineAnalysisInput,
} from '../modules/ai/ai-pipeline-analyzer.service';
import { AiProvidersService } from '../modules/ai/ai-providers.service';

const apiKey = 'fixture-pipeline-provider-key';
const input: AiPipelineAnalysisInput = {
  status: 'PARTIAL_FAILED',
  mode: 'BUILD_ONLY',
  targetCounts: { total: 2, succeeded: 1, failed: 1 },
  steps: [
    { phase: 'CHECKOUT', status: 'SUCCESS', exitCode: 0 },
    { phase: 'BUILD:2', status: 'FAILED', exitCode: 2 },
  ],
};

function setEnabled(context: TestContext, enabled: boolean) {
  const previous = process.env.AI_PIPELINE_ANALYSIS;
  if (enabled) process.env.AI_PIPELINE_ANALYSIS = 'true';
  else delete process.env.AI_PIPELINE_ANALYSIS;
  context.after(() => {
    if (previous === undefined) delete process.env.AI_PIPELINE_ANALYSIS;
    else process.env.AI_PIPELINE_ANALYSIS = previous;
  });
}

async function serve(context: TestContext, reply?: Record<string, unknown>, timeoutSeconds = 60) {
  const captured: Array<Record<string, unknown>> = [];
  let notifyReceived: () => void;
  const received = new Promise<void>((resolve) => {
    notifyReceived = resolve;
  });
  const server = createServer((req, res) => {
    let content = '';
    req.setEncoding('utf8');
    req.on('data', (data: string) => {
      content += data;
    });
    req.on('end', () => {
      captured.push(JSON.parse(content) as Record<string, unknown>);
      notifyReceived();
      if (reply) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: reply }] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const port = (server.address() as { port: number }).port;
  const providers = {
    resolve: async () => ({
      apiKey,
      model: 'test-model',
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutSeconds,
    }),
  } as unknown as AiProvidersService;
  return {
    captured,
    received,
    analyzer: new AiPipelineAnalyzer(providers, new OpenAiCompatibleService()),
  };
}

test('Pipeline AI analysis is opt-in and skips unfinished tasks without resolving a Provider', async (context) => {
  setEnabled(context, false);
  let requests = 0;
  const providers = {
    resolve: async () => {
      requests++;
      throw new Error('not configured');
    },
  } as unknown as AiProvidersService;
  const analyzer = new AiPipelineAnalyzer(providers, new OpenAiCompatibleService());
  assert.equal(analyzer.isEnabled(), false);
  assert.equal(await analyzer.analyze(input), null);
  process.env.AI_PIPELINE_ANALYSIS = 'true';
  assert.equal(await analyzer.analyze({ ...input, status: 'RUNNING' }), null);
  assert.equal(requests, 0);
  assert.equal(await analyzer.analyze(input), null);
  assert.equal(requests, 1);
});

test('Pipeline AI analysis submits bounded metadata without tools or raw step/error contents', async (context) => {
  setEnabled(context, true);
  const { analyzer, captured } = await serve(context, {
    content: JSON.stringify({
      summary: `安装阶段失败，响应中的密钥 ${apiKey}`,
      failedPhase: 'TEST',
      nextActions: ['检查构建步骤', 'x'.repeat(300), '第三项', '第四项', '第五项'],
      extra: 'discarded',
    }),
  });
  const unsafe = {
    phase: 'BUILD:private/project-name',
    status: 'unsafe-status',
    exitCode: 10000,
    command: 'raw-command',
    errorSummary: 'raw-error',
  };
  const result = await analyzer.analyze({
    ...input,
    targetCounts: { total: 2, succeeded: 1, failed: 1000 },
    steps: [
      input.steps[1]!,
      { phase: 'TEST', status: 'FAILED', exitCode: 3 },
      unsafe,
      ...Array.from({ length: 50 }, () => input.steps[0]!),
    ],
  });
  assert.equal(result?.failedPhase, 'TEST');
  assert.ok(result.summary.includes('[REDACTED]'));
  assert.equal(result.summary.includes(apiKey), false);
  assert.equal(result.nextActions.length, 4);
  assert.equal(result.nextActions[1]?.length, 180);
  assert.deepEqual(Object.keys(result).sort(), ['failedPhase', 'nextActions', 'summary']);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.max_tokens, 800);
  assert.equal('tools' in captured[0]!, false);
  assert.equal('tool_choice' in captured[0]!, false);
  const sent = JSON.stringify(captured);
  for (const forbidden of [
    apiKey,
    'private/project-name',
    'unsafe-status',
    'raw-command',
    'raw-error',
  ])
    assert.equal(sent.includes(forbidden), false);
  const messages = captured[0]?.messages as { role: string; content: string }[];
  const metadata = JSON.parse(messages[1]!.content);
  assert.deepEqual(metadata.targetCounts, input.targetCounts);
  assert.equal(metadata.steps.length, 32);
  assert.deepEqual(metadata.steps[0], { phase: 'BUILD', status: 'FAILED', exitCode: 2 });
  assert.deepEqual(metadata.steps[1], { phase: 'TEST', status: 'FAILED', exitCode: 3 });
  assert.deepEqual(metadata.steps[2], { phase: 'UNKNOWN', status: 'UNKNOWN', exitCode: null });
});

test('Pipeline AI analysis ignores tool calls, malformed responses and invented failed phases', async (context) => {
  setEnabled(context, true);
  const message = { summary: '构建失败', failedPhase: 'BUILD', nextActions: ['检查退出码'] };
  for (const reply of [
    { content: 'not json' },
    { content: JSON.stringify({ ...message, failedPhase: 'CHECKOUT' }) },
    { content: JSON.stringify({ ...message, nextActions: [1] }) },
    {
      content: JSON.stringify(message),
      tool_calls: [
        {
          id: 'ignored-call',
          type: 'function',
          function: { name: 'run_pipeline', arguments: '{}' },
        },
      ],
    },
  ]) {
    const { analyzer, captured } = await serve(context, reply);
    assert.equal(await analyzer.analyze(input), null);
    assert.equal(captured.length, 1);
  }
});

test('Pipeline AI analysis applies Provider timeout and supports cancellation of the actual request', async (context) => {
  setEnabled(context, true);
  const timed = await serve(context, undefined, 0.15);
  assert.equal(await timed.analyzer.analyze(input), null);
  const cancelling = await serve(context);
  const abort = new AbortController();
  const analysis = cancelling.analyzer.analyze(input, abort.signal);
  await cancelling.received;
  abort.abort();
  assert.equal(await analysis, null);
  assert.equal(await cancelling.analyzer.analyze(input, abort.signal), null);
  assert.equal(cancelling.captured.length, 1);
});
