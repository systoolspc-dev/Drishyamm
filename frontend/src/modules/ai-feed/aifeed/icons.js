import { createElement } from 'react';
import {
  Activity, Car, CarFront, Clock, Coffee, Crosshair, EyeOff, Fence, Flame, Footprints, GitBranch,
  HardHat, LogIn, LogOut, MonitorX, PackageSearch, PackageX, PersonStanding, ScanFace,
  ShieldAlert, Smartphone, Swords, UserCheck, Users, UsersRound, Wifi, WifiOff,
} from 'lucide-react';

// event-model.js names icons as strings so it stays free of React imports;
// this is the one place those names resolve to components.
const EVENT_ICONS = {
  Activity, Car, CarFront, Clock, Coffee, Crosshair, EyeOff, Fence, Flame, Footprints, GitBranch,
  HardHat, LogIn, LogOut, MonitorX, PackageSearch, PackageX, PersonStanding, ScanFace,
  ShieldAlert, Smartphone, Swords, UserCheck, Users, UsersRound, Wifi, WifiOff,
};

export function eventIcon(name) {
  return EVENT_ICONS[name] || Activity;
}

/** Render the icon for an event-model icon name. */
export function EventIcon({ name, ...props }) {
  return createElement(EVENT_ICONS[name] || Activity, props);
}
