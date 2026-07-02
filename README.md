# Spotify Top 50 Playlist

Small Express service that keeps a Spotify playlist synced to the current user's top 50 tracks.

The cron path is:

1. GitHub Actions calls `POST /update` with `Authorization: Bearer $UPDATE_SECRET`.
2. The server refreshes the Spotify access token from MongoDB when needed.
3. The server fetches `GET /me/top/tracks`.
4. The latest top tracks are stored in MongoDB.
5. The Spotify playlist is replaced from the MongoDB `latest` document.

## Current Spotify API Notes

- This app uses Spotify's Authorization Code flow with a server-side client secret.
- Required scopes are `user-top-read`, `playlist-modify-public`, and `playlist-modify-private`.
- Playlist writes use the current `PUT /v1/playlists/{playlist_id}/items` endpoint.
- Spotify refresh tokens issued to Developer Dashboard apps expire after 6 months. Reauthorize with `/login?force=true` before that date; this replaces the old pattern of manually refreshing access tokens.

## Environment

Copy `.env.example` to `.env` for local development and set the same values in your host:

- `MONGODB_URI`: MongoDB Atlas connection string.
- `MONGODB_DB_NAME`: Defaults to `spotifytop50DB`.
- `MONGODB_AUTH_COLLECTION`: Defaults to `auth`.
- `MONGODB_TRACKS_COLLECTION`: Defaults to `top_tracks`.
- `SPOTIFY_CLIENT_ID`: Spotify app client ID.
- `SPOTIFY_CLIENT_SECRET`: Spotify app client secret.
- `SPOTIFY_REDIRECT_URI`: Exact callback URL registered in Spotify, for example `https://your-app.vercel.app/callback`.
- `SPOTIFY_PLAYLIST_ID`: Destination playlist ID.
- `SPOTIFY_TOP_TRACKS_TIME_RANGE`: `short_term`, `medium_term`, or `long_term`. Defaults to `short_term`.
- `SPOTIFY_TOP_TRACKS_LIMIT`: Defaults to `50`.
- `UPDATE_SECRET`: Long random token required by `/update`.

## Local Setup

```bash
npm install
npm start
```

Open `http://localhost:8080/login` and approve the Spotify scopes. The callback stores the token document in MongoDB.

Check status:

```bash
curl http://localhost:8080/auth/status
```

Run the update route:

```bash
curl -X POST http://localhost:8080/update \
  -H "Authorization: Bearer $UPDATE_SECRET"
```

## Deployment Setup

### Spotify Developer Dashboard

1. Create or open the Spotify app in the Developer Dashboard.
2. Add the exact redirect URI, including protocol and path:
   - Local: `http://localhost:8080/callback`
   - Production: `https://your-app.vercel.app/callback`
3. Save the Client ID and Client Secret into your deployment environment.
4. Make sure the Spotify account that owns or collaborates on the destination playlist completes `/login`.
5. Calendar a reauthorization at least every 6 months because refresh tokens expire. The `/auth/status` and `/update` responses include `refresh_token_days_remaining` and `reauthorization_recommended` so this can be monitored from logs.

### GitHub Actions

Store these repository secrets:

- `UPDATE_URL`: Production update URL, for example `https://your-app.vercel.app/update`.
- `UPDATE_SECRET`: Same value configured on the deployed app.

Example workflow:

```yaml
name: Update Spotify Top 50 Playlist

on:
  schedule:
    - cron: "0 8 * * *"
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: Call update endpoint
        run: |
          curl --fail --request POST "$UPDATE_URL" \
            --header "Authorization: Bearer $UPDATE_SECRET"
        env:
          UPDATE_URL: ${{ secrets.UPDATE_URL }}
          UPDATE_SECRET: ${{ secrets.UPDATE_SECRET }}
```

## Routes

- `GET /login`: Start Spotify authorization.
- `GET /login?force=true`: Force a fresh authorization prompt.
- `GET /callback`: Spotify OAuth callback.
- `GET /auth/status`: Check token expiration metadata.
- `POST /update`: Protected cron endpoint.
- `GET /update`: Protected fallback for schedulers that cannot send `POST`.
- `GET /health`: Health check.
