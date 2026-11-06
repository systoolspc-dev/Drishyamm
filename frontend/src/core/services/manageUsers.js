import api from '@/core/services/api';

// RBAC user administration (Settings → Manage Users). Backend gates every call
// on the MANAGE_USERS capability (admins only).
export const manageUsersService = {
  list:          ()            => api.get('/manage/users').then((r) => r.data.data),
  options:       ()            => api.get('/manage/users/options').then((r) => r.data.data),
  create:        (payload)     => api.post('/manage/users', payload).then((r) => r.data.data),
  update:        (id, payload) => api.put(`/manage/users/${id}`, payload).then((r) => r.data.data),
  resetPassword: (id, password) => api.put(`/manage/users/${id}/password`, { password }).then((r) => r.data),
  remove:        (id)          => api.delete(`/manage/users/${id}`).then((r) => r.data),
};

// Custom roles — a name + the features (capabilities) assigned to it.
export const manageRolesService = {
  list:         ()            => api.get('/manage/roles').then((r) => r.data.data),
  capabilities: ()            => api.get('/manage/roles/capabilities').then((r) => r.data.data),
  create:       (payload)     => api.post('/manage/roles', payload).then((r) => r.data.data),
  update:       (id, payload) => api.put(`/manage/roles/${id}`, payload).then((r) => r.data.data),
  remove:       (id)          => api.delete(`/manage/roles/${id}`).then((r) => r.data),
};
