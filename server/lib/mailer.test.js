const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sendEmail } = require('./mailer');

function withResendConfig(t) {
  const previousApiKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  process.env.RESEND_API_KEY = 'test-api-key';
  process.env.EMAIL_FROM = 'SkyLedger <no-reply@example.com>';
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousApiKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  });
}

test('sendEmail sends messages through the Resend API', async (t) => {
  withResendConfig(t);
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200 };
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await sendEmail({
    to: 'pilot@example.com',
    subject: 'Verify your email',
    text: 'Your code is 123456.',
  });

  assert.equal(result, 'sent');
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-api-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    from: 'SkyLedger <no-reply@example.com>',
    to: 'pilot@example.com',
    subject: 'Verify your email',
    text: 'Your code is 123456.',
  });
});

test('sendEmail reports Resend API failures', async (t) => {
  withResendConfig(t);
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401 });
  t.after(() => { global.fetch = originalFetch; });

  assert.equal(await sendEmail({ to: 'pilot@example.com', subject: 'Test', text: 'Test' }), 'failed');
});

test('sendEmail reports missing Resend configuration', async (t) => {
  const previousApiKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  t.after(() => {
    if (previousApiKey !== undefined) process.env.RESEND_API_KEY = previousApiKey;
    if (previousFrom !== undefined) process.env.EMAIL_FROM = previousFrom;
  });

  assert.equal(await sendEmail({ to: 'pilot@example.com', subject: 'Test', text: 'Test' }), 'not-configured');
});
