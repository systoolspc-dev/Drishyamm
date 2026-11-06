// Active-alarm state (zustand). ring() starts a CONTINUOUS alarm — beep+buzz
// repeating every REPEAT_MS until someone acknowledges via silence() (the
// AlarmBanner's STOP) — so an unattended phone keeps sounding until noticed.
// A hard cap stops it after MAX_RING_MS (battery/sanity). Repeated ring()
// calls (more events while ringing) just refresh the banner + timers.
import { create } from 'zustand';
import { playAlertFx } from './alertFx';

const REPEAT_MS = 2500;          // beep is ~0.7s → urgent but not overlapping
const MAX_RING_MS = 5 * 60_000;  // give up after 5 minutes unattended

let repeatTimer = null;
let capTimer = null;
const clearTimers = () => { clearInterval(repeatTimer); clearTimeout(capTimer); repeatTimer = capTimer = null; };

export const useAlarm = create((set) => ({
  active: null, // { title, body, threat, ts }

  ring: (alarm) => {
    clearTimers();
    playAlertFx(!!alarm.threat);
    repeatTimer = setInterval(() => playAlertFx(!!alarm.threat), REPEAT_MS);
    capTimer = setTimeout(() => { clearTimers(); set({ active: null }); }, MAX_RING_MS);
    set({ active: { ...alarm, ts: Date.now() } });
  },

  silence: () => { clearTimers(); set({ active: null }); },
}));
