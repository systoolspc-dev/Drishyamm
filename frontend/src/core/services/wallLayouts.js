import api from './api';

// Saved Monitor Wall layouts. Shared across the account, so every user on it
// sees and edits the same list (the backend scopes them to the account owner).
export const wallLayoutService = {
  list:   ()         => api.get('/wall-layouts').then((r) => r.data.data),
  get:    (id)       => api.get(`/wall-layouts/${id}`).then((r) => r.data.data),
  create: (body)     => api.post('/wall-layouts', body).then((r) => r.data.data),
  update: (id, body) => api.put(`/wall-layouts/${id}`, body).then((r) => r.data.data),
  remove: (id)       => api.delete(`/wall-layouts/${id}`).then((r) => r.data.data),
};
