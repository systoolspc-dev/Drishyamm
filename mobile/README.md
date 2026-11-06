# Drishyam Mobile

Operator app for the Drishyam VMS — dark CCTV-style UI (Hik-Connect / CP Plus
design language). React Native + Expo SDK 57, classic React Navigation
(clean file names — no router file-magic).

## Features (v1)
- **Sign in** — server address + email/password. JWT with automatic refresh
  (single-flight, rotation-safe). Tokens in Keychain/Keystore (expo-secure-store).
- **Cameras** — grouped device list, 2-column tiles, online/offline status,
  device summary strip. Tiles are static previews by design (the NVR allows
  only ~6-7 concurrent streams total — see repo CONTEXT.md §3).
- **Live View** — one camera at a time over HLS (expo-video), LIVE badge,
  play/pause · mute · Main/Sub quality · fullscreen, codec info.
- **Alarms** — AI event feed, severity-coded, 15s polling.
- **Me** — account, connection info, sign out.

## Run it
```bash
cd drishyam_app
npm install
npx expo start          # scan the QR with Expo Go (same Wi-Fi as the server)
```
On the login screen enter the **server as `<PC-LAN-IP>:5000`** (not localhost —
that would be the phone itself). Media URLs returned by the backend are
automatically re-hosted to the server IP (`src/lib/config.js`).

## Structure
```
index.js                       entry (registerRootComponent)
App.jsx                        providers + session hydration gate
src/
  theme.js                     dark CCTV theme (Drishyam orange accent)
  navigation/AppNavigator.jsx  Login ⇄ MainTabs(Cameras·Alarms·Me) + LiveView
  screens/
    LoginScreen.jsx
    CamerasScreen.jsx
    AlertsScreen.jsx
    ProfileScreen.jsx
    LiveViewScreen.jsx
  components/CameraCard.jsx
  lib/
    storage.js                 SecureStore wrapper
    config.js                  server URL normalize + media-URL host rewrite
    authStore.js               zustand session store (persisted)
    client.js                  axios + 401→refresh→retry (token rotation safe)
    api.js                     backend calls (shapes verified against source)
```

## Backend contract
Everything talks to `http(s)://<server>/api` — see
`smart-cam-backend/docs/FRONTEND_INTEGRATION.md` and repo-root `CONTEXT.md`.
Live URLs always come from `GET /api/stream/start/:monitorId`.

## Roadmap
- WebRTC (WHEP) low-latency mode for single view (`react-native-webrtc`, dev build)
- Playback (recordings list + player)
- socket.io foreground alerts → FCM push
- Multi-tile live wall (2×2, capped, sub-streams)
