const Notification = require('../models/Notification');
const User = require('../models/User');
const { sendEmail } = require('./mailer');

async function notifyUser(io, userId, { type, title, message, href = '/' }) {
  const notification = await Notification.create({ recipient: userId, type, title, message, href });
  const user = await User.findById(userId).select('email');
  let emailStatus = 'not-configured';
  if (user) {
    const baseUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    emailStatus = await sendEmail({
      to: user.email,
      subject: title,
      text: message + '\n\nOpen SkyLedger: ' + baseUrl + href,
    });
  }
  if (notification.emailStatus !== emailStatus) {
    notification.emailStatus = emailStatus;
    await notification.save();
  }
  const payload = {
    id: String(notification._id), type, title, message, href,
    emailStatus, createdAt: notification.createdAt, readAt: notification.readAt,
  };
  io.to('user:' + String(userId)).emit('notification:new', payload);
  return payload;
}

module.exports = { notifyUser };