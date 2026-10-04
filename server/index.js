require('dotenv').config();

const { randomBytes } = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const MongoStore = require('connect-mongo');
const { Server } = require('socket.io');
const Corridor = require('./models/Corridor');
const { ensureSeedData } = require('./seed');
const { router: corridorRoutes } = require('./routes/corridors');
const { router: flightRoutes } = require('./routes/flights');
const { router: authRoutes } = require('./routes/auth');
const { router: aircraftRoutes } = require('./routes/aircraft');
const { router: teamRoutes } = require('./routes/team');
const { router: notificationRoutes } = require('./routes/notifications');
const { router: profileRoutes } = require('./routes/profile');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT) || 3000;
let sessionMiddleware = (req, res, next) => next();

app.set('io', io);
app.disable('x-powered-by');
app.use((req, res, next) => sessionMiddleware(req, res, next));
app.use(express.json({ limit: '32kb' }));
app.use('/api/auth', authRoutes);
app.use('/api/me/aircraft', aircraftRoutes);
app.use('/api/me/team', teamRoutes);
app.use('/api/me/notifications', notificationRoutes);
app.use('/api/me/profile', profileRoutes);
app.use('/api/corridors', corridorRoutes);
app.use('/api', flightRoutes);
app.get('/api/health', (req, res) => res.json({ status: 'ok', database: mongoose.connection.readyState === 1 }));
app.get('/api/geocoding/search', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (query.length < 3 || query.length > 100) {
    return res.status(400).json({ error: 'Enter a place name between 3 and 100 characters.' });
  }

  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({
    name: query,
    count: '5',
    language: 'en',
    format: 'json',
    countryCode: 'NG',
  }).toString();

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return res.status(502).json({ error: 'Place search is temporarily unavailable.' });
    const data = await response.json();
    res.json({
      results: (data.results || []).map((place) => ({
        id: place.id,
        name: place.name,
        admin1: place.admin1 || '',
        admin2: place.admin2 || '',
        country: place.country || 'Nigeria',
        latitude: place.latitude,
        longitude: place.longitude,
      })),
      attribution: 'Geocoding by Open-Meteo',
    });
  } catch (error) {
    res.status(502).json({ error: 'Place search is temporarily unavailable.' });
  }
});
app.get('/api/weather', async (req, res) => {
  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lon);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return res.status(400).json({ error: 'Valid latitude and longitude are required.' });
  }
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_gusts_10m,weather_code',
    timezone: 'auto',
  }).toString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return res.status(502).json({ error: 'Weather provider is temporarily unavailable.' });
    const data = await response.json();
    res.json({
      source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/', fetchedAt: new Date().toISOString(),
      latitude: data.latitude, longitude: data.longitude, timezone: data.timezone,
      current: data.current, units: data.current_units,
    });
  } catch (error) {
    res.status(502).json({ error: 'Weather context is unavailable right now.' });
  }
});
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.name === 'ValidationError' || error.name === 'CastError') {
    return res.status(400).json({ error: error.message });
  }
  console.error(error);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

io.on('connection', (socket) => {
  const userId = socket.request.session && socket.request.session.userId;
  if (userId) socket.join('user:' + String(userId));

  socket.on('corridor:join', async (slug) => {
    if (typeof slug !== 'string') return;
    const corridor = await Corridor.findOne({ slug }).select('slug');
    if (!corridor) {
      socket.emit('corridor:error', { error: 'Corridor not found.' });
      return;
    }
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }
    socket.join(corridor.slug);
    socket.emit('corridor:joined', { slug: corridor.slug });
  });
});

async function start() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI is required. Copy .env.example to .env and configure it.');
  await mongoose.connect(mongoUri);
  await ensureSeedData();
  const sessionSecret = process.env.SESSION_SECRET || randomBytes(48).toString('hex');
  if (!process.env.SESSION_SECRET) {
    console.warn('SESSION_SECRET is not set; sign-in sessions will expire when the server restarts.');
  }
  sessionMiddleware = session({
    name: 'skyledger.sid',
    secret: sessionSecret,
    store: MongoStore.create({
      client: mongoose.connection.getClient(),
      collectionName: 'sessions',
      ttl: 60 * 60 * 24 * 30,
    }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  });
  io.engine.use((req, res, next) => sessionMiddleware(req, res, next));
  server.listen(port, '0.0.0.0', () => {
    console.log('SkyLedger listening on http://localhost:' + port);
  });
}

async function shutdown() {
  await new Promise((resolve) => io.close(resolve));
  await mongoose.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
  start().catch((error) => {
    console.error('SkyLedger failed to start:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { app, server, io, start };