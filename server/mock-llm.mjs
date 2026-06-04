/**
 * Mock LLM Server — returns canned responses for pipeline/learn/advisor tests.
 * Listens on port 8000, mimics OpenAI chat completions API.
 */
import express from 'express';

const app = express();
app.use(express.json());

app.post('/v1/chat/completions', (req, res) => {
  const lastMsg = req.body.messages?.[req.body.messages.length - 1]?.content || '';

  // Detect what the caller wants based on system prompt
  const sysMsg = req.body.messages?.[0]?.content || '';

  let content;
  if (sysMsg.includes('Extract structured facts') || sysMsg.includes('Extract L1')) {
    // Pipeline L1 extraction
    content = JSON.stringify([
      { text: 'User prefers dark mode', type: 'preference', entity: 'user', attribute: 'theme_preference' },
      { text: 'Working on auth bug fix', type: 'fact', entity: 'project', attribute: 'current_task' },
    ]);
  } else if (sysMsg.includes('Summarize these memories') || sysMsg.includes('scene')) {
    // Pipeline L2 scene extraction
    content = 'User prefers dark mode and is fixing the authentication module. The project uses React for frontend.';
  } else if (sysMsg.includes('user persona') || sysMsg.includes('persona')) {
    // Pipeline L3 persona
    content = 'A developer who prefers dark themes, works on authentication systems, and uses React for frontend development. Values clean code and efficient debugging workflows.';
  } else if (sysMsg.includes('procedure') || sysMsg.includes('workflow')) {
    // /memory/learn procedure extraction
    content = JSON.stringify({
      name: 'Bug Fix Workflow',
      description: 'Standard bug fixing procedure',
      trigger_context: 'when encountering a bug report',
      steps: [
        { text: 'Identify the bug', step_type: 'action', expected_outcome: 'Bug reproduced' },
        { text: 'Fix the code', step_type: 'action', expected_outcome: 'Bug fixed' },
        { text: 'Verify the fix', step_type: 'check', expected_outcome: 'Tests pass' },
      ],
      context_points: [
        { context_type: 'tool', context_value: 'git' },
        { context_type: 'environment', context_value: 'node' },
      ],
    });
  } else if (sysMsg.includes('advice') || sysMsg.includes('drift')) {
    // Advisor
    content = JSON.stringify({
      advice: 'Stay focused on the current task. You were working on fixing the auth bug.',
      drift_detected: false,
      hints: ['Check the auth middleware', 'Review the session token handling'],
    });
  } else {
    content = 'Mock LLM response for: ' + lastMsg.substring(0, 50);
  }

  res.json({
    id: 'mock-' + Date.now(),
    object: 'chat.completion',
    choices: [{
      message: { role: 'assistant', content },
      finish_reason: 'stop',
      index: 0,
    }],
    usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
  });
});

app.get('/v1/models', (req, res) => {
  res.json({ data: [{ id: 'mock-model', object: 'model' }] });
});

app.listen(8000, () => {
  console.log('[MockLLM] Running on http://127.0.0.1:8000');
});
