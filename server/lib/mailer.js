const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD || '',
      } : undefined,
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, text }) {
  const mailTransport = getTransporter();
  if (!mailTransport) return 'not-configured';
  try {
    await mailTransport.sendMail({ from: process.env.SMTP_FROM, to, subject, text });
    return 'sent';
  } catch (error) {
    console.error('Email delivery failed:', error.message);
    return 'failed';
  }
}

module.exports = { sendEmail };