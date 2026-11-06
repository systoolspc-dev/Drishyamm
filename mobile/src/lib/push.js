// push.js — real OS push notifications (Expo). Complements AlertWatcher, which
// only buzzes while the app is FOREGROUND; this delivers alerts produced
// server-side (alertEngine) even when the app is backgrounded or killed.
//
// SDK 57 API (see https://docs.expo.dev/versions/v57.0.0/sdk/notifications/):
//   - handler returns { shouldPlaySound, shouldSetBadge, shouldShowBanner, shouldShowList }
//   - getExpoPushTokenAsync({ projectId }) REQUIRES an EAS projectId
//
// Push needs (a) a real build (NOT Expo Go), (b) a physical device, (c) granted
// permission, and (d) an EAS projectId in app.json (expo.extra.eas.projectId).
// Any missing piece → we log and no-op; the app keeps working, push just stays
// off until it's configured.
import { Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { navigationRef } from '../navigation/AppNavigator';
import { registerPushToken, unregisterPushToken } from './api';

// Expo Go dropped remote-push support in SDK 53, and merely IMPORTING
// expo-notifications there throws at module scope on Android — killing the
// bundle before React mounts, so the ErrorBoundary around <PushRegistrar/>
// can't catch it. Hence the require is lazy and gated: in Expo Go we never
// touch the module and push stays off; in a dev/production build it loads
// normally. To actually test push, use a development build.
let notifications; // undefined = not tried yet, null = unavailable
function getNotifications() {
  if (notifications !== undefined) return notifications;
  if (isRunningInExpoGo()) {
    console.warn('[push] Expo Go has no remote push since SDK 53 — push disabled. Use a development build.');
    notifications = null;
  } else {
    notifications = require('expo-notifications');
  }
  return notifications;
}

let handlerReady = false;

// Show the OS banner even in foreground (AlertWatcher also buzzes, but the
// banner is tappable + dismissible and mirrors the background experience).
export function initPushHandler() {
  if (handlerReady) return;
  const Notifications = getNotifications();
  if (!Notifications) return;
  handlerReady = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  // Tap a push → jump to the Alerts tab. The route is 'Alerts', not 'Alarms':
  // the tab was renamed with the Home · Live · (+) · Alerts · Menu IA, and the
  // stale name here silently threw into the catch below, so a tapped push
  // opened nothing at all.
  Notifications.addNotificationResponseReceivedListener(() => {
    try {
      if (navigationRef.isReady()) navigationRef.navigate('Main', { screen: 'Alerts' });
    } catch { /* nav not ready — ignore */ }
  });
}

function resolveProjectId() {
  return (
    Constants?.expoConfig?.extra?.eas?.projectId ||
    Constants?.easConfig?.projectId ||
    null
  );
}

/**
 * Ask permission, get the Expo push token, and register it with the backend.
 * @returns {Promise<string|null>} the Expo push token, or null if unavailable.
 */
export async function registerForPush() {
  const Notifications = getNotifications();
  if (!Notifications) return null;       // Expo Go — no native push module
  if (!Device.isDevice) return null;     // simulators/emulators can't receive push

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('alerts', {
      name: 'Security alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#F7983A',
    }).catch(() => {});
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== 'granted') {
    ({ status } = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    }));
  }
  if (status !== 'granted') return null;

  const projectId = resolveProjectId();
  if (!projectId) {
    console.warn('[push] no EAS projectId set (expo.extra.eas.projectId) — push disabled');
    return null;
  }

  let expoToken;
  try {
    const res = await Notifications.getExpoPushTokenAsync({ projectId });
    expoToken = res.data;
  } catch (e) {
    console.warn('[push] getExpoPushTokenAsync failed:', e?.message);
    return null;
  }

  try {
    await registerPushToken({
      token: expoToken,
      platform: Platform.OS,
      deviceName: Device.deviceName || Device.modelName || null,
    });
  } catch (e) {
    console.warn('[push] backend register failed:', e?.message);
  }
  return expoToken;
}

export async function unregisterForPush(expoToken) {
  if (expoToken) await unregisterPushToken(expoToken);
}
