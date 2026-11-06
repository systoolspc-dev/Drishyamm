// Alarm feedback: BUZZ + SOUND together, so an alert lands whether the phone
// volume is up (you hear the triple beep) or down (you feel the vibration).
// iOS: playsInSilentMode lets the beep sound even with the mute switch on.
// Android: media volume at zero can't be overridden from the app — the buzz
// covers that case (true override needs FCM alarm-channel push, a later
// server-side feature). Player is created once and reused.
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as Haptics from 'expo-haptics';

let player = null;

export async function initAlertFx() {
  try {
    await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'duckOthers' });
  } catch {}
  try {
    if (!player) {
      player = createAudioPlayer(require('../../assets/sounds/alert.wav'));
      player.volume = 1;
    }
  } catch {}
}

// One alarm hit: strong buzz (threats buzz harder) + triple beep.
export function playAlertFx(threat = false) {
  try {
    Haptics.notificationAsync(threat ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Warning);
  } catch {}
  try {
    if (player) { player.seekTo(0); player.play(); }
  } catch {}
}
