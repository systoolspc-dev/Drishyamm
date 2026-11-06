import { api } from '../../core/services/apiClient.js';
import { API_URL } from '@/core/config/endpoints';

// Same base the `api` client uses for /ai/weapon-detection above. The old
// VITE_API_BASE var was never defined, so this always hit localhost in prod.
const BASE = API_URL;

export const weaponDetectionService = {
  getDetections: async () => {
    try {
      return await api.get('/ai/weapon-detection');
    } catch (error) {
      console.error('Weapon Detection Service Error:', error);
      return [];
    }
  },

  getAlerts: async () => {
    try {
      return await api.get('/ai/weapon-alerts');
    } catch (error) {
      console.error('Weapon Alerts Service Error:', error);
      return [];
    }
  },

  // Send an image File/Blob to the real YOLO model and get back detections
  predict: async (imageFile, { cameraId = 'CAM-UPLOAD', location = 'Manual Upload' } = {}) => {
    const form = new FormData();
    form.append('image', imageFile);
    form.append('cameraId', cameraId);
    form.append('location', location);

    const res = await fetch(`${BASE}/ai/weapon-predict`, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json(); // { detections: [{class, confidence, bbox}], weaponsFound }
  },
};
