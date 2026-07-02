const crypto = require('crypto');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const { MongoClient } = require('mongodb');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: '.env' });
}

const app = express();

app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const stateCookieName = 'spotify_auth_state';
const scopes = [
  'user-top-read',
  'playlist-modify-public',
  'playlist-modify-private',
];

const mongoUri = process.env.MONGODB_URI || process.env.MONGOURI;
const mongoDbName = process.env.MONGODB_DB_NAME || 'spotifytop50DB';
const authCollectionName = process.env.MONGODB_AUTH_COLLECTION || 'auth';
const tracksCollectionName = process.env.MONGODB_TRACKS_COLLECTION || 'top_tracks';
const authDocumentId = 'spotify';
const latestTracksDocumentId = 'latest';
const spotifyApiBaseUrl = 'https://api.spotify.com/v1';
const spotifyAccountsBaseUrl = 'https://accounts.spotify.com';

let mongoClientPromise;

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
    this.statusCode = 500;
  }
}

function envValue(...names) {
  return names.map((name) => process.env[name]).find(Boolean);
}

function requiredEnv(...names) {
  const value = envValue(...names);

  if (!value) {
    throw new ConfigurationError(`Missing required environment variable. Set one of: ${names.join(', ')}`);
  }

  return value;
}

function getSpotifyClientId() {
  return requiredEnv('SPOTIFY_CLIENT_ID');
}

function getSpotifyClientSecret() {
  return requiredEnv('SPOTIFY_CLIENT_SECRET', 'SPOTIFYSECRET');
}

function getPlaylistId() {
  return requiredEnv('SPOTIFY_PLAYLIST_ID', 'PLAYLISTID');
}

function getUpdateSecret() {
  return requiredEnv('UPDATE_SECRET');
}

function getMongoClient() {
  if (!mongoUri) {
    throw new ConfigurationError('Missing required environment variable. Set one of: MONGODB_URI, MONGOURI');
  }

  if (!mongoClientPromise) {
    const client = new MongoClient(mongoUri);
    mongoClientPromise = client.connect();
  }

  return mongoClientPromise;
}

async function getDb() {
  const client = await getMongoClient();
  return client.db(mongoDbName);
}

function getRedirectUri(req) {
  if (process.env.SPOTIFY_REDIRECT_URI) {
    return process.env.SPOTIFY_REDIRECT_URI;
  }

  return `${req.protocol}://${req.get('host')}/callback`;
}

