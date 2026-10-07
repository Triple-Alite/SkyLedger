const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

async function sendEmail({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    console.error('Email delivery is not configured: set RESEND_API_KEY and EMAIL_FROM.');
    return 'not-configured';
  }

  try {
    const response = await fetch(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text }),
    });

    if (!response.ok) {
      let errorDetails = '';
      try {
        const body = await response.json();
        const errorName = body && typeof body.name === 'string' ? body.name : '';
        const errorMessage = body && typeof body.message === 'string' ? body.message : '';
        errorDetails = [errorName, errorMessage].filter(Boolean).join(': ').slice(0, 500);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      console.error(
        'Email delivery failed: Resend returned HTTP ' + response.status +
        (errorDetails ? ' (' + errorDetails + ').' : '.'),
      );
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    console.error('Email delivery failed:', error.message);
    return 'failed';
  }
}

module.exports = { sendEmail };