function getBasicAuthorizationHeader() {
  const credentials = `${getSpotifyClientId()}:${getSpotifyClientSecret()}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

function getRefreshTokenExpiry(authorizedAt) {
  const expiry = new Date(authorizedAt);
  expiry.setMonth(expiry.getMonth() + 6);
  return expiry;
}

function getAccessTokenExpiry(expiresInSeconds) {
  return new Date(Date.now() + expiresInSeconds * 1000);
}

function isAccessTokenFresh(authDoc) {
  if (!authDoc || !authDoc.access_token || !authDoc.expires_at) {
    return false;
  }

  return new Date(authDoc.expires_at).getTime() - Date.now() > 5 * 60 * 1000;
}

function daysUntil(date) {
  if (!date) {
    return null;
  }

  return Math.ceil((new Date(date).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function buildAuthStatus(authDoc) {
  const refreshTokenDaysRemaining = authDoc
    ? daysUntil(authDoc.refresh_token_expires_at)
    : null;

  return {
    authorized: Boolean(authDoc && authDoc.refresh_token),
    access_token_expires_at: authDoc && authDoc.expires_at,
    refresh_token_expires_at: authDoc && authDoc.refresh_token_expires_at,
    refresh_token_days_remaining: refreshTokenDaysRemaining,
    reauthorization_recommended:
      refreshTokenDaysRemaining !== null && refreshTokenDaysRemaining <= 30,
    scope: authDoc && authDoc.scope,
  };
}

function timingSafeEquals(left, right) {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireUpdateAuthorization(req) {
  const expectedSecret = getUpdateSecret();
  const authHeader = req.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const suppliedSecret = bearerToken || req.query.secret || '';

  if (!timingSafeEquals(suppliedSecret, expectedSecret)) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
}

async function getAuthCollection() {
  const db = await getDb();
  return db.collection(authCollectionName);
}

async function getTracksCollection() {
  const db = await getDb();
  return db.collection(tracksCollectionName);
}

async function readAuthDocument() {
  const collection = await getAuthCollection();
  const modernDoc = await collection.findOne({ _id: authDocumentId });

  if (modernDoc) {
    return modernDoc;
  }

  const legacyDoc = await collection.findOne({ token_type: 'Bearer' });

  if (!legacyDoc) {
    return null;
  }

  const { _id: legacyId, ...legacyAuthFields } = legacyDoc;
  const migratedDoc = {
    ...legacyAuthFields,
    expires_at: legacyDoc.expires_at || (legacyDoc.exp ? new Date(legacyDoc.exp) : null),
    migrated_from_legacy_doc_id: legacyId,
    updated_at: new Date(),
  };

  await collection.updateOne(
    { _id: authDocumentId },
    {
      $set: migratedDoc,
      $setOnInsert: { _id: authDocumentId },
    },
    { upsert: true },
  );

  return { ...migratedDoc, _id: authDocumentId };
}

async function saveAuthDocument(tokenResponse, existingAuthDoc = {}) {
  const collection = await getAuthCollection();
  const now = new Date();
  const authorizedAt = existingAuthDoc.authorized_at || now;
  const refreshToken = tokenResponse.refresh_token || existingAuthDoc.refresh_token;

  const authDoc = {
    access_token: tokenResponse.access_token,
    refresh_token: refreshToken,
    token_type: tokenResponse.token_type,
    scope: tokenResponse.scope || existingAuthDoc.scope,
    expires_in: tokenResponse.expires_in,
    expires_at: getAccessTokenExpiry(tokenResponse.expires_in),
    refresh_token_expires_at:
      existingAuthDoc.refresh_token_expires_at || getRefreshTokenExpiry(authorizedAt),
    authorized_at: authorizedAt,
    updated_at: now,
  };

  await collection.updateOne(
    { _id: authDocumentId },
    {
      $set: authDoc,
      $setOnInsert: { _id: authDocumentId },
    },
    { upsert: true },
  );

  return { ...authDoc, _id: authDocumentId };
}

async function exchangeCodeForTokens(code, redirectUri) {
  const body = new URLSearchParams({
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await axios.post(`${spotifyAccountsBaseUrl}/api/token`, body.toString(), {
    headers: {
      Authorization: getBasicAuthorizationHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  return saveAuthDocument(response.data, { authorized_at: new Date() });
}

async function refreshAccessToken(authDoc) {
  if (!authDoc || !authDoc.refresh_token) {
    const error = new Error('Spotify authorization is missing. Visit /login first.');
    error.statusCode = 428;
    throw error;
  }

  if (
    authDoc.refresh_token_expires_at
    && new Date(authDoc.refresh_token_expires_at).getTime() <= Date.now()
  ) {
    const error = new Error('Spotify refresh token expired. Visit /login to reauthorize.');
    error.statusCode = 428;
    throw error;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: authDoc.refresh_token,
  });

  const response = await axios.post(`${spotifyAccountsBaseUrl}/api/token`, body.toString(), {
    headers: {
      Authorization: getBasicAuthorizationHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  return saveAuthDocument(response.data, authDoc);
}

async function getValidAccessToken() {
  const authDoc = await readAuthDocument();

  if (isAccessTokenFresh(authDoc)) {
    return authDoc.access_token;
  }

  const refreshedAuthDoc = await refreshAccessToken(authDoc);
  return refreshedAuthDoc.access_token;
}

async function spotifyRequest(accessToken, config) {
  const response = await axios({
    baseURL: spotifyApiBaseUrl,
    ...config,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(config.headers || {}),
    },
  });

  return response.data;
}

function normalizeTrack(track, index) {
  return {
    rank: index + 1,
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: (track.artists || []).map((artist) => ({
      id: artist.id,
      name: artist.name,
      uri: artist.uri,
      external_url: artist.external_urls && artist.external_urls.spotify,
    })),
    album: track.album
      ? {
        id: track.album.id,
        name: track.album.name,
        uri: track.album.uri,
        external_url: track.album.external_urls && track.album.external_urls.spotify,
        images: track.album.images || [],
      }
      : null,
    external_url: track.external_urls && track.external_urls.spotify,
    duration_ms: track.duration_ms,
    explicit: track.explicit,
  };
}

async function fetchTopTracks(accessToken) {
  const timeRange = process.env.SPOTIFY_TOP_TRACKS_TIME_RANGE || 'short_term';
  const limit = Number(process.env.SPOTIFY_TOP_TRACKS_LIMIT || 50);

  if (!['short_term', 'medium_term', 'long_term'].includes(timeRange)) {
    throw new ConfigurationError('SPOTIFY_TOP_TRACKS_TIME_RANGE must be short_term, medium_term, or long_term');
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ConfigurationError('SPOTIFY_TOP_TRACKS_LIMIT must be an integer from 1 to 50');
  }

  const data = await spotifyRequest(accessToken, {
    method: 'get',
    url: '/me/top/tracks',
    params: {
      time_range: timeRange,
      limit,
      offset: 0,
    },
  });

  const tracks = (data.items || [])
    .filter((track) => track && track.type === 'track' && track.uri)
    .map(normalizeTrack);

  if (tracks.length === 0) {
    const error = new Error('Spotify returned zero top tracks.');
    error.statusCode = 502;
    throw error;
  }

  return {
    source: '/me/top/tracks',
    time_range: timeRange,
    requested_limit: limit,
    total: data.total,
    uris: tracks.map((track) => track.uri),
    tracks,
    updated_at: new Date(),
  };
}

async function saveTopTracks(topTracksDocument) {
  const collection = await getTracksCollection();

  await collection.updateOne(
    { _id: latestTracksDocumentId },
    {
      $set: topTracksDocument,
      $setOnInsert: { _id: latestTracksDocumentId },
    },
    { upsert: true },
  );

  return collection.findOne({ _id: latestTracksDocumentId });
}

async function replacePlaylistItems(accessToken, uris) {
  return spotifyRequest(accessToken, {
    method: 'put',
    url: `/playlists/${getPlaylistId()}/items`,
    data: {
      uris,
    },
  });
}

async function updateTopTracksPlaylist() {
  const accessToken = await getValidAccessToken();
  const topTracksDocument = await fetchTopTracks(accessToken);
  const savedTracksDocument = await saveTopTracks(topTracksDocument);
  const playlistResponse = await replacePlaylistItems(accessToken, savedTracksDocument.uris);
  const authDoc = await readAuthDocument();

  return {
    updated_at: savedTracksDocument.updated_at,
    track_count: savedTracksDocument.uris.length,
    playlist_snapshot_id: playlistResponse.snapshot_id,
    auth: buildAuthStatus(authDoc),
  };
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = getRedirectUri(req);

  res.cookie(stateCookieName, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 10 * 60 * 1000,
  });

  const authUrl = new URL(`${spotifyAccountsBaseUrl}/authorize`);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: getSpotifyClientId(),
    scope: scopes.join(' '),
    redirect_uri: redirectUri,
    state,
    show_dialog: req.query.force === 'true' ? 'true' : 'false',
  }).toString();

  res.redirect(authUrl.toString());
});

app.get('/callback', asyncRoute(async (req, res) => {
  const { code, error, state } = req.query;
  const storedState = req.cookies ? req.cookies[stateCookieName] : null;

  if (error) {
    res.status(400).send(`Spotify authorization failed: ${error}`);
    return;
  }

  if (!code || !state || !storedState || state !== storedState) {
    res.status(400).send('Spotify authorization failed: state mismatch.');
    return;
  }

  res.clearCookie(stateCookieName);
  await exchangeCodeForTokens(code, getRedirectUri(req));
  res.redirect('/?auth=success');
}));

app.post('/update', asyncRoute(async (req, res) => {
  requireUpdateAuthorization(req);
  const result = await updateTopTracksPlaylist();
  res.status(200).json({ ok: true, ...result });
}));

app.get('/update', asyncRoute(async (req, res) => {
  requireUpdateAuthorization(req);
  const result = await updateTopTracksPlaylist();
  res.status(200).json({ ok: true, ...result });
}));

app.get('/auth/status', asyncRoute(async (req, res) => {
  const authDoc = await readAuthDocument();

  res.status(200).json(buildAuthStatus(authDoc));
}));

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const statusCode = err.statusCode || (err.response && err.response.status) || 500;
  const spotifyError = err.response && err.response.data;

  console.error({
    message: err.message,
    statusCode,
    spotifyError,
  });

  res.status(statusCode).json({
    ok: false,
    error: err.message,
    spotify_error: spotifyError,
  });
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 8080;
  app.listen(port, () => {
    console.log(`Listening at http://localhost:${port}`);
  });
}
